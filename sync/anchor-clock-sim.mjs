#!/usr/bin/env node
// anchor-clock-sim.mjs — offline validation of the DORMANT anchor-disciplined
// clock (listener.html `_anchorClockDiscipline`, behind window._anchorClockEnabled)
// before re-enabling it live.
//
// History (sync/TUNING_LOG.md "2026-07-07 ~2:30am — anchor-disciplined virtual
// clock"): this mechanism was built, offline-simulated, deployed live, and
// REVERTED TWICE the same night. The first offline sim modeled no calibration
// loop at all — it missed that the clock-slew and auto-cal both correct the
// SAME residual (clock nudges the reference, calibration reacts to what's
// left, they chase each other). A coupling fix (noteExternalDisturbance —
// every slew tells cal to sit out the settling stretch) was added for the
// second live attempt and it STILL destabilized (250-460ms finals, 11-25
// snaps/window) within minutes.
//
// This sim runs the REAL ternary/layer.js (vm sandbox, same harness as
// greenhorn-sim.mjs) together with `_anchorClockDiscipline`'s ACTUAL algorithm
// (copied verbatim below — small and self-contained enough to port faithfully,
// unlike the corrector itself) so the exact interaction that broke it before
// is under test, not a simplified stand-in.
//
// Model: the corrector's measured lag each tick is the SUM of two independent,
// still-uncorrected residuals — clock-offset error (fixed unless slewed) and
// device-latency error (fixed unless auto-cal/greenhorn corrects it) — plus
// noise. That additive coupling is exactly the "two authorities, one signal"
// danger the 2026-07-07 postmortem named.
//
// Usage: node sync/anchor-clock-sim.mjs

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const layerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../ternary/layer.js'), 'utf8');

