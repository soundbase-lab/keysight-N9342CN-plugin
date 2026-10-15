// USBTMC framing, in-process against the fake analyzer's USB side — the layer
// most likely to be subtly wrong and least visible from the contract tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UsbtmcSession,
  decodeMessageInHeader,
  encodeMessageOut,
  encodeRequestIn,
} from '../driver/usbtmc.js';
import { FakeN9342C, FakeUsbtmcDevice } from '../driver/fake-n9342c.js';
import { parseIdn, parseTrace } from '../driver/n9342c.js';

test('a message out is a 12-byte header, the message, and padding to 4', () => {
  const out = encodeMessageOut(7, new TextEncoder().encode('*IDN?\n'));
  assert.equal(out.length, 12 + 6 + 2);
  assert.deepEqual([...out.subarray(0, 4)], [1, 7, 0xf8, 0]);
  assert.equal(new DataView(out.buffer).getUint32(4, true), 6);
  assert.equal(out[8], 1, 'EOM');
  assert.equal(new TextDecoder().decode(out.subarray(12, 18)), '*IDN?\n');
});

test('a reply request names its tag and how much it will take', () => {
  const req = encodeRequestIn(255, 65536);
  assert.deepEqual([...req.subarray(0, 4)], [2, 255, 0, 0]);
  assert.equal(new DataView(req.buffer).getUint32(4, true), 65536);
});

test('a reply whose tag does not match is refused', () => {
  const reply = Uint8Array.of(2, 9, 0xf6, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0x31);
  assert.equal(decodeMessageInHeader(reply, 9).transferSize, 1);
  assert.throws(() => decodeMessageInHeader(reply, 8), /does not match/);
});

test('a query round-trips, and a long reply is joined across transfers', async () => {
  const instrument = new FakeN9342C({ serial: 'MY1', sweepMs: 0 });
  const device = new FakeUsbtmcDevice(instrument, { maxReplyChunk: 100 });
  const session = new UsbtmcSession(device);
  await session.open();

  const idn = parseIdn(await session.query('*IDN?'));
  assert.equal(idn.model, 'N9342CN');
  assert.equal(idn.serial, 'MY1');

  // ~3 KB of trace in 100-byte USBTMC transfers, EOM only on the last
  const trace = parseTrace(await session.query(':TRAC:DATA? TRACE1'));
  assert.equal(trace.length, 461);
  await session.close();
});

test('tags wrap from 255 back to 1, never 0', async () => {
  const device = new FakeUsbtmcDevice(new FakeN9342C(), {});
  const session = new UsbtmcSession(device);
  await session.open();
  // each query uses two tags; 200 queries go round the 1…255 cycle
  for (let i = 0; i < 200; i += 1) {
    assert.equal(await session.query('*OPC?'), '1');
  }
  await session.close();
});

test('trace parsing tolerates a definite-length block header', () => {
  assert.deepEqual(parseTrace('#212-90.1,-80.5'), [-90.1, -80.5]);
  assert.throws(() => parseTrace('-90.1,bogus'), /not a list of numbers/);
});
