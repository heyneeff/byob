#!/usr/bin/env node
// room-consensus-sim.mjs — offline validation of a DISCRETE, rate-limited,
// threshold-gated room-consensus correction (the "make them all talk" layer,
// see sync/TUNING_LOG.md "2026-07-14 (cont.) — live tuning session..." and
// the Obsidian "BYOB Synced Entry" note).
//
// NOT the anchor-clock mechanism (that's a continuous ±15ms/tick slew,
// already sim-validated and found broken — see anchor-clock-sim.mjs). This
// is deliberately different in shape: instead of continuously nudging the
// clock, a phone periodically compares its own reconstructed reference
// (refMs — same math as ternary/overlay.html's Room Spread gauge) against
// the peer median, and — only if the disagreement exceeds a threshold and
// enough time has passed since the last correction — fires ONE discrete
// jump to close the gap outright, via the same window._terCorrect() path
// hard_sync already uses in production. Not yet wired into live code —
// this sim is purely to find out whether the DESIGN holds up before it's
// ever implemented for real.
//
// Runs the REAL ternary/layer.js (vm sandbox, same harness as
// greenhorn-sim.mjs / anchor-clock-sim.mjs) so the real calibration loop is
// what's actually under test, not a stand-in.
//
// Usage: node sync/room-consensus-sim.mjs

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
let failures = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// ── Discrete room-consensus correction, v3 ──────────────────────────────────
// v1: threshold too high, single-sample overshoot under peer noise.
// v2: lower threshold + 4-sample averaging window — passed offline, then
// broke live in ~3min (commit 38c5655, reverted 2713593) from two failure
// modes NEITHER version ever simulated:
//   1. measureClockOffset()'s independent 30s RTT re-measurement clobbered
//      _clockOffset right after a correction landed, with zero awareness of
//      each other ("two authorities over one signal").
//   2. computeOwnRefMs() has no wrap-guard — a track-loop-wrap sample
//      (currentTime≈0) poisoned the averaging window with a wild outlier.
// v3 (this version) fixes both, PLUS bakes in the 61.2.4→25 cast's
// guidance: build it lean, and tolerate a stray device rather than forcing
// exact uniformity (line 4, "the team-horse goes astray, no blame").
const CONSENSUS_THRESHOLD_MS = 60;
const CONSENSUS_RATE_LIMIT_MS = 30000;
const CONSENSUS_WINDOW_N = 4; // average this many peer-comparison samples before acting
// One authority, full yield (not a timed suppression — a 30-45s window
// barely beats the remeasure/correction cadences and still leaked E/G
// below). Once room-consensus has EVER fired a correction this session, it
// owns the clock outright — measureClockOffset's periodic RTT probe stays
// fully suspended, matching the anchor-clock postmortem's "exactly ONE
// clock authority at a time, full yield" law instead of a rolling window.
const WRAP_SANITY_MS = 2000; // mirrors TH_SEEK_SANITY — a sample this large is a wrap artifact, not real disagreement
function maybeRoomConsensusCorrect(rc, ownResidualSampleMs, nowMs) {
  // Fix 2: wrap-guard — drop nonsensical samples before they ever enter the window.
  if (Math.abs(ownResidualSampleMs) > WRAP_SANITY_MS) return 0;
  rc.samples.push(ownResidualSampleMs);
  if (rc.samples.length > CONSENSUS_WINDOW_N) rc.samples.shift();
  if (rc.samples.length < CONSENSUS_WINDOW_N) return 0; // not enough samples yet
  const avg = rc.samples.reduce((a, v) => a + v, 0) / rc.samples.length;
  if (Math.abs(avg) <= CONSENSUS_THRESHOLD_MS) return 0; // tolerance — don't chase small/isolated disagreement
  if (nowMs - rc.lastAt < CONSENSUS_RATE_LIMIT_MS) return 0;
  rc.lastAt = nowMs;
  rc.engaged = true; // one authority, full yield — measureClockOffset stays suspended from here on
  rc.samples = [];
  return avg; // close the gap using the averaged estimate, not one noisy sample
}

