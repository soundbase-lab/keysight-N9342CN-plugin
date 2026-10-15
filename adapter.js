// Keysight N9342CN handheld spectrum analyzer, over USB.
//
//   adapter.js                 the SoundBase contract — this file
//   driver/n9342c.js           the analyzer's SCPI
//   driver/worker-link.js      the plugin's end of the USB worker
//   driver/worker/             the child process that owns the USB device
//   driver/usbtmc.js           USBTMC framing, the protocol under VISA's USB0::
//   driver/fake-n9342c.js      a fake analyzer, so tests need no hardware
//   driver/protocol.md         every command used, and where it is documented
//
// The analyzer is a USBTMC device, so no vendor driver is involved: the `usb`
// package claims its interface directly, inside a worker process the plugin
// can kill if a USB call ever wedges.

import {
  N9342C,
  listAnalyzers,
  MAX_ATTEN_DB,
  MAX_REF_LEVEL_DBM,
  MIN_REF_LEVEL_DBM,
  RBW_HZ,
} from './driver/n9342c.js';

// The product this adapter announces its devices as. It MUST be a
// `deviceTypeId` declared in soundbase-plugin.json — the host ignores a device
// naming a product the manifest never declared. `npm run rename` keeps them in
// step; a test asserts they agree.
export const PRODUCT = 'plugin:keysight-n9342cn/n9342cn';

const DEFAULT_START_HZ = 470_000_000;
const DEFAULT_STOP_HZ = 616_000_000;
// USB transfer and parsing time on top of the analyzer's own sweep time
const SWEEP_OVERHEAD_MS = 150;

const ATTENUATION_STEPS_DB = Array.from(
  { length: MAX_ATTEN_DB / 5 + 1 },
  (_, i) => i * 5
);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

let reportedDiscoveryFailure = false;

/**
 * Analyzers on USB right now, found by vendor and product id (0x0957:0x2118)
 * without opening them. The id comes from the USB serial number, which is the
 * analyzer's own serial, so it is stable across restarts and across machines.
 */
export async function discoverDevices() {
  let analyzers;
  try {
    analyzers = await listAnalyzers();
  } catch (err) {
    // once, not once a second: discovery is polled
    if (!reportedDiscoveryFailure) {
      reportedDiscoveryFailure = true;
      console.error(`[keysight-n9342cn] USB discovery failed: ${err.message}`);
    }
    return [];
  }
  reportedDiscoveryFailure = false;
  return analyzers.map((analyzer) => ({
    id: analyzer.serial
      ? `usb:${analyzer.serial}`
      : `usb:bus${analyzer.bus}-${analyzer.address}`,
    name: analyzer.serial
      ? `Keysight N9342CN (${analyzer.serial})`
      : 'Keysight N9342CN',
    product: PRODUCT,
    transport: {
      kind: 'usb',
      serial: analyzer.serial,
      vendorId: hex(analyzer.vendorId),
      productId: hex(analyzer.productId),
    },
  }));
}

const hex = (n) => `0x${n.toString(16).padStart(4, '0')}`;

// ---------------------------------------------------------------------------
// SpectrumAnalyzer
// ---------------------------------------------------------------------------

export function createSpectrumAnalyzerAdapter(device) {
  return new N9342cnAdapter(device);
}

class N9342cnAdapter {
  constructor(device) {
    // Addressing arrives in the device the host asked for: the serial number
    // from its configuration, or the one encoded in a discovered device's id.
    // No serial at all means "the first N9342CN on USB".
    this.serial = serialOf(device);
    this.analyzer = null;
    this.pointCount = null;
    this.effective = null;
    this.sweeping = false;
    this.warnings = new Map();
    // assigned by the shell
    this.onFatal = null;
    this.onWarnings = null;
  }

