// The N9342CN's SCPI, spoken through the USB worker.
//
// Command syntax is from Keysight's "N9342C/43C/44C Handheld Spectrum Analyzer
// Programmer's Guide" (N9342-90066, firmware A.04.20 and later), which covers
// the N9342CN: it is the 6 GHz model of the same instrument and runs the same
// firmware. driver/protocol.md lists every command used, where in the guide
// it comes from, and what the guide leaves unsaid.
//
// Nothing here knows about SoundBase; adapter.js maps this onto the contract.

import { WorkerLink } from './worker-link.js';

/** Resolution bandwidths, 10 Hz – 3 MHz in 1-3-10 steps. */
export const RBW_HZ = [
  10, 30, 100, 300, 1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000,
  3_000_000,
];
export const MIN_RBW_HZ = RBW_HZ[0];
export const MAX_RBW_HZ = RBW_HZ.at(-1);
export const MIN_VBW_HZ = 1;
export const MAX_VBW_HZ = 3_000_000;
export const MIN_REF_LEVEL_DBM = -140;
export const MAX_REF_LEVEL_DBM = 20;
export const MAX_ATTEN_DB = 50;
export const DETECTORS = {
  positive: 'POS',
  sample: 'SAMP',
  average: 'AVER',
  negative: 'NEG',
  normal: 'NORMAL',
};

// Specified ranges by model, for when the unit will not tell us its own.
const MODEL_RANGES = {
  N9342CN: { minHz: 100_000, maxHz: 6_000_000_000 },
  N9342C: { minHz: 100_000, maxHz: 7_000_000_000 },
  N9343C: { minHz: 1_000_000, maxHz: 13_600_000_000 },
  N9344C: { minHz: 1_000_000, maxHz: 20_000_000_000 },
};

const QUERY_TIMEOUT_MS = 5_000;
// a sweep can take far longer than a query: allow twice the analyzer's own
// sweep-time estimate, and never less than this
const MIN_SWEEP_TIMEOUT_MS = 5_000;

const num = (reply) => {
  const value = Number(String(reply).trim());
  if (!Number.isFinite(value))
    throw new Error(`expected a number, got "${reply}"`);
  return value;
};
const bool = (reply) => /^\s*(1|ON)\s*$/i.test(String(reply));

export class N9342C {
  #link;