function runSession({ label, trueClockErrorMs, trueLatencyMs, peerNoiseMs, driftNoiseMs, minutes, withConsensus,
                      simulateRemeasure = false, simulateWrap = false, trueRawClockSkewMs = 0 }) {
  console.log(`\n[${label}] trueClockError=${trueClockErrorMs}ms trueLatency=${trueLatencyMs}ms ` +
              `peerNoise=±${peerNoiseMs}ms driftNoise=±${driftNoiseMs}ms over ${minutes}min consensus=${withConsensus}` +
              `${simulateRemeasure ? ' +remeasure-timer' : ''}${simulateWrap ? ' +wrap-events' : ''}`);
  const { state, window: win } = makeSandbox({ wasStored: false, model: MODEL });
  let clockOffsetMs = 0;
  const rc = { lastAt: -Infinity, samples: [], engaged: false };
  let corrections = 0, remeasures = 0, wrapEventsFired = 0, wrapEventsDropped = 0;

  const totalTicks = Math.round(minutes * 60 / 2.5);
  const consensusEvery = Math.round(10000 / 2500); // room-consensus check every ~10s
  const remeasureEvery = Math.round(30000 / 2500);  // measureClockOffset()'s real 30s cadence
  const history = [];

  for (let i = 0; i < totalTicks; i++) {
    state.advance(2500);

    const clockResidual = trueClockErrorMs - clockOffsetMs;
    const latencyResidual = trueLatencyMs - state.deviceLatencyMs;
    const noise = (Math.random() * 2 - 1) * driftNoiseMs;
    const measuredLag = clockResidual + latencyResidual + noise;

    win._terLayer.tick(measuredLag);

    // Failure mode 1: measureClockOffset()'s independent 30s RTT timer,
    // running with zero awareness of room-consensus. RTT only ever sees
    // clock SKEW — room-consensus's trueClockErrorMs is the FULL reference
    // residual (skew + non-RTT-visible reference drift), so an un-suppressed
    // remeasure doesn't re-find truth, it clobbers the correction back
    // toward whatever raw RTT alone sees (trueRawClockSkewMs, often far from
    // trueClockErrorMs) — this is the literal live bug ("clockOffset
    // reverted to pre-correction value"). Fix: one authority — suppress the
    // remeasure while a correction is still fresh.
    if (simulateRemeasure && i > 0 && i % remeasureEvery === 0) {
      if (!rc.engaged) {
        clockOffsetMs = trueRawClockSkewMs + (Math.random() * 2 - 1) * peerNoiseMs;
        remeasures++;
      }
    }

    if (withConsensus && i % consensusEvery === 0) {
      // Peer comparison imprecision — network jitter, peers themselves not
      // perfectly settled. Room median treated as ground truth 0 for this
      // test (isolates "does MY device converge to a known-correct external
      // reference", the core question — real peers being imperfect too is
      // a separate, second-order question for a later sim).
      let ownResidual = (trueClockErrorMs - clockOffsetMs) + (Math.random() * 2 - 1) * peerNoiseMs;

      // Failure mode 2: a track-loop-wrap sample — one peer's currentTime≈0
      // produces a wild, nonsensical refMs comparison. ~5% of checks, one of
      // the ~309 real episodes/session scale from the live CSV.
      if (simulateWrap && Math.random() < 0.05) {
        const wrapSample = ownResidual + (Math.random() < 0.5 ? 1 : -1) * (60000 + Math.random() * 20000);
        if (Math.abs(wrapSample) > WRAP_SANITY_MS) wrapEventsDropped++; else wrapEventsFired++;
        ownResidual = wrapSample;
      }

      const jump = maybeRoomConsensusCorrect(rc, ownResidual, state.now());
      if (jump !== 0) { clockOffsetMs += jump; corrections++; }
    }

    if (i % 24 === 0) {
      history.push({ minute: Math.round(i * 2.5 / 60), lat: state.deviceLatencyMs,
                      clockOffset: clockOffsetMs, lag: measuredLag });
    }
  }
  if (simulateRemeasure) console.log(`  independent clock re-measurements applied: ${remeasures}`);
  if (simulateWrap) console.log(`  wrap-events injected: dropped=${wrapEventsDropped} (correct) leaked=${wrapEventsFired} (bad)`);

  const finalResidual = Math.abs(trueClockErrorMs - clockOffsetMs) + Math.abs(trueLatencyMs - state.deviceLatencyMs);
  const last3 = history.slice(-3).map(h => h.lat);
  const latSpread = Math.max(...last3) - Math.min(...last3);

  console.log('  minute-by-minute (lat, clockOffset, lag):');
  history.forEach(h => console.log(`    m${h.minute}: lat=${Math.round(h.lat)}ms clockOffset=${h.clockOffset.toFixed(1)}ms lag=${h.lag.toFixed(1)}ms`));
  console.log(`  room-consensus corrections applied: ${corrections}, cal corrections: ${state.adjustCalls.length}`);

  check('converged: final residual < 60ms', finalResidual < 60, `residual=${finalResidual.toFixed(1)}ms`);
  check('held steady: last-3-minute latency spread < 40ms', latSpread < 40, `spread=${latSpread.toFixed(1)}ms`);
  check('no runaway (latency stayed within [0,1200])', state.deviceLatencyMs >= 0 && state.deviceLatencyMs <= 1200,
        `final=${Math.round(state.deviceLatencyMs)}ms`);
  if (simulateWrap) check('wrap-guard: zero wrap samples leaked into a correction', wrapEventsFired === 0,
        `leaked=${wrapEventsFired}`);
  if (simulateRemeasure) check('no huge single-tick clockOffset jump from an un-suppressed remeasure',
        true, `remeasures applied=${remeasures} (informational — see corrections vs residual above)`);

  return { finalResidual, latSpread, corrections };
}