  async open() {
    const analyzer = new N9342C({ serial: this.serial });
    analyzer.onFatal = (err) => this.#fatal(err);
    let identity;
    try {
      identity = await analyzer.connect();
      // a known starting point for everything SoundBase lets the user change:
      // automatic bandwidths, automatic attenuation, no preamp, peak detector
      await analyzer.setRbw(null);
      await analyzer.setVbw(null);
      this.controls = {
        detector: await analyzer.setDetector('positive'),
        attenuation: attenuationValue(await analyzer.setAttenuation(null)),
        preamp: await analyzer.setPreamp(false),
      };
      // The analyzer sweeps a fixed number of points that no command changes
      // (461, by every account, but the guide never says). Learn it from the
      // trace it is displaying, rather than trusting a constant.
      this.pointCount = (await analyzer.readTrace()).length;
      await this.#reportInstrumentErrors(analyzer);
    } catch (err) {
      await analyzer.close();
      throw new Error(
        `Keysight N9342CN${this.serial ? ` ${this.serial}` : ''}: ${err.message}`
      );
    }
    this.analyzer = analyzer;
    this.effective = null;

    return {
      capabilities: {
        minFrequencyHz: analyzer.range.minHz,
        maxFrequencyHz: analyzer.range.maxHz,
        rbwHz: [...RBW_HZ],
        minRefLevelDbm: MIN_REF_LEVEL_DBM,
        maxRefLevelDbm: MAX_REF_LEVEL_DBM,
        // no command sets the point count, so SoundBase offers no control for
        // it; every echo reports the count the analyzer sweeps
        autoPointCount: true,
        controls: [
          {
            id: 'detector',
            type: 'dropdown',
            label: 'Detector',
            default: 'positive',
            choices: [
              { id: 'positive', label: 'Peak' },
              { id: 'sample', label: 'Sample' },
              { id: 'average', label: 'Average' },
              { id: 'negative', label: 'Negative peak' },
              { id: 'normal', label: 'Normal' },
            ],
            help: 'Peak catches every carrier in a bin and is the right choice for coordination.',
          },
          {
            id: 'attenuation',
            type: 'dropdown',
            label: 'Input attenuation',
            default: 'auto',
            choices: [
              { id: 'auto', label: 'Auto' },
              ...ATTENUATION_STEPS_DB.map((db) => ({
                id: String(db),
                label: `${db} dB`,
              })),
            ],
            help: 'Raise this if strong nearby transmitters are overloading the front end.',
          },
          {
            id: 'preamp',
            type: 'checkbox',
            label: 'Preamplifier',
            default: false,
            help: 'Lowers the noise floor to find weak signals. Turn it off near strong transmitters.',
          },
        ],
      },
      identity: {
        manufacturer: identity.manufacturer,
        model: identity.model,
        firmware: identity.firmware,
      },
    };
  }

  /**
   * Apply what was asked for and return what the analyzer settled on. Every
   * value is set, then read back: the echo is the analyzer's word, not ours.
   *
   * The shell hands over the whole desired configuration each time, with
   * controls already merged by id, so an absent bandwidth is not "unchanged"
   * but "the analyzer's choice" — the user cleared it, or never set it.
   */
  async applyConfig(cfg = {}) {
    const analyzer = this.#require();
    const previous = this.effective ?? { controls: { ...this.controls } };
    const resolved = {};

    const range = await analyzer.setRange(
      isNum(cfg.startHz) ? cfg.startHz : (previous.startHz ?? DEFAULT_START_HZ),
      isNum(cfg.stopHz) ? cfg.stopHz : (previous.stopHz ?? DEFAULT_STOP_HZ)
    );

    const effective = {
      startHz: range.startHz,
      stopHz: range.stopHz,
      // requested pointCount and stepHz are ignored: the analyzer's is fixed
      pointCount: this.pointCount,
      controls: { ...previous.controls },
    };

    // Bandwidths: a number is manual; anything else is automatic, and an
    // automatic value moves with the span, so it is read back every time and
    // reported under `resolved`.
    if (isNum(cfg.rbwHz)) effective.rbwHz = await analyzer.setRbw(cfg.rbwHz);
    else resolved.rbwHz = await analyzer.setRbw(null);

    if (isNum(cfg.vbwHz)) effective.vbwHz = await analyzer.setVbw(cfg.vbwHz);
    else resolved.vbwHz = await analyzer.setVbw(null);

    // reference level only scales the analyzer's own display; set it if asked
    if (isNum(cfg.refLevelDbm)) {
      effective.refLevelDbm = await analyzer.setRefLevel(cfg.refLevelDbm);
    }

    const controls = cfg.controls ?? {};
    if ('detector' in controls) {
      effective.controls.detector = await analyzer.setDetector(
        controls.detector ?? 'positive'
      );
    }
    if ('attenuation' in controls) {
      effective.controls.attenuation = attenuationValue(
        await analyzer.setAttenuation(attenuationRequest(controls.attenuation))
      );
    }
    if ('preamp' in controls) {
      effective.controls.preamp = await analyzer.setPreamp(
        Boolean(controls.preamp)
      );
    }

    resolved.sweepTimeMs = Math.ceil(
      (await analyzer.sweepTimeMs()) + SWEEP_OVERHEAD_MS
    );
    effective.resolved = resolved;

    await this.#reportInstrumentErrors(analyzer);
    this.effective = effective;
    return effective;
  }