  /** `serial` null means the first analyzer the worker finds. */
  constructor({ serial = null } = {}) {
    this.serial = serial;
    this.#link = new WorkerLink();
    this.#link.onFatal = (err) => this.onFatal?.(err);
    this.#link.onEvent = (event) => {
      if (event.event === 'disconnected') {
        this.onFatal?.(
          new Error(
            `the analyzer${event.serial ? ` ${event.serial}` : ''} was unplugged`
          )
        );
      }
    };
    /** set by the adapter; called when the transport dies unprompted */
    this.onFatal = null;
    this.identity = null;
    this.range = null;
    this.sweepTimeoutMs = MIN_SWEEP_TIMEOUT_MS;
  }

  write(command, timeoutMs = QUERY_TIMEOUT_MS) {
    return this.#link.call('write', { data: command }, timeoutMs);
  }

  query(command, timeoutMs = QUERY_TIMEOUT_MS) {
    return this.#link.call('query', { data: command }, timeoutMs);
  }

  /**
   * Claim the analyzer and put it in a known state: spectrum-analyzer mode,
   * dBm, ASCII traces, a clear-write trace 1, and single sweeps that we
   * trigger — so every trace we read is one complete, fresh sweep.
   */
  async connect() {
    const { serial } = await this.#link.call('open', { serial: this.serial });
    this.serial = serial ?? this.serial;
    await this.write('*CLS');
    this.identity = parseIdn(await this.query('*IDN?'));
    await this.write(':INST SA');
    await this.write(':UNIT:POW DBM');
    await this.write(':FORM ASC');
    await this.write(':TRAC1:MODE WRIT');
    await this.write(':INIT:CONT 0');
    this.range = await this.#measureRange();
    return this.identity;
  }

  /**
   * The tuning range of *this* unit. FREQ:SPAN:FULL sets the widest span the
   * analyzer has, so its stop frequency is the unit's own maximum; the start
   * reads back as 0 Hz (it tunes there) but is specified only from 100 kHz,
   * so the specified minimum is used. Falls back to the model's datasheet
   * range if the analyzer does not cooperate.
   */
  async #measureRange() {
    const fallback =
      MODEL_RANGES[this.identity?.model?.toUpperCase()] ?? MODEL_RANGES.N9342CN;
    try {
      await this.write(':FREQ:SPAN:FULL');
      const maxHz = num(await this.query(':FREQ:STOP?'));
      if (maxHz >= 1e9 && maxHz <= 30e9)
        return { minHz: fallback.minHz, maxHz };
    } catch {
      // fall through to the datasheet
    }
    return { ...fallback };
  }

  /** Retune. Clamped to the unit's range; returns what the analyzer settled on. */
  async setRange(startHz, stopHz) {
    const { minHz, maxHz } = this.range;
    const start = Math.round(clamp(startHz, minHz, maxHz - 10));
    const stop = Math.round(clamp(stopHz, start + 10, maxHz));
    // an analyzer will not let start pass stop, so move whichever edge keeps
    // the span valid at every step
    const currentStop = num(await this.query(':FREQ:STOP?'));
    if (start >= currentStop) {
      await this.write(`:FREQ:STOP ${stop}`);
      await this.write(`:FREQ:STAR ${start}`);
    } else {
      await this.write(`:FREQ:STAR ${start}`);
      await this.write(`:FREQ:STOP ${stop}`);
    }
    return {
      startHz: num(await this.query(':FREQ:STAR?')),
      stopHz: num(await this.query(':FREQ:STOP?')),
    };
  }

  /** A number in Hz, or null for the analyzer's automatic choice. */
  async setRbw(hz) {
    if (hz === null) await this.write(':BAND:AUTO ON');
    else
      await this.write(
        `:BAND ${Math.round(clamp(hz, MIN_RBW_HZ, MAX_RBW_HZ))}`
      );
    return num(await this.query(':BAND?'));
  }

  async rbw() {
    return num(await this.query(':BAND?'));
  }

  /** A number in Hz, or null for the analyzer's automatic choice. */
  async setVbw(hz) {
    if (hz === null) await this.write(':BAND:VID:AUTO ON');
    else
      await this.write(
        `:BAND:VID ${Math.round(clamp(hz, MIN_VBW_HZ, MAX_VBW_HZ))}`
      );
    return num(await this.query(':BAND:VID?'));
  }

  async setRefLevel(dbm) {
    const value = clamp(dbm, MIN_REF_LEVEL_DBM, MAX_REF_LEVEL_DBM);
    await this.write(`:DISP:WIND:TRAC:Y:RLEV ${value}`);
    return num(await this.query(':DISP:WIND:TRAC:Y:RLEV?'));
  }

  /** A number in dB, or null for automatic. Returns { auto, db }. */
  async setAttenuation(db) {
    if (db === null) {
      await this.write(':POW:ATT:AUTO ON');
    } else {
      await this.write(`:POW:ATT ${Math.round(clamp(db, 0, MAX_ATTEN_DB))}`);
    }
    return {
      auto: bool(await this.query(':POW:ATT:AUTO?')),
      db: num(await this.query(':POW:ATT?')),
    };
  }

  async setPreamp(on) {
    await this.write(`:POW:GAIN ${on ? 'ON' : 'OFF'}`);
    return bool(await this.query(':POW:GAIN?'));
  }

  /** One of the DETECTORS keys. Returns the key the analyzer reports. */
  async setDetector(name) {
    const scpi = DETECTORS[name] ?? DETECTORS.positive;
    await this.write(`:DET:TRAC1 ${scpi}`);
    const reply = String(await this.query(':DET:TRAC1?'))
      .trim()
      .toUpperCase();
    return (
      Object.keys(DETECTORS).find((key) =>
        reply.startsWith(DETECTORS[key].slice(0, 3))
      ) ?? name
    );
  }

  /**
   * How long one sweep takes at the current settings, in ms, as the analyzer
   * estimates it. Also sets how long a sweep may take before the link gives up.
   */
  async sweepTimeMs() {
    const ms = num(await this.query(':SWE:TIME?')) * 1000;
    this.sweepTimeoutMs = Math.max(MIN_SWEEP_TIMEOUT_MS, Math.ceil(ms * 2));
    return ms;
  }

  /** The trace as displayed now, without sweeping. Used to learn its length. */
  async readTrace() {
    return parseTrace(await this.query(':TRAC:DATA? TRACE1', QUERY_TIMEOUT_MS));
  }

  /** Take one sweep and return it: dBm, start to stop. */
  async sweep() {
    await this.write(':INIT');
    // *OPC? answers only once the sweep it follows has finished
    await this.query('*OPC?', this.sweepTimeoutMs);
    return this.readTrace();
  }

  /** Errors the analyzer has queued since the last call, oldest first. */
  async drainErrors(max = 10) {
    const errors = [];
    for (let i = 0; i < max; i += 1) {
      const reply = String(await this.query(':SYST:ERR?')).trim();
      if (/^[+-]?0\s*,/.test(reply) || reply === '') break;
      errors.push(reply);
    }
    return errors;
  }

  async close() {
    this.onFatal = null; // a close we asked for is not a fatal error
    try {
      // hand the front panel back sweeping, as the user left it
      await this.write(':INIT:CONT 1', 1_000);
    } catch {
      // already gone
    }
    await this.#link.close();
  }
}

