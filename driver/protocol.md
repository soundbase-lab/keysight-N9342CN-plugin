# How the plugin talks to the N9342CN

The plugin was written from Keysight's documentation, without a unit on a
bench. This file records what it relies on and where each fact comes from, so
the first session with real hardware can check them quickly.

## Sources

- **Programmer's guide:** *Agilent N9342C/43C/44C Handheld Spectrum Analyzer
  Programmer's Guide*, part N9342-90066, third edition (October 2012). It is
  valid for firmware A.04.20 and later.
  <https://www.keysight.com/iq/en/assets/9018-03425/programming-guides/9018-03425.pdf>
  A newer edition, 9018-04273 (December 2020), sits behind a registration form.
- **User's guide:** *N9342C/43C/44C User's Guide*. Its front-panel drawing
  shows the N9342CN badge ("100 kHz – 6.0 GHz"), which places the N9342CN in
  the same family, running the same firmware.

## Transport

| Fact | Source |
|---|---|
| The analyzer is a USBTMC device; Windows lists it as "USB Test and Measurement Device", and no vendor driver is needed | Programmer's guide, ch. 1, "Connecting the Analyzer via the USB Port" |
| VISA address `USB0::2391::8472::<serial>::0::INSTR`, i.e. vendor ID **0x0957**, product ID **0x2118** | Programmer's guide, ch. 4 examples |
| The device clear (`viClear`) is issued before the first command | Programmer's guide, ch. 4 example; implemented as USBTMC `INITIATE_CLEAR` in `usbtmc.js` |

The USBTMC framing in `usbtmc.js` follows the USB Test & Measurement Class
specification, rev 1.0.

## Commands

All are sent in the short forms shown.

| Purpose | Command | Notes |
|---|---|---|
| Identify | `*IDN?` | `manufacturer,model,serial,firmware`; the guide's example reads `Agilent Technologies, N9342C, 45310116, A.01.02` |
| Clear status | `*CLS` | |
| Spectrum-analyzer mode | `:INST SA` | `*RST` default |
| Units | `:UNIT:POW DBM` | The guide's own example does this before measuring |
| Trace format | `:FORM ASC` | Comma-separated. `REAL` is "4 bytes length float"; the guide doesn't give the byte order, so it isn't used |
| Trace 1 clear-write | `:TRAC1:MODE WRIT` | The shell accumulates max-hold etc. itself |
| Single sweeps | `:INIT:CONT 0`, then `:INIT` + `*OPC?` | `*OPC?` answers once the sweep has finished |
| Read trace | `:TRAC:DATA? TRACE1` | "returns the current displayed data" |
| Full span | `:FREQ:SPAN:FULL` | Used once at open, to read this unit's maximum from `:FREQ:STOP?` |
| Start / stop | `:FREQ:STAR <Hz>`, `:FREQ:STOP <Hz>` (+ `?`) | Values are read back after setting |
| RBW | `:BAND <Hz>`, `:BAND:AUTO ON`, `:BAND?` | 10 Hz – 3 MHz; "nearest … rounding up" |
| VBW | `:BAND:VID <Hz>`, `:BAND:VID:AUTO ON`, `:BAND:VID?` | 1 Hz – 3 MHz, coupled to RBW |
| Reference level | `:DISP:WIND:TRAC:Y:RLEV <dBm>` | −140 to +20 dBm |
| Attenuation | `:POW:ATT <dB>`, `:POW:ATT:AUTO ON`, `?` forms | 0 – 50 dB |
| Preamp | `:POW:GAIN ON\|OFF` | |
| Detector | `:DET:TRAC1 POS\|SAMP\|AVER\|NEG\|NORMAL` | |
| Sweep time | `:SWE:TIME?` | Seconds; sets the `*OPC?` deadline and `resolved.sweepTimeMs` |
| Errors | `:SYST:ERR?` | Drained after open and after every configuration; shown to the user as an info warning |
| Hand back | `:INIT:CONT 1` | On close, so the front panel sweeps again |

## Not confirmed by the documentation

These can only be settled by a real unit. The plugin is built so a wrong guess
on any of them still works, or reports itself, rather than failing silently.

1. **Trace point count.** Neither guide states it, and no command sets it.
   The related N9322C's datasheet says "461, fixed". The plugin never assumes
   a count: it reads the length of the displayed trace at open and reports
   that number, with `autoPointCount: true`. A later trace of a different
   length is dropped and raised as a critical warning, rather than drawn at
   the wrong frequencies.
2. **The `*IDN?` model string on an N9342CN** (`N9342C` or `N9342CN`). This
   only affects the fallback frequency range: the real range is measured with
   `:FREQ:SPAN:FULL`.
3. **The attenuator's step size.** The guide gives only the 0–50 dB range.
   The control offers 5 dB steps.
4. **Whether `:SWE:TIME?` is accurate in FFT sweep mode.** At narrow RBWs a
   sweep that runs longer than twice this estimate is treated as a wedged
   connection. The minimum deadline is 5 s.
5. **The product ID for the N9343C and N9344C.** The guide's examples all use
   0x2118. Only 0x2118 is matched.

## Checking a real unit

Run these by hand through the worker, which talks to real USB when
`SOUNDBASE_N9342C_FAKE` is unset:

```sh
printf '%s\n' \
  '{"id":1,"op":"list"}' \
  '{"id":2,"op":"open"}' \
  '{"id":3,"op":"query","data":"*IDN?"}' \
  '{"id":4,"op":"query","data":":SYST:OPT?"}' \
  '{"id":5,"op":"write","data":":FORM ASC"}' \
  '{"id":6,"op":"query","data":":TRAC:DATA? TRACE1"}' \
  '{"id":7,"op":"write","data":":BAND 25000"}' \
  '{"id":8,"op":"query","data":":BAND?"}' \
  '{"id":9,"op":"query","data":":SWE:TIME?"}' \
  '{"id":10,"op":"query","data":":SYST:ERR?"}' \
  | node driver/worker/usbtmc-worker.js
```

The answers settle items 1–4. Count the values in reply 6 for item 1. Reply 8
should be `3E+04` if RBW rounds up as the guide says. Then run `npm run smoke`
with the analyzer plugged in, to check the full sweep path.
