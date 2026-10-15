// USBTMC — the USB Test & Measurement Class, rev 1.0 — over a WebUSB-shaped
// device: the `usb` package's devices in production, the fake beside this file
// in tests.
//
// USBTMC is what VISA's `USB0::…::INSTR` resources speak. It is a thin framing
// layer over two bulk endpoints: every message out carries a 12-byte header,
// and every reply has to be asked for with a header of its own before the
// device will send it. Nothing here knows about SCPI or about SoundBase.

export const USBTMC_CLASS = 0xfe;
export const USBTMC_SUBCLASS = 0x03;

const HEADER_BYTES = 12;
const DEV_DEP_MSG_OUT = 1;
const REQUEST_DEV_DEP_MSG_IN = 2;
const DEV_DEP_MSG_IN = 2;

// class-specific control requests (USBTMC 1.0, table 15)
const INITIATE_CLEAR = 5;
const CHECK_CLEAR_STATUS = 6;
const STATUS_SUCCESS = 0x01;
const STATUS_PENDING = 0x02;

// how much one REQUEST_DEV_DEP_MSG_IN asks for; longer replies take several
const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Bytes of padding that bring `n` up to a multiple of four. */
const padTo4 = (n) => (4 - (n % 4)) % 4;

/** The USBTMC interface and its bulk endpoints, or null if the device has none. */
export function findUsbtmcInterface(device) {
  const configurations = device.configurations?.length
    ? device.configurations
    : [device.configuration].filter(Boolean);
  for (const configuration of configurations) {
    for (const iface of configuration.interfaces ?? []) {
      const alternates = iface.alternates?.length
        ? iface.alternates
        : [iface.alternate].filter(Boolean);
      for (const alt of alternates) {
        if (
          alt.interfaceClass !== USBTMC_CLASS ||
          alt.interfaceSubclass !== USBTMC_SUBCLASS
        )
          continue;
        const bulk = (direction) =>
          alt.endpoints.find(
            (e) => e.type === 'bulk' && e.direction === direction
          );
        const bulkOut = bulk('out');
        const bulkIn = bulk('in');
        if (!bulkOut || !bulkIn) continue;
        return {
          configurationValue: configuration.configurationValue,
          interfaceNumber: iface.interfaceNumber,
          bulkOut: bulkOut.endpointNumber,
          bulkIn: bulkIn.endpointNumber,
          packetSize: bulkIn.packetSize || 512,
        };
      }
    }
  }
  return null;
}

/** A DEV_DEP_MSG_OUT transfer: header, the message, padding to 4 bytes. */
export function encodeMessageOut(tag, payload) {
  const out = new Uint8Array(
    HEADER_BYTES + payload.length + padTo4(payload.length)
  );
  const view = new DataView(out.buffer);
  out[0] = DEV_DEP_MSG_OUT;
  out[1] = tag;
  out[2] = ~tag & 0xff;
  view.setUint32(4, payload.length, true);
  out[8] = 0x01; // EOM: the whole message is in this transfer
  out.set(payload, HEADER_BYTES);
  return out;
}

/** A REQUEST_DEV_DEP_MSG_IN transfer: "send me up to `maxBytes` of reply". */
export function encodeRequestIn(tag, maxBytes) {
  const out = new Uint8Array(HEADER_BYTES);
  const view = new DataView(out.buffer);
  out[0] = REQUEST_DEV_DEP_MSG_IN;
  out[1] = tag;
  out[2] = ~tag & 0xff;
  view.setUint32(4, maxBytes, true);
  // byte 8: no TermChar — SCPI replies end where the device says they end
  return out;
}