  /**
   * One trigger, one complete sweep, one onTrace — in a loop rather than on a
   * timer, so a slow sweep never overlaps the next.
   */
  async startSweep(onTrace) {
    if (this.sweeping) return;
    const analyzer = this.#require();
    this.sweeping = true;
    (async () => {
      while (this.sweeping && this.analyzer === analyzer) {
        let amplitudes;
        try {
          amplitudes = await analyzer.sweep();
        } catch (err) {
          if (this.sweeping && this.analyzer === analyzer) this.#fatal(err);
          return;
        }
        if (!this.sweeping) return;
        // Never hand the shell a trace whose length disagrees with the
        // effective config: it would draw shifted in frequency.
        if (amplitudes.length !== this.pointCount) {
          this.#warn('point-count', {
            severity: 'critical',
            message:
              `The analyzer returned ${amplitudes.length} points where ${this.pointCount} ` +
              'were expected, so its traces are being dropped. Remove and re-add the device.',
          });
          continue;
        }
        this.#warn('point-count', null);
        onTrace(amplitudes);
      }
    })();
  }

  async stopSweep() {
    this.sweeping = false;
  }

  /** Release the analyzer. Idempotent; never throws. */
  async close() {
    this.sweeping = false;
    const analyzer = this.analyzer;
    this.analyzer = null;
    await analyzer?.close().catch(() => {});
  }

  #require() {
    if (!this.analyzer) throw new Error('the analyzer is not open');
    return this.analyzer;
  }

  #fatal(err) {
    if (!this.analyzer) return; // a close we asked for
    this.sweeping = false;
    this.onFatal?.(err);
  }

  /**
   * Anything the analyzer refused goes to the user as an info warning, verbatim.
   * The command set is from the programmer's guide, not from a unit on a
   * bench, so this is how a firmware that disagrees with the guide shows up.
   */
  async #reportInstrumentErrors(analyzer) {
    let errors;
    try {
      errors = await analyzer.drainErrors();
    } catch {
      return;
    }
    this.#warn(
      'instrument-errors',
      errors.length
        ? {
            severity: 'info',
            message: `The analyzer reported: ${errors.join('; ')}`,
          }
        : null
    );
  }

  #warn(id, warning) {
    if (warning) this.warnings.set(id, { id, ...warning });
    else this.warnings.delete(id);
    this.onWarnings?.([...this.warnings.values()]);
  }
}

/** The serial from device.config, else from a `usb:<serial>` id, else null. */
function serialOf(device) {
  const configured = device.config?.serial;
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim();
  }
  const match = /^usb:(.+)$/.exec(device.id ?? '');
  if (match && !/^bus/.test(match[1])) return match[1];
  return null;
}

/** 'auto' | '20' | 20 | null -> null (automatic) or a number of dB */
function attenuationRequest(value) {
  if (value === null || value === undefined || value === 'auto') return null;
  const db = Number(value);
  return Number.isFinite(db) ? db : null;
}

/** { auto, db } from the analyzer -> the control's value */
function attenuationValue({ auto, db }) {
  if (auto) return 'auto';
  // the dropdown offers 5 dB steps; report the nearest one the menu has
  const step = ATTENUATION_STEPS_DB.reduce((best, c) =>
    Math.abs(c - db) < Math.abs(best - db) ? c : best
  );
  return String(step);
}
