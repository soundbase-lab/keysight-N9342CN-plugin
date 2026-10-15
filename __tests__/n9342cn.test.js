// Contract tests for the N9342CN adapter, driven through the real shell over
// real HTTP, against fake analyzers — through the real USB worker process and
// the real USBTMC framing. Only the analyzer is invented (driver/fake-n9342c.js),
// so everything here runs on a CI runner with nothing plugged in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';

// The worker processes read this when they start, so it is set before the
// plugin boots. Three analyzers: a healthy one, one that is unplugged after
// its third sweep, and one whose USB read wedges after its second.
process.env.SOUNDBASE_N9342C_FAKE = JSON.stringify([
  { serial: 'MY12345678' },
  { serial: 'MY0000DEAD', unplugAfterSweeps: 3 },
  { serial: 'MY0000HANG', hangAfterSweeps: 2 },
]);

const { PRODUCT } = await import('../adapter.js');
const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

const DEVICE_ID = 'usb:MY12345678';
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;
const POINTS = 461; // the fake's; the adapter learns it from the trace

// boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const deviceRow = async (id) =>
  (await request('GET', '/devices')).body.devices.find((d) => d.id === id);

async function waitForStatus(id, wanted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    status = (await deviceRow(id))?.status?.status;
    if (status === wanted) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return status;
}

test.after(() => handle.close());

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

// The rename trap: an adapter that announces a product the manifest does not
// declare produces a device the host silently ignores.
test('the product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(
    declared.includes(PRODUCT),
    `adapter.js announces ${PRODUCT}, but soundbase-plugin.json declares only ` +
      `${declared.join(', ')}. Run \`npm run rename <id>\` to change both at once.`
  );
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
});

test('analyzers on USB are discovered by serial number', async () => {
  const { status, body } = await request('GET', '/devices');
  assert.equal(status, 200);
  const ids = body.devices.map((d) => d.id).sort();
  assert.deepEqual(ids, ['usb:MY0000DEAD', 'usb:MY0000HANG', 'usb:MY12345678']);
  const device = body.devices.find((d) => d.id === DEVICE_ID);
  assert.equal(device.product, PRODUCT);
  assert.equal(device.discovered, true);
  assert.deepEqual(device.transport, {
    kind: 'usb',
    serial: 'MY12345678',
    vendorId: '0x0957',
    productId: '0x2118',
  });
  assert.equal(device.capabilities ?? null, null, 'not opened by discovery');
});

test('open() reports the unit range, fixed point count and controls', async () => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });
  const device = await deviceRow(DEVICE_ID);
  const caps = device.capabilities;
  assert.ok(caps, 'capabilities appear once the device has been opened');
  assert.equal(caps.minFrequencyHz, 100_000);
  assert.equal(
    caps.maxFrequencyHz,
    6_000_000_000,
    'measured via FREQ:SPAN:FULL'
  );
  assert.equal(caps.autoPointCount, true);
  assert.equal(caps.rbwHz[0], 10);
  assert.equal(caps.rbwHz.at(-1), 3_000_000);
  assert.deepEqual(
    caps.controls.map((c) => c.id),
    ['detector', 'attenuation', 'preamp']
  );
  assert.deepEqual([...caps.traceModes].sort(), [
    'average',
    'clear-write',
    'max-hold',
    'min-hold',
  ]);
});

test('the echo is what the analyzer settled on, point count included', async () => {
  const { status, body } = await request(
    'POST',
    `${DEVICE_PATH}/configuration`,
    {
      startHz: START_HZ,
      stopHz: STOP_HZ,
      pointCount: 1001, // the analyzer's is fixed; this is ignored
      rbwHz: 25_000, // not a step the analyzer has; it rounds up
    }
  );
  assert.equal(status, 200);
  assert.equal(body.startHz, START_HZ);
  assert.equal(body.stopHz, STOP_HZ);
  assert.equal(body.pointCount, POINTS);
  assert.equal(body.rbwHz, 30_000);
  assert.ok(body.resolved.sweepTimeMs > 0, 'sweep time is reported');
});

test('out-of-range frequencies are clamped, not rejected', async () => {
  const { status, body } = await request(
    'POST',
    `${DEVICE_PATH}/configuration`,
    { startHz: 0, stopHz: 90_000_000_000 }
  );
  assert.equal(status, 200, 'a request outside the range is still a 200');
  assert.equal(body.startHz, 100_000);
  assert.equal(body.stopHz, 6_000_000_000);
});

test('a span entirely above the current one retunes cleanly', async () => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 100_000_000,
    stopHz: 200_000_000,
  });
  // the new start is past the old stop: the stop edge has to move first
  const { body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 2_400_000_000,
    stopHz: 2_500_000_000,
  });
  assert.equal(body.startHz, 2_400_000_000);
  assert.equal(body.stopHz, 2_500_000_000);
});

test('an automatic RBW is reported under resolved, not as rbwHz', async () => {
  const { body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: null,
  });
  assert.equal(body.rbwHz, undefined);
  assert.ok(body.resolved.rbwHz > 0);
});