// Discovery keeps one worker for listing, separate from any device's worker,
// and lets it go when discovery stops asking: the shell only polls while
// SoundBase is enumerating, and an idle plugin should hold nothing open.
const DISCOVERY_IDLE_MS = 10_000;
let discoveryLink = null;
let discoveryIdle = null;

/**
 * Analyzers on USB right now, from their USB descriptors alone — nothing is
 * opened, so this is safe beside a device that is already sweeping.
 */
export async function listAnalyzers() {
  discoveryLink ??= new WorkerLink({ background: true });
  const link = discoveryLink;
  clearTimeout(discoveryIdle);
  discoveryIdle = setTimeout(() => {
    if (discoveryLink === link) discoveryLink = null;
    link.close();
  }, DISCOVERY_IDLE_MS);
  discoveryIdle.unref();
  try {
    return await link.call('list', {}, 3_000);
  } catch (err) {
    if (discoveryLink === link) discoveryLink = null;
    link.close();
    throw err;
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** "Agilent Technologies,N9342C,MY12345678,A.04.20" */
export function parseIdn(reply) {
  const [manufacturer = '', model = '', serial = '', firmware = ''] = String(
    reply
  )
    .split(',')
    .map((field) => field.trim());
  return { manufacturer, model, serial, firmware };
}

/**
 * The ASCII trace format: comma-separated amplitudes. Tolerates an IEEE 488.2
 * definite-length block header ("#3123…") in case a firmware wraps it in one.
 */
export function parseTrace(reply) {
  let text = String(reply).trim();
  const block = /^#(\d)/.exec(text);
  if (block) text = text.slice(2 + Number(block[1]));
  const values = text.split(',').map((v) => Number(v));
  if (values.length < 2 || values.some((v) => !Number.isFinite(v))) {
    throw new Error(
      `the analyzer returned a trace that is not a list of numbers: "${text.slice(0, 60)}…"`
    );
  }
  return values;
}