/** Parse the header of a DEV_DEP_MSG_IN transfer. */
export function decodeMessageInHeader(bytes, expectedTag) {
  if (bytes.length < HEADER_BYTES) {
    throw new Error(`USBTMC reply too short (${bytes.length} bytes)`);
  }
  if (bytes[0] !== DEV_DEP_MSG_IN) {
    throw new Error(`USBTMC reply has MsgID ${bytes[0]}, expected 2`);
  }
  if (bytes[1] !== expectedTag || bytes[2] !== (~expectedTag & 0xff)) {
    throw new Error(
      `USBTMC reply tag ${bytes[1]} does not match request tag ${expectedTag}`
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    transferSize: view.getUint32(4, true),
    eom: (bytes[8] & 0x01) === 0x01,
  };
}

const toBytes = (dataView) =>
  dataView
    ? new Uint8Array(
        dataView.buffer,
        dataView.byteOffset,
        dataView.byteLength
      ).slice()
    : new Uint8Array(0);

/**
 * One open USBTMC instrument. Strictly one exchange at a time — the class has
 * no notion of interleaved requests — so callers serialise; the worker does.
 */
export class UsbtmcSession {
  #device;
  #iface = null;
  #tag = 0;

  constructor(device) {
    this.#device = device;
  }

  get device() {
    return this.#device;
  }

  async open() {
    const device = this.#device;
    const iface = findUsbtmcInterface(device);
    if (!iface) {
      throw new Error(
        'the device has no USBTMC interface (class 0xFE, subclass 0x03)'
      );
    }
    if (!device.opened) await device.open();
    if (device.configuration?.configurationValue !== iface.configurationValue) {
      await device.selectConfiguration(iface.configurationValue);
    }
    await device.claimInterface(iface.interfaceNumber);
    this.#iface = iface;
    // what VISA's viClear does, and what the programmer's guide does first: a
    // previous session that died mid-reply leaves bytes the next read would
    // otherwise mistake for its own answer
    await this.clear().catch(() => {});
  }

  /** INITIATE_CLEAR, wait for it, then clear the bulk-out halt. */
  async clear(timeoutMs = 2_000) {
    const { interfaceNumber, bulkOut } = this.#iface;
    const setup = (request) => ({
      requestType: 'class',
      recipient: 'interface',
      request,
      value: 0,
      index: interfaceNumber,
    });
    const started = await this.#device.controlTransferIn(
      setup(INITIATE_CLEAR),
      1,
      timeoutMs
    );
    if (started.data?.getUint8(0) !== STATUS_SUCCESS) return;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const check = await this.#device.controlTransferIn(
        setup(CHECK_CLEAR_STATUS),
        2,
        timeoutMs
      );
      if (check.data?.getUint8(0) !== STATUS_PENDING) break;
      if (Date.now() > deadline) throw new Error('USBTMC clear did not finish');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await this.#device.clearHalt('out', bulkOut);
  }

  #nextTag() {
    this.#tag = (this.#tag % 255) + 1; // 1…255; zero is not a valid bTag
    return this.#tag;
  }

  #require() {
    if (!this.#iface) throw new Error('USBTMC session is not open');
    return this.#iface;
  }

  async write(text, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const { bulkOut } = this.#require();
    const payload = new TextEncoder().encode(
      text.endsWith('\n') ? text : `${text}\n`
    );
    const result = await this.#device.transferOut(
      bulkOut,
      encodeMessageOut(this.#nextTag(), payload),
      timeoutMs
    );
    if (result.status !== 'ok') {
      throw new Error(`USB write stalled (${result.status})`);
    }
  }

  /** Read one complete reply, however many transfers it takes. */
  async read(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const { bulkIn, bulkOut, packetSize } = this.#require();
    const chunks = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = Math.max(1, deadline - Date.now());
      const tag = this.#nextTag();
      const asked = await this.#device.transferOut(
        bulkOut,
        encodeRequestIn(tag, READ_CHUNK_BYTES),
        remaining
      );
      if (asked.status !== 'ok') {
        throw new Error(`USB read request stalled (${asked.status})`);
      }

      // Ask for a whole number of packets: a short packet ends the transfer,
      // and asking for less than a packet risks a babble error.
      const want = HEADER_BYTES + READ_CHUNK_BYTES + 3;
      const length = Math.ceil(want / packetSize) * packetSize;
      let received = await this.#transferIn(bulkIn, length, deadline);
      const { transferSize, eom } = decodeMessageInHeader(received, tag);
      // a device may split one reply across several bulk transfers
      while (received.length < HEADER_BYTES + transferSize) {
        const more = await this.#transferIn(bulkIn, length, deadline);
        if (more.length === 0) break;
        const joined = new Uint8Array(received.length + more.length);
        joined.set(received);
        joined.set(more, received.length);
        received = joined;
      }
      chunks.push(received.subarray(HEADER_BYTES, HEADER_BYTES + transferSize));
      if (eom) break;
      if (Date.now() > deadline) {
        throw new Error(`USB reply incomplete after ${timeoutMs}ms`);
      }
    }
    return Buffer.concat(chunks).toString('latin1');
  }

  async #transferIn(endpoint, length, deadline) {
    const result = await this.#device.transferIn(
      endpoint,
      length,
      Math.max(1, deadline - Date.now())
    );
    if (result.status !== 'ok') {
      throw new Error(`USB read stalled (${result.status})`);
    }
    return toBytes(result.data);
  }

  /** Write a query and return its reply, trailing newline removed. */
  async query(text, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.write(text, timeoutMs);
    return (await this.read(timeoutMs)).replace(/\r?\n$/, '');
  }

  async close() {
    const iface = this.#iface;
    this.#iface = null;
    try {
      if (iface) await this.#device.releaseInterface(iface.interfaceNumber);
    } catch {
      // the device may already be gone; closing is best effort
    }
    try {
      if (this.#device.opened) await this.#device.close();
    } catch {
      // as above
    }
  }
}