test('controls are merged by id and echoed as the analyzer settled on them', async () => {
  const first = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { detector: 'sample' },
  });
  assert.equal(first.body.controls.detector, 'sample');
  assert.equal(first.body.controls.attenuation, 'auto', 'default untouched');

  const second = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { attenuation: '20', preamp: true },
  });
  assert.equal(second.body.controls.attenuation, '20');
  assert.equal(second.body.controls.preamp, true);
  assert.equal(second.body.controls.detector, 'sample', 'survived');

  // 80 dB is beyond the 50 dB attenuator: clamped, and still a 200
  const third = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { attenuation: 80 },
  });
  assert.equal(third.status, 200);
  assert.equal(third.body.controls.attenuation, '50');

  // back to the defaults the later tests assume
  await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { detector: 'positive', attenuation: 'auto', preamp: false },
  });
});

test('sweeps produce traces whose geometry matches the effective config', async (t) => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));

  const { status, body } = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(status, 200);
  assert.equal(body.pointCount, POINTS);
  assert.equal(body.amplitudesDbm.length, POINTS);
  assert.equal(body.startHz, applied.body.startHz);
  assert.equal(body.stopHz, applied.body.stopHz);
  assert.equal(body.unit, 'dBm');

  // the fake's carriers sit at a third and two thirds of the span
  const amps = body.amplitudesDbm;
  const peakNear = (fraction) => {
    const i = Math.round((POINTS - 1) * fraction);
    return Math.max(...amps.slice(i - 4, i + 5));
  };
  const floor = Math.max(...amps.slice(20, 120));
  assert.ok(floor < -80, `noise floor at ${floor}`);
  assert.ok(peakNear(0.33) > floor + 20, `carrier A only ${peakNear(0.33)}`);
  assert.ok(peakNear(0.66) > floor + 10, `carrier B only ${peakNear(0.66)}`);
});

test('max-hold keeps a transient from a sweep nobody polled for', async (t) => {
  await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    traceMode: 'max-hold',
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(async () => {
    await request('POST', `${DEVICE_PATH}/sweep/stop`);
    await request('POST', `${DEVICE_PATH}/configuration`, {
      traceMode: 'clear-write',
    });
  });

  // every fifth sweep carries a transient at mid-span
  let trace = await request('GET', `${DEVICE_PATH}/trace`);
  const target = trace.body.sweepId + 6;
  const deadline = Date.now() + 10_000;
  while (trace.body.sweepId < target && Date.now() < deadline) {
    trace = await request('GET', `${DEVICE_PATH}/trace`);
  }
  assert.ok(trace.body.sweepId >= target, `only reached ${trace.body.sweepId}`);
  const mid = Math.round((POINTS - 1) / 2);
  const peak = Math.max(...trace.body.amplitudesDbm.slice(mid - 3, mid + 4));
  assert.ok(peak > -70, `transient never accumulated (peak ${peak})`);
});

test('an analyzer unplugged mid-sweep is marked failed, not left healthy', async () => {
  const id = 'usb:MY0000DEAD';
  const path = `/devices/${encodeURIComponent(id)}`;
  await request('POST', `${path}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });
  await request('POST', `${path}/sweep/start`);
  assert.equal(await waitForStatus(id, 'failed', 5_000), 'failed');
  assert.match(
    (await deviceRow(id)).status.message ?? '',
    /unplugged|disconnected|NO_DEVICE/i
  );
});

test('a wedged USB call kills the worker, fails the device, spares the plugin', async () => {
  const id = 'usb:MY0000HANG';
  const path = `/devices/${encodeURIComponent(id)}`;
  await request('POST', `${path}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });
  await request('POST', `${path}/sweep/start`);
  // the sweep deadline is 5 s minimum, plus the link's grace
  assert.equal(await waitForStatus(id, 'failed', 12_000), 'failed');
  assert.match((await deviceRow(id)).status.message ?? '', /did not answer/);

  // and the healthy analyzer never noticed
  const { status } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });
  assert.equal(status, 200);
});

test('a device added by serial number opens the analyzer with that serial', async () => {
  const added = await request('POST', '/devices', {
    id: 'bench-analyzer',
    product: PRODUCT,
    config: { serial: 'MY12345678' },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(await waitForStatus('bench-analyzer', 'ok', 5_000), 'ok');
  const { body } = await request(
    'POST',
    '/devices/bench-analyzer/configuration',
    { startHz: START_HZ, stopHz: STOP_HZ }
  );
  assert.equal(body.pointCount, POINTS);
});

test('a configured serial with no analyzer behind it fails with a reason', async () => {
  await request('POST', '/devices', {
    id: 'missing-analyzer',
    product: PRODUCT,
    config: { serial: 'MY99999999' },
  });
  const { status, body } = await request(
    'POST',
    '/devices/missing-analyzer/configuration',
    { startHz: START_HZ, stopHz: STOP_HZ }
  );
  assert.equal(status, 503);
  assert.match(JSON.stringify(body), /no N9342CN with serial MY99999999/);
});