function makeSandbox({ wasStored, model }) {
  let simNow = 1_000_000;
  const timers = [];
  const calEvents = [];
  const handlers = {};
  const state = {
    deviceLatencyMs: 0,
    adjustCalls: [],
    now: () => simNow,
    advance: (ms) => { simNow += ms; },
    calEvents,
  };

  const el = () => ({ style: {}, innerHTML: '', textContent: '', appendChild() {} });
  const chan = { on(type, filter, handler) { handlers[filter?.event] = handler; return chan; },
                 subscribe() { return chan; },
                 send(msg) { if (msg?.event === 'sync_event') calEvents.push(msg.payload); } };

  const window = {
    db: { channel: () => chan },
    listenerId: 'simdev',
    _debugChannel: chan,
    _terLatencyWasStored: wasStored,
    _terGetDeviceLatencyMs: () => state.deviceLatencyMs,
    _terAdjustLatency: (delta) => {
      const prev = state.deviceLatencyMs;
      state.deviceLatencyMs = Math.max(0, Math.min(1200, state.deviceLatencyMs + delta));
      state.adjustCalls.push({ t: simNow, delta, result: state.deviceLatencyMs });
      return state.deviceLatencyMs - prev;
    },
    _terGetZone: () => ({ playback_started_at: new Date(0).toISOString() }),
    SyncEngine: { isEntryPhase: () => false, getDriftState: () => 'idle' },
    _audio: { currentTime: 10, duration: 300, playbackRate: 1 },
    syncedNow: () => simNow,
    activeZone: { name: 'sim' },
  };
  window.window = window;

  const sandbox = {
    window,
    document: { readyState: 'complete', createElement: el, getElementById: () => null,
                body: { appendChild() {} }, addEventListener() {} },
    navigator: { userAgent: `Mozilla/5.0 (${model}) SimKit/1.0` },
    console: { log: () => {}, warn: () => {} },
    Date: { now: () => simNow },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => { fn(); },
    clearTimeout: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(layerSrc, sandbox);
  return { state, window };
}

const MODEL = 'Linux; Android 13; Pixel 7';

// ── _anchorClockDiscipline, ported verbatim (listener.html:5078-5099) ──────
// Same constants, same gates, same deadband/step/window. Only the I/O is
// swapped for the sim: `terLayer` in place of window._terLayer, a plain
// object in place of `_anchorClock`, `getEngineLagMs()` in place of
// window._engineLagMs (the corrector's own current lag reading — real
// listener.html feeds this from the live drift computation).
function makeAnchorClock() {
  return { samples: [], lastAt: 0, active: false, clockOffset: 0 };
}
function anchorClockDiscipline(ac, payload, nowMs, terLayer, getEngineLagMs, isSilentWarp) {
  if (nowMs - ac.lastAt > 30000) ac.samples.length = 0;
  ac.lastAt = nowMs;
  const o = (nowMs + ac.clockOffset) - payload.ts;
  if (!isFinite(o) || Math.abs(o) > 2000) return false;
  ac.samples.push(o);
  if (ac.samples.length > 24) ac.samples.shift();
  if (ac.samples.length < 3) return false;
  ac.active = true;
  if (Math.abs(getEngineLagMs() ?? Infinity) >= 50) return false;
  if (isSilentWarp()) return false;
  const est = Math.min(...ac.samples);
  if (Math.abs(est) <= 15) return false;
  const step = Math.max(-15, Math.min(15, -est));
  ac.clockOffset += step;
  for (let i = 0; i < ac.samples.length; i++) ac.samples[i] += step;
  terLayer.noteExternalDisturbance();
  return true;
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// ── Scenario: realistic session — true clock error + true BT latency, both
// uncorrected at start, anchor ticking every 5s (production cadence),
// corrector reading drift every 2.5s (production DRIFT_CHECK_MS) ──────────
function runSession({ label, trueClockErrorMs, trueLatencyMs, anchorJitterMs, driftNoiseMs, minutes }) {
  console.log(`\n[${label}] trueClockError=${trueClockErrorMs}ms trueLatency=${trueLatencyMs}ms ` +
              `anchorJitter=±${anchorJitterMs}ms driftNoise=±${driftNoiseMs}ms over ${minutes}min`);
  const { state, window: win } = makeSandbox({ wasStored: false, model: MODEL });
  const ac = makeAnchorClock();
  let engineLagMs = trueClockErrorMs + trueLatencyMs; // pre-anything combined residual
  const isSilentWarp = () => false; // sim never enters silent-warp launch phase

  const totalTicks = Math.round(minutes * 60 / 2.5);
  const anchorEvery = Math.round(5000 / 2500); // anchor fires every 2nd drift tick (5s / 2.5s)
  const history = [];
  let slews = 0;

  for (let i = 0; i < totalTicks; i++) {
    state.advance(2500);

    // Combined, still-uncorrected residual: clock-offset error component +
    // device-latency error component + measurement noise. This is the exact
    // "one signal, two authorities" coupling named in the 2026-07-07 postmortem.
    const clockResidual = trueClockErrorMs - ac.clockOffset;
    const latencyResidual = trueLatencyMs - state.deviceLatencyMs;
    const noise = (Math.random() * 2 - 1) * driftNoiseMs;
    const measuredLag = clockResidual + latencyResidual + noise;
    engineLagMs = measuredLag; // what window._engineLagMs would read this tick

    win._terLayer.tick(measuredLag);

    if (i % anchorEvery === 0) {
      // Anchor payload timestamp carries the DJ's own emission jitter/latency —
      // modeled as noise around the residual clock error being disciplined.
      const anchorTs = state.now() - ac.clockOffset - trueClockErrorMs +
                        (Math.random() * 2 - 1) * anchorJitterMs;
      const slewed = anchorClockDiscipline(ac, { ts: anchorTs }, state.now(), win._terLayer,
                                            () => engineLagMs, isSilentWarp);
      if (slewed) slews++;
    }

    if (i % 24 === 0) { // ~ every minute
      history.push({ minute: Math.round(i * 2.5 / 60), lat: state.deviceLatencyMs,
                      clockOffset: ac.clockOffset, lag: measuredLag });
    }
  }

  const finalLag = Math.abs(trueClockErrorMs - ac.clockOffset) + Math.abs(trueLatencyMs - state.deviceLatencyMs);
  const last3 = history.slice(-3);
  const lastLats = last3.map(h => h.lat);
  const spread = Math.max(...lastLats) - Math.min(...lastLats);

  console.log('  minute-by-minute (lat, clockOffset, lag):');
  history.forEach(h => console.log(`    m${h.minute}: lat=${Math.round(h.lat)}ms clockOffset=${h.clockOffset.toFixed(1)}ms lag=${h.lag.toFixed(1)}ms`));
  console.log(`  slews applied: ${slews}, cal corrections: ${state.adjustCalls.length}`);

  check('converged: final residual < 60ms', finalLag < 60, `residual=${finalLag.toFixed(1)}ms`);
  check('held steady: last-3-minute latency spread < 40ms', spread < 40, `spread=${spread.toFixed(1)}ms`);
  check('no runaway (latency stayed within [0,1200])', state.deviceLatencyMs >= 0 && state.deviceLatencyMs <= 1200,
        `final=${Math.round(state.deviceLatencyMs)}ms`);

  return { finalLag, spread, calCorrections: state.adjustCalls.length, deviceLatencyMs: state.deviceLatencyMs };
}

// Scenario A: matches the July 7 live failure shape most closely — real BT
// floor plus meaningful residual clock error, moderate anchor jitter, run long
// enough (20min) to see whether it converges-and-holds or ratchets.
runSession({ label: 'A: realistic mixed residual, 20min', trueClockErrorMs: 120, trueLatencyMs: 280,
             anchorJitterMs: 20, driftNoiseMs: 15, minutes: 20 });

// Scenario B: clock error dominant, latency near-zero — isolate whether the
// clock-discipline alone (minimal cal interaction) is clean.
runSession({ label: 'B: clock-error dominant, 15min', trueClockErrorMs: 180, trueLatencyMs: 20,
             anchorJitterMs: 20, driftNoiseMs: 15, minutes: 15 });

// Scenario C: latency dominant, clock error near-zero — isolate whether cal
// alone (minimal clock interaction) is clean, as a control.
runSession({ label: 'C: latency dominant (control), 15min', trueClockErrorMs: 10, trueLatencyMs: 350,
             anchorJitterMs: 20, driftNoiseMs: 15, minutes: 15 });

// Scenario D: noisier anchor (worse network jitter than production expects),
// stress test for the destabilization mode described in the postmortem.
runSession({ label: 'D: noisy anchor, stress, 25min', trueClockErrorMs: 150, trueLatencyMs: 300,
             anchorJitterMs: 60, driftNoiseMs: 25, minutes: 25 });

console.log(failures ? `\n${failures} FAILURE(S) — do NOT re-enable window._anchorClockEnabled yet` : '\nALL PASS');
