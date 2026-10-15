// A fake N9342CN, so the plugin has something to talk to in tests and on a CI
// runner with no analyzer attached.
//
// It is fake at the USB level, not the SCPI level: `FakeUsbtmcDevice` has the
// WebUSB shape the `usb` package hands the worker, and speaks USBTMC framing
// on its bulk endpoints, so the tests run the real worker, the real USBTMC
// code and the real SCPI driver. Only the analyzer's insides are invented.
//
// The SCPI it understands is the subset driver/n9342c.js sends, in the short
// forms the programmer's guide documents — see driver/protocol.md. Things the
// guide leaves open (the trace point count, the exact *IDN? model string) are
// set to what we believe and are configurable, so a test can change them.
//
// It is also where failures that are hard to stage physically are staged:
// `unplugAfterSweeps` makes the device vanish mid-sweep, `hangAfterSweeps`
// makes a USB read that never returns — the wedge the worker exists for.

export const VENDOR_ID = 0x0957; // Agilent / Keysight
export const PRODUCT_ID = 0x2118; // N9342C/43C/44C handheld analyzers

const RBW_HZ = [10, 30, 100, 300, 1e3, 3e3, 10e3, 30e3, 100e3, 300e3, 1e6, 3e6];
const DETECTORS = ['NEG', 'POS', 'SAMP', 'AVER', 'NORMAL'];
const MIN_SPAN_HZ = 10;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sci = (v) =>
  v
    .toExponential(9)
    .toUpperCase()
    .replace(/^(?=\d)/, '+');

/** "470000000", "4.7E8", "470 MHZ", "30dB" -> a number in base units */
function parseNumber(text) {
  const m = /^\s*([-+]?[\d.]+(?:E[-+]?\d+)?)\s*([A-Z]*)\s*$/i.exec(text ?? '');
  if (!m) return NaN;
  const scale = { GHZ: 1e9, MHZ: 1e6, KHZ: 1e3, HZ: 1, MS: 1e-3, S: 1 };
  return Number(m[1]) * (scale[m[2].toUpperCase()] ?? 1);
}

const parseBool = (text) => /^(ON|1)$/i.test(text?.trim() ?? '');

// Long SCPI mnemonics folded to their short forms, and optional nodes
// dropped, so `:SENSe:FREQuency:STARt` and `FREQ:STAR` are the same header.
const SHORT = {
  SENSE: 'SENS',
  FREQUENCY: 'FREQ',
  START: 'STAR',
  BANDWIDTH: 'BAND',
  BWIDTH: 'BAND',
  BWID: 'BAND',
  VIDEO: 'VID',
  DISPLAY: 'DISP',
  WINDOW: 'WIND',
  TRACE: 'TRAC',
  TRACE1: 'TRAC1',
  RLEVEL: 'RLEV',
  POWER: 'POW',
  ATTENUATION: 'ATT',
  DETECTOR: 'DET',
  INITIATE: 'INIT',
  CONTINUOUS: 'CONT',
  FORMAT: 'FORM',
  SYSTEM: 'SYST',
  ERROR: 'ERR',
  INSTRUMENT: 'INST',
  SWEEP: 'SWE',
};
const OPTIONAL = new Set([
  'SENS',
  'RES',
  'RESOLUTION',
  'SCAL',
  'SCALE',
  'RF',
  'FUNC',
  'FUNCTION',
  'IMM',
  'IMMEDIATE',
  'NEXT',
  'SEL',
  'SELECT',
  'STAT',
  'STATE',
]);

function normalise(header) {
  const query = header.endsWith('?');
  const nodes = header
    .replace(/\?$/, '')
    .replace(/^:/, '')
    .toUpperCase()
    .split(':')
    .map((n) => SHORT[n] ?? n)
    .filter((n) => !OPTIONAL.has(n));
  // FORM[:TRAC][:DATA] and TRAC[:DATA]? — DATA is optional in both
  if (nodes[0] === 'FORM') nodes.splice(1);
  if (nodes[0] === 'TRAC' && nodes[1] === 'DATA') nodes.splice(1, 1);
  return nodes.join(':') + (query ? '?' : '');
}

