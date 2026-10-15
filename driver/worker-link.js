// The plugin's end of driver/worker/usbtmc-worker.js: spawn it, talk JSON
// lines to it, and kill it when it stops answering.
//
// Every request has a deadline. A request that misses it means the worker is
// stuck inside a USB call that will not return, so the worker is SIGKILLed —
// there is no gentler way to interrupt a native call — and everything in
// flight is rejected. `onFatal` then tells the adapter, which tells the shell,
// and the device shows as failed instead of sweeping nothing while healthy.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const WORKER_PATH = fileURLToPath(
  new URL('./worker/usbtmc-worker.js', import.meta.url)
);
// added to every caller's own timeout: the worker's IPC hop, plus the time
// the worker needs to notice its own USB timeout and report it
const GRACE_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 5_000;
const STDERR_LINES_KEPT = 10;

export class WorkerLink {
  #child = null;
  #nextId = 1;
  #pending = new Map();
  #stderr = [];
  #closing = false;

  constructor({ background = false } = {}) {
    // a background link (discovery) must not keep the plugin process alive
    this.background = background;
    /** called once when the worker dies or is killed unprompted */
    this.onFatal = null;
    /** called with unsolicited worker events, e.g. { event: 'disconnected' } */
    this.onEvent = null;
  }

  get running() {
    return this.#child !== null;
  }

  start() {
    if (this.#child) return;
    this.#closing = false;
    // process.execPath, not "node": SoundBase may run plugins on its own
    // runtime, and the environment that makes that work is inherited
    const child = spawn(process.execPath, [WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    });
    this.#child = child;

    createInterface({ input: child.stdout }).on('line', (line) =>
      this.#receive(line)
    );
    createInterface({ input: child.stderr }).on('line', (line) => {
      this.#stderr.push(line);
      if (this.#stderr.length > STDERR_LINES_KEPT) this.#stderr.shift();
    });
    child.stdin.on('error', () => {}); // EPIPE after a kill; exit reports it
    child.once('error', (err) => this.#died(err));
    child.once('exit', (code, signal) => {
      const how = signal
        ? `was killed (${signal})`
        : `exited with code ${code}`;
      const detail = this.#stderr.length ? `: ${this.#stderr.at(-1)}` : '';
      this.#died(new Error(`the USB worker ${how}${detail}`));
    });

    // The worker never keeps the plugin process alive by itself: the plugin's
    // lifetime is its HTTP server's, and an in-flight call holds its own
    // timer. When the plugin exits, the worker sees stdin end and follows.
    this.#unref();
  }

  #unref() {
    const child = this.#child;
    child.unref();
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
  }

  #receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not ours; a native library printing to stdout
    }
    if (message.event) {
      this.onEvent?.(message);
      return;
    }
    const waiter = this.#pending.get(message.id);
    if (!waiter) return;
    this.#pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok) {
      waiter.resolve(message.result);
    } else {
      const err = new Error(message.error?.message ?? 'USB worker error');
      err.code = message.error?.code;
      waiter.reject(err);
    }
  }

  #died(err) {
    if (!this.#child) return;
    this.#child = null;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.#pending.clear();
    if (!this.#closing) this.onFatal?.(err);
  }

  /** Send one request; resolve with its result. */
  call(op, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.#child) this.start();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const err = new Error(
          `the analyzer did not answer "${describe(op, args)}" within ${Math.round(
            (timeoutMs + GRACE_MS) / 1000
          )}s; the USB connection has been reset`
        );
        reject(err);
        // the worker is stuck in a call it cannot leave; end it
        this.#kill(err);
      }, timeoutMs + GRACE_MS);
      if (this.background) timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(
        `${JSON.stringify({ id, op, ...args, timeoutMs })}\n`
      );
    });
  }

  #kill(reason) {
    const child = this.#child;
    if (!child) return;
    child.kill('SIGKILL');
    this.#died(reason);
  }

  /** Ask the worker to release the device, then make sure it is gone. */
  async close() {
    const child = this.#child;
    if (!child) return;
    this.#closing = true;
    try {
      await this.call('close', {}, 1_000);
    } catch {
      // a stuck worker cannot close; it is killed below either way
    }
    if (this.#child === child) {
      child.stdin.end();
      const exited = new Promise((resolve) => child.once('exit', resolve));
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_500);
      await exited;
      clearTimeout(timer);
    }
    this.#child = null;
  }
}

const describe = (op, args) => (args.data ? args.data : op);