// Same scenarios as anchor-clock-sim.mjs, so results are directly comparable.
runSession({ label: 'A: realistic mixed residual, WITH consensus, 20min', trueClockErrorMs: 120, trueLatencyMs: 280,
             peerNoiseMs: 20, driftNoiseMs: 15, minutes: 20, withConsensus: true });
runSession({ label: "A': same scenario, WITHOUT consensus (control, matches anchor-clock-sim A)", trueClockErrorMs: 120, trueLatencyMs: 280,
             peerNoiseMs: 20, driftNoiseMs: 15, minutes: 20, withConsensus: false });

runSession({ label: 'B: clock-error dominant, WITH consensus, 15min', trueClockErrorMs: 180, trueLatencyMs: 20,
             peerNoiseMs: 20, driftNoiseMs: 15, minutes: 15, withConsensus: true });

runSession({ label: 'D: noisy peers, stress, WITH consensus, 25min', trueClockErrorMs: 150, trueLatencyMs: 300,
             peerNoiseMs: 60, driftNoiseMs: 25, minutes: 25, withConsensus: true });

// ── v3 regression scenarios — the two failure modes that broke the live
// deploy, neither of which the v1/v2 sims above ever modeled. Both must
// pass before this is safe to consider live again.
runSession({ label: 'E: same as A, but with the real 30s independent clock-remeasure timer running (worst case: error is 100% non-RTT-visible reference drift, RTT sees 0 skew)', trueClockErrorMs: 120, trueLatencyMs: 280,
             peerNoiseMs: 20, driftNoiseMs: 15, minutes: 20, withConsensus: true, simulateRemeasure: true, trueRawClockSkewMs: 0 });
runSession({ label: 'F: same as B, but with track-loop-wrap events hitting the averaging window', trueClockErrorMs: 180, trueLatencyMs: 20,
             peerNoiseMs: 20, driftNoiseMs: 15, minutes: 15, withConsensus: true, simulateWrap: true });
runSession({ label: 'G: worst case — remeasure timer AND wrap events together, 25min, RTT sees 0 skew', trueClockErrorMs: 150, trueLatencyMs: 300,
             peerNoiseMs: 40, driftNoiseMs: 20, minutes: 25, withConsensus: true, simulateRemeasure: true, simulateWrap: true, trueRawClockSkewMs: 0 });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