/** The analyzer itself: SCPI in, SCPI out. */
export class FakeN9342C {
  constructor({
    serial = 'MY00000001',
    manufacturer = 'Keysight Technologies',
    model = 'N9342CN',
    firmware = 'A.05.10',
    maxHz = 6e9,
    points = 461,
    sweepMs = 20,
  } = {}) {
    Object.assign(this, { serial, manufacturer, model, firmware, maxHz });
    this.points = points;
    this.sweepMs = sweepMs;
    this.minHz = 0; // tunable to 0 Hz, specified from 100 kHz
    this.state = {
      startHz: 0,
      stopHz: maxHz,
      rbwHz: 3e6,
      rbwAuto: true,
      vbwHz: 3e6,
      vbwAuto: true,
      refLevelDbm: 0,
      attenDb: 10,
      attenAuto: true,
      preamp: false,
      detector: 'POS',
      continuous: true,
      traceMode: 'WRIT',
      format: 'ASC',
      unit: 'DBM',
      mode: 'SA',
    };
    this.sweeps = 0;
    this.errors = [];
    this.trace = this.#measure();
    this.busyUntil = 0;
  }

  /** One SCPI message (possibly several `;`-separated commands). */
  handle(message) {
    const replies = [];
    for (const command of message.split(';')) {
      const trimmed = command.trim();
      if (!trimmed) continue;
      const space = trimmed.search(/\s/);
      const header = space < 0 ? trimmed : trimmed.slice(0, space);
      const arg = space < 0 ? '' : trimmed.slice(space + 1).trim();
      const reply = this.#command(normalise(header), arg, header);
      if (reply !== undefined) replies.push(reply);
    }
    return replies.length ? replies.join(';') : null;
  }

  /** How long a reply to `*OPC?` takes: until the sweep in progress is done. */
  get pendingMs() {
    return Math.max(0, this.busyUntil - Date.now());
  }

  #command(h, arg, raw) {
    const s = this.state;
    const autoCouple = () => {
      const span = s.stopHz - s.startHz;
      if (s.rbwAuto) s.rbwHz = nearestUp(clamp(span / 100, 10, 3e6));
      if (s.vbwAuto) s.vbwHz = s.rbwHz;
    };
    switch (h) {
      case '*IDN?':
        return `${this.manufacturer},${this.model},${this.serial},${this.firmware}`;
      case '*CLS':
        this.errors = [];
        return;
      case '*RST':
        return;
      case '*OPC?':
        return '1';
      case 'INST':
        s.mode = arg.toUpperCase();
        return;
      case 'UNIT:POW':
        s.unit = arg.toUpperCase();
        return;
      case 'FORM':
        s.format = /^REAL/i.test(arg) ? 'REAL' : 'ASC';
        return;
      case 'TRAC1:MODE':
        s.traceMode = arg.toUpperCase().slice(0, 4);
        return;
      case 'INIT:CONT':
        s.continuous = parseBool(arg);
        return;
      case 'INIT':
        this.sweeps += 1;
        this.busyUntil = Date.now() + this.sweepMs;
        this.trace = this.#measure();
        return;
      case 'TRAC?':
        if (!/^TRAC(E)?1$/i.test(arg)) return this.#error(-224, raw);
        return this.trace.map((v) => v.toFixed(2)).join(',');
      case 'FREQ:SPAN:FULL':
        s.startHz = 0;
        s.stopHz = this.maxHz;
        autoCouple();
        return;
      case 'FREQ:STAR': {
        const v = parseNumber(arg);
        if (Number.isNaN(v)) return this.#error(-104, raw);
        s.startHz = clamp(v, this.minHz, this.maxHz - MIN_SPAN_HZ);
        if (s.stopHz < s.startHz + MIN_SPAN_HZ)
          s.stopHz = s.startHz + MIN_SPAN_HZ;
        autoCouple();
        return;
      }
      case 'FREQ:STOP': {
        const v = parseNumber(arg);
        if (Number.isNaN(v)) return this.#error(-104, raw);
        s.stopHz = clamp(v, this.minHz + MIN_SPAN_HZ, this.maxHz);
        if (s.startHz > s.stopHz - MIN_SPAN_HZ)
          s.startHz = s.stopHz - MIN_SPAN_HZ;
        autoCouple();
        return;
      }
      case 'FREQ:STAR?':
        return sci(s.startHz);
      case 'FREQ:STOP?':
        return sci(s.stopHz);
      case 'BAND':
        // the guide: "the nearest … available RBW, rounding up"
        s.rbwHz = nearestUp(clamp(parseNumber(arg), 10, 3e6));
        s.rbwAuto = false;
        if (s.vbwAuto) s.vbwHz = s.rbwHz;
        return;
      case 'BAND?':
        return sci(s.rbwHz);
      case 'BAND:AUTO':
        s.rbwAuto = parseBool(arg);
        autoCouple();
        return;
      case 'BAND:VID':
        s.vbwHz = clamp(parseNumber(arg), 1, 3e6);
        s.vbwAuto = false;
        return;
      case 'BAND:VID?':
        return sci(s.vbwHz);
      case 'BAND:VID:AUTO':
        s.vbwAuto = parseBool(arg);
        autoCouple();
        return;
      case 'DISP:WIND:TRAC:Y:RLEV':
        s.refLevelDbm = clamp(parseNumber(arg), -140, 20);
        return;
      case 'DISP:WIND:TRAC:Y:RLEV?':
        return sci(s.refLevelDbm);
      case 'POW:ATT':
        // integer dB steps, 0…50, per the guide's stated range
        s.attenDb = clamp(Math.round(parseNumber(arg)), 0, 50);
        s.attenAuto = false;
        return;
      case 'POW:ATT?':
        return sci(s.attenDb);
      case 'POW:ATT:AUTO':
        s.attenAuto = parseBool(arg);
        if (s.attenAuto) s.attenDb = 10;
        return;
      case 'POW:ATT:AUTO?':
        return s.attenAuto ? '1' : '0';
      case 'POW:GAIN':
        s.preamp = parseBool(arg);
        return;
      case 'POW:GAIN?':
        return s.preamp ? '1' : '0';
      case 'DET:TRAC1': {
        const d = arg.toUpperCase();
        const found = DETECTORS.find((name) => d.startsWith(name.slice(0, 3)));
        if (!found) return this.#error(-224, raw);
        s.detector = found;
        return;
      }
      case 'DET:TRAC1?':
        return s.detector;
      case 'SWE:TIME?':
        return sci(this.sweepMs / 1000);
      case 'SYST:ERR?': {
        const next = this.errors.shift();
        return next ?? '+0,"No error"';
      }
      default:
        return this.#error(-113, raw);
    }
  }

  #error(code, header) {
    const text = {
      '-104': 'Data type error',
      '-113': 'Undefined header',
      '-224': 'Illegal parameter value',
    }[code];
    this.errors.push(`${code},"${text}; ${header}"`);
    // a query that errors still answers nothing; the caller times out, which
    // is what a real instrument does too
    return undefined;
  }

  /**
   * A noise floor, two carriers at a third and two thirds of the span, and a
   * transient at the middle every fifth sweep — so max-hold has something to
   * hold. Attenuation lowers what reaches the "detector"; the preamp raises it.
   */
  #measure() {
    const s = this.state;
    const span = Math.max(1, s.stopHz - s.startHz);
    const gain = (s.preamp ? 20 : 0) - s.attenDb + 10;
    const transient = this.sweeps > 0 && this.sweeps % 5 === 0;
    const bump = (f, at, width, height) =>
      height *
      Math.exp(-(((f - (s.startHz + span * at)) / (span * width)) ** 2));
    const out = new Array(this.points);
    for (let i = 0; i < this.points; i += 1) {
      const f = s.startHz + (i * span) / (this.points - 1);
      let amp = -100 + (Math.random() * 4 - 2) + gain;
      amp += bump(f, 0.33, 0.01, 45) + bump(f, 0.66, 0.006, 30);
      if (transient) amp += bump(f, 0.5, 0.004, 50);
      out[i] = amp;
    }
    return out;
  }
}

