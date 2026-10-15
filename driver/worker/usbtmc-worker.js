// The child process that owns the USB side of things.
//
// Everything that touches the native `usb` addon happens here, never in the
// plugin process. A USB call that wedges — a cable pulled mid-transfer, an
// analyzer whose firmware stops answering — wedges this process, and the
// driver SIGKILLs it and reports a clean device error; the plugin itself, and
// every other device, carry on. A native addon that fails to load fails here
// too, as an error on one request, rather than as a plugin that never
// handshakes. See docs/native-runtimes.md.
//
// Protocol: JSON lines over stdio. One request per line in, one response per
// line out, matched by `id`; requests run strictly one at a time, because
// USBTMC has no notion of interleaving. Unsolicited lines carry `event`.
//
//   {"id":1,"op":"list"}                          → [{ serial, … }]
//   {"id":2,"op":"open","serial":"MY12345678"}    → { serial }   (null = first)
//   {"id":3,"op":"write","data":"*CLS"}
//   {"id":4,"op":"query","data":"*IDN?","timeoutMs":5000} → "Agilent…"
//   {"id":5,"op":"close"}
//   ← {"event":"disconnected","serial":"MY12345678"}
//
// Drive it by hand to see exactly what an analyzer does:
//
//   printf '%s\n' '{"id":1,"op":"list"}' '{"id":2,"op":"open"}' \
//     '{"id":3,"op":"query","data":"*IDN?"}' | node driver/worker/usbtmc-worker.js
//
// With SOUNDBASE_N9342C_FAKE set to a JSON list of fake analyzers (see
// driver/fake-n9342c.js), it serves those instead of real hardware.

import { createInterface } from 'node:readline';
import { UsbtmcSession, findUsbtmcInterface } from '../usbtmc.js';

// Agilent/Keysight, and the product id the N9342C/43C/44C programmer's guide
// gives in its VISA address: USB0::2391::8472::<serial>::0::INSTR
const VENDOR_ID = 0x0957;
const PRODUCT_IDS = new Set([0x2118]);

let usbPromise = null;
let session = null;
let openSerial = null;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function loadUsb() {
  usbPromise ??= (async () => {
    const fake = process.env.SOUNDBASE_N9342C_FAKE;
    if (fake) {
      const { createFakeUsb } = await import('../fake-n9342c.js');
      return createFakeUsb(JSON.parse(fake));
    }
    try {
      const { usb } = await import('usb');
      return usb;
    } catch (err) {
      const e = new Error(
        `the USB library could not be loaded on ${process.platform}-${process.arch}: ${err.message}`
      );
      e.code = 'usb_unavailable';
      throw e;
    }
  })();
  return usbPromise;
}

const isAnalyzer = (device) =>
  device.vendorId === VENDOR_ID &&
  PRODUCT_IDS.has(device.productId) &&
  findUsbtmcInterface(device) !== null;

async function list() {
  const usb = await loadUsb();
  const devices = await usb.getDevices();
  return devices.filter(isAnalyzer).map((device) => ({
    serial: device.serialNumber ?? null,
    product: device.productName ?? null,
    manufacturer: device.manufacturerName ?? null,
    vendorId: device.vendorId,
    productId: device.productId,
    bus: device.bus ?? null,
    address: device.address ?? null,
  }));
}

async function open({ serial }) {
  if (session) throw new Error('already open');
  const usb = await loadUsb();
  const candidates = (await usb.getDevices()).filter(isAnalyzer);
  const device = serial
    ? candidates.find((d) => d.serialNumber === serial)
    : candidates[0];
  if (!device) {
    const e = new Error(
      serial
        ? `no N9342CN with serial ${serial} is connected over USB`
        : 'no N9342CN is connected over USB'
    );
    e.code = 'not_found';
    throw e;
  }
  const next = new UsbtmcSession(device);
  try {
    await next.open();
  } catch (err) {
    await next.close();
    const e = new Error(explainOpenFailure(err));
    e.code = 'open_failed';
    throw e;
  }
  session = next;
  openSerial = device.serialNumber ?? null;
  usb.addEventListener?.('disconnect', (event) => {
    if (event.device === device || event.device?.serialNumber === openSerial) {
      send({ event: 'disconnected', serial: openSerial });
    }
  });
  return { serial: openSerial };
}

// The two failures a user can do something about, in words they can act on.
function explainOpenFailure(err) {
  const message = String(err?.message ?? err);
  if (
    process.platform === 'win32' &&
    /NOT_SUPPORTED|not supported/i.test(message)
  ) {
    return (
      'Windows has not given this analyzer a WinUSB driver, so the plugin cannot open it ' +
      '(usually because Keysight IO Libraries or NI-VISA owns it). ' +
      `Underlying error: ${message}`
    );
  }
  if (/ACCESS|busy|exclusive/i.test(message)) {
    return (
      'Another program has the analyzer open — close any VISA tool, Keysight Connection ' +
      `Expert or vendor software using it, then try again. Underlying error: ${message}`
    );
  }
  return message;
}

function requireSession() {
  if (!session) throw new Error('not open');
  return session;
}

const ops = {
  list,
  open,
  write: ({ data, timeoutMs }) => requireSession().write(data, timeoutMs),
  query: ({ data, timeoutMs }) => requireSession().query(data, timeoutMs),
  async close() {
    await session?.close();
    session = null;
    openSerial = null;
  },
};

// one request at a time, in arrival order
let queue = Promise.resolve();

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, ok: false, error: { message: 'request is not JSON' } });
    return;
  }
  queue = queue.then(async () => {
    const op = ops[request.op];
    if (!op) {
      send({
        id: request.id,
        ok: false,
        error: { message: `unknown op ${request.op}` },
      });
      return;
    }
    try {
      const result = await op(request);
      send({ id: request.id, ok: true, result: result ?? null });
    } catch (err) {
      send({
        id: request.id,
        ok: false,
        error: { message: String(err?.message ?? err), code: err?.code },
      });
    }
  });
});

// The plugin went away (or closed our stdin on purpose): release the device so
// the next process to want it can claim it, then go.
process.stdin.on('end', async () => {
  // a wedged call never settles the queue; do not wait on it forever
  setTimeout(() => process.exit(0), 2_000);
  await queue.catch(() => {});
  await session?.close();
  process.exit(0);
});