const nearestUp = (hz) => RBW_HZ.find((r) => r >= hz - 1e-9) ?? RBW_HZ.at(-1);

/**
 * The analyzer as the `usb` package would hand it over: WebUSB-shaped, one
 * USBTMC interface, bulk endpoints that speak USBTMC framing.
 */
export class FakeUsbtmcDevice {
  constructor(
    instrument,
    { unplugAfterSweeps, hangAfterSweeps, maxReplyChunk = 1024 } = {}
  ) {
    this.instrument = instrument;
    this.vendorId = VENDOR_ID;
    this.productId = PRODUCT_ID;
    this.serialNumber = instrument.serial;
    this.manufacturerName = 'Keysight Technologies';
    this.productName = 'N9342C Handheld Spectrum Analyzer';
    this.opened = false;
    this.unplugAfterSweeps = unplugAfterSweeps;
    this.hangAfterSweeps = hangAfterSweeps;
    // replies longer than this are sent as several USBTMC transfers, so the
    // multi-transfer path in usbtmc.js runs on every trace
    this.maxReplyChunk = maxReplyChunk;
    this.gone = false;
    this.output = Buffer.alloc(0); // reply bytes not yet requested
    this.pendingRequest = null; // the last REQUEST_DEV_DEP_MSG_IN header
    this.configuration = {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 0,
          alternate: {
            interfaceClass: 0xfe,
            interfaceSubclass: 0x03,
            interfaceProtocol: 0x01,
            endpoints: [
              {
                endpointNumber: 2,
                direction: 'out',
                type: 'bulk',
                packetSize: 512,
              },
              {
                endpointNumber: 1,
                direction: 'in',
                type: 'bulk',
                packetSize: 512,
              },
              {
                endpointNumber: 3,
                direction: 'in',
                type: 'interrupt',
                packetSize: 8,
              },
            ],
          },
        },
      ],
    };
    this.configurations = [this.configuration];
  }

  #alive() {
    if (this.gone)
      throw new Error('LIBUSB_ERROR_NO_DEVICE: device disconnected');
  }

  async open() {
    this.#alive();
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async selectConfiguration() {}
  async claimInterface() {
    this.#alive();
  }
  async releaseInterface() {}
  async clearHalt() {
    this.#alive();
  }

  async controlTransferIn(setup) {
    this.#alive();
    if (setup.request === 5) {
      // INITIATE_CLEAR: drop anything queued
      this.output = Buffer.alloc(0);
      this.pendingRequest = null;
      return { status: 'ok', data: new DataView(Uint8Array.of(0x01).buffer) };
    }
    if (setup.request === 6) {
      return {
        status: 'ok',
        data: new DataView(Uint8Array.of(0x01, 0).buffer),
      };
    }
    return { status: 'stall' };
  }

  async transferOut(endpoint, data) {
    this.#alive();
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const msgId = bytes[0];
    if (bytes[2] !== (~bytes[1] & 0xff)) throw new Error('bad bTagInverse');
    const size = bytes.readUInt32LE(4);
    if (msgId === 1) {
      const text = bytes
        .subarray(12, 12 + size)
        .toString('latin1')
        .trim();
      const reply = this.instrument.handle(text);
      if (reply !== null) {
        this.output = Buffer.concat([this.output, Buffer.from(`${reply}\n`)]);
      }
      this.#checkUnplug();
    } else if (msgId === 2) {
      this.pendingRequest = { tag: bytes[1], maxBytes: size };
    }
    return { status: 'ok', bytesWritten: bytes.length };
  }

  async transferIn(endpoint, length, timeoutMs = 1000) {
    this.#alive();
    if (
      this.hangAfterSweeps !== undefined &&
      this.instrument.sweeps > this.hangAfterSweeps
    ) {
      // a wedged native call: no timeout, no error, nothing
      return new Promise(() => {});
    }
    const request = this.pendingRequest;
    if (!request || this.output.length === 0) {
      // the device NAKs until there is something to send
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      throw new Error('LIBUSB_ERROR_TIMEOUT');
    }
    // *OPC? answers when the sweep is done, not before
    const wait = this.instrument.pendingMs;
    if (wait > 0) {
      if (wait > timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        throw new Error('LIBUSB_ERROR_TIMEOUT');
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.pendingRequest = null;
    const take = Math.min(
      this.output.length,
      request.maxBytes,
      this.maxReplyChunk
    );
    const body = this.output.subarray(0, take);
    this.output = this.output.subarray(take);
    const header = Buffer.alloc(12);
    header[0] = 2;
    header[1] = request.tag;
    header[2] = ~request.tag & 0xff;
    header.writeUInt32LE(body.length, 4);
    header[8] = this.output.length === 0 ? 0x01 : 0x00; // EOM on the last part
    const pad = Buffer.alloc((4 - (body.length % 4)) % 4);
    const all = Buffer.concat([header, body, pad]).subarray(0, length);
    return {
      status: 'ok',
      data: new DataView(all.buffer, all.byteOffset, all.byteLength),
    };
  }

  #checkUnplug() {
    if (
      this.unplugAfterSweeps !== undefined &&
      this.instrument.sweeps > this.unplugAfterSweeps
    ) {
      this.gone = true;
      this.usb?.dispatchDisconnect(this);
    }
  }
}

/**
 * Stands in for the `usb` package's `usb` object: getDevices() plus the
 * connect/disconnect events the worker listens to.
 *
 * `specs` is a list of `{ serial, model?, points?, unplugAfterSweeps?,
 * hangAfterSweeps?, … }` — the JSON the worker reads from
 * SOUNDBASE_N9342C_FAKE.
 */
export function createFakeUsb(specs = [{}]) {
  const listeners = new Set();
  const devices = specs.map((spec, i) => {
    const device = new FakeUsbtmcDevice(
      new FakeN9342C({
        serial: `MY${String(i + 1).padStart(8, '0')}`,
        ...spec,
      }),
      spec
    );
    return device;
  });
  const usb = {
    async getDevices() {
      return devices.filter((d) => !d.gone);
    },
    addEventListener(type, listener) {
      if (type === 'disconnect') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.delete(listener);
    },
    dispatchDisconnect(device) {
      for (const listener of listeners) listener({ device });
    },
  };
  for (const device of devices) device.usb = usb;
  return usb;
}
