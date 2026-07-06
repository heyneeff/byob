// Phase 1 smoke tests for sync/sync-engine.js — run with:
//   node --test 'sync/**/*.test.js'
//
// These pin the verbatim port against the corrector behavior described in
// CLAUDE.md / SYNC_ENGINE.md. Phase 2 expands this into the full seeded-party
// harness (ported from sync-sim.html); Phase 3 adds tests for defects #1
// (lag wrap), #3 (BPM-warp position math), and #5 (duck cancellation token).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSyncEngine,
  expectedPosition,
  computeSeekTime,
  computeClockOffset,
  bpmWarpRate,
  wrapLag,
  microCorrectionRate,
  MICRO_GAIN_PER_MS,
  MICRO_MAX_PCT,
  SEEK_STAB_S,
} from './sync-engine.js';

// ── Fake timers ──────────────────────────────────────────────
// Manual virtual clock: setTimeout/setInterval queue tasks at a target
// "now"; advance(ms) runs every due task (including repeating intervals)
// in time order, so duck/warp sequences resolve deterministically.
function createFakeTimers() {
  let now = 0;
  let idCounter = 1;
  const tasks = new Map(); // id -> { time, fn, interval }

  function setTimeoutFn(fn, delay) {
    const id = idCounter++;
    tasks.set(id, { time: now + delay, fn, interval: null });
    return id;
  }
  function clearTimeoutFn(id) { tasks.delete(id); }
  function setIntervalFn(fn, delay) {
    const id = idCounter++;
    tasks.set(id, { time: now + delay, fn, interval: delay });
    return id;
  }
  function clearIntervalFn(id) { tasks.delete(id); }
  function requestAnimationFrame(fn) {
    return setTimeoutFn(() => fn(now), 16);
  }
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      let earliestId = null;
      for (const [id, t] of tasks) {
        if (t.time <= target && (earliestId === null || t.time < tasks.get(earliestId).time)) earliestId = id;
      }
      if (earliestId === null) break;
      const t = tasks.get(earliestId);
      now = t.time;
      if (t.interval != null) {
        t.time = now + t.interval;
        t.fn();
      } else {
        tasks.delete(earliestId);
        t.fn();
      }
    }
    now = target;
  }

  return {
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    requestAnimationFrame,
    now: () => now,
    advance,
  };
}

function createFakeTransport(overrides = {}) {
  return Object.assign({
    duration: 200,
    currentTime: 0,
    playbackRate: 1,
    volume: 1,
    hasSrcObject: () => false,
  }, overrides);
}

function noWarp(timers) {
  return {
    transport: createFakeTransport(),
    timers,
    clock: { syncedNow: () => timers.now() },
    getContext: () => ({ playbackStartedAt: null, deviceLatencyMs: 0, scatterOffsetMs: 0 }),
    getBaseRate: () => 1,
  };
}

// ── Pure math ────────────────────────────────────────────────

test('expectedPosition wraps into [0, duration)', () => {
  const pos = expectedPosition({ elapsedS: -1, duration: 200, deviceLatencyMs: 0, scatterOffsetMs: 0 });
  assert.ok(pos >= 0 && pos < 200, `expected pos in [0,200), got ${pos}`);
});

test('computeSeekTime: startedAt path applies all four terms', () => {
  const startedAt = new Date(0).toISOString();
  const seek = computeSeekTime({
    startedAt, playAt: undefined, playFromS: undefined,
    syncedNowMs: 10000, // 10s elapsed
    deviceLatencyMs: 100, scatterOffsetMs: 50,
  });
  // elapsed=10, seekTo = 10 - 0.1 + SEEK_STAB_S - 0.05
  assert.ok(Math.abs(seek - (10 - 0.1 + SEEK_STAB_S - 0.05)) < 1e-9);
});

test('computeSeekTime: play_at path applies latency/scatter compensation', () => {
  const seek = computeSeekTime({
    startedAt: undefined, playAt: 5000, playFromS: 0,
    syncedNowMs: 10000, // play_at 5s in the past
    deviceLatencyMs: 100, scatterOffsetMs: 50,
  });
  // seekTo = 0 + SEEK_STAB_S - 0.1 - 0.05 + 5 (elapsed past play_at)
  assert.ok(Math.abs(seek - (SEEK_STAB_S - 0.1 - 0.05 + 5)) < 1e-9);
});

test('computeSeekTime: past play_at agrees with startedAt branch when startedAt == play_at', () => {
  // Scheduled synced entry future-dates playback_started_at = play_at. Any
  // later re-anchor may take either branch — they must land identically or
  // the corrector fights the re-anchor at a constant per-device offset
  // (the 2026-07-06 roving regression: stuck 307/398/666ms drifts).
  const playAtMs = 60_000, nowMs = 90_000;
  const viaPlayAt = computeSeekTime({
    startedAt: undefined, playAt: playAtMs, playFromS: 0,
    syncedNowMs: nowMs, deviceLatencyMs: 398, scatterOffsetMs: 0,
  });
  const viaStartedAt = computeSeekTime({
    startedAt: new Date(playAtMs).toISOString(), playAt: undefined, playFromS: undefined,
    syncedNowMs: nowMs, deviceLatencyMs: 398, scatterOffsetMs: 0,
  });
  assert.ok(Math.abs(viaPlayAt - viaStartedAt) < 1e-9,
    `branches disagree: play_at=${viaPlayAt} startedAt=${viaStartedAt}`);
});

test('computeClockOffset: rejects RTT >= 400ms, returns median of the rest', () => {
  const samples = [
    { t0: 0, t1: 100, serverMs: 1000 }, // rtt 100 -> offset 950
    { t0: 0, t1: 600, serverMs: 2000 }, // rtt 600 -> rejected
    { t0: 0, t1: 200, serverMs: 1100 }, // rtt 200 -> offset 1000
  ];
  assert.equal(computeClockOffset(samples), 1000);
});

test('computeClockOffset: returns null if every sample is rejected', () => {
  assert.equal(computeClockOffset([{ t0: 0, t1: 500, serverMs: 1000 }]), null);
});

test('bpmWarpRate: 1.0 when either BPM is unknown, clamped to [0.25, 4.0] otherwise', () => {
  assert.equal(bpmWarpRate(null, 120), 1.0);
  assert.equal(bpmWarpRate(120, null), 1.0);
  assert.equal(bpmWarpRate(120, 120), 1);
  assert.equal(bpmWarpRate(1000, 120), 4.0);
  assert.equal(bpmWarpRate(30, 120), 0.25);
});

// ── Drift corrector state machine ───────────────────────────

test('requestCorrection: |lag| < 15ms is ignored, state idle, base rate restored', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  ctx.transport.playbackRate = 1.03;
  const engine = createSyncEngine(ctx);

  engine.requestCorrection(10);

  assert.equal(engine.getDriftState(), 'idle');
  assert.equal(ctx.transport.playbackRate, 1);
});

test('requestCorrection: 15-500ms enters "warping", restores base rate after the correction window', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  const engine = createSyncEngine(ctx);

  engine.requestCorrection(150); // positive lag -> speed up by 3%
  assert.equal(engine.getDriftState(), 'warping');
  assert.equal(ctx.transport.playbackRate, 1.03);

  timers.advance(150 / 0.03 + 1);
  assert.equal(engine.getDriftState(), 'idle');
  assert.equal(ctx.transport.playbackRate, 1);
});

test('requestCorrection: a new request during "warping" recomputes immediately (never deferred)', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  const engine = createSyncEngine(ctx);

  engine.requestCorrection(150); // -> warping, +3%
  assert.equal(ctx.transport.playbackRate, 1.03);

  engine.requestCorrection(-150); // recompute immediately -> -3%, still warping
  assert.equal(engine.getDriftState(), 'warping');
  assert.equal(ctx.transport.playbackRate, 0.97);
});

test('requestCorrection: |lag| > 500ms enters "ducking", seeks and settles to idle', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  ctx.transport.currentTime = 10;
  const engine = createSyncEngine(ctx);

  engine.requestCorrection(600);
  assert.equal(engine.getDriftState(), 'ducking');

  // 1500ms duck-down + 80ms pause + 1000ms duck-up
  timers.advance(2600);

  assert.equal(engine.getDriftState(), 'idle');
  assert.equal(ctx.transport.volume, 1);
});

test('requestCorrection during "ducking" sets driftPendingRecheck, cleared by settleToIdle', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  ctx.transport.currentTime = 10;
  const engine = createSyncEngine(ctx);

  engine.requestCorrection(600); // -> ducking
  engine.requestCorrection(20);  // deferred — ducking wins
  assert.equal(engine.getDriftPendingRecheck(), true);
  assert.equal(engine.getDriftState(), 'ducking');

  timers.advance(2600);
  assert.equal(engine.getDriftPendingRecheck(), false);
});

test('cancelDriftCorrection resets state, clears pending recheck, restores base rate', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  const engine = createSyncEngine(ctx);

  engine.requestCorrection(150); // -> warping
  engine.cancelDriftCorrection();

  assert.equal(engine.getDriftState(), 'idle');
  assert.equal(engine.getDriftPendingRecheck(), false);
  assert.equal(ctx.transport.playbackRate, 1);
});

test('computeLagMs returns null without a playback reference, duration, or while WebRTC live', () => {
  const timers = createFakeTimers();

  const noStartedAt = noWarp(timers);
  assert.equal(createSyncEngine(noStartedAt).computeLagMs(), null);

  const liveCtx = noWarp(timers);
  liveCtx.transport.hasSrcObject = () => true;
  liveCtx.getContext = () => ({ playbackStartedAt: -1000, deviceLatencyMs: 0, scatterOffsetMs: 0 });
  assert.equal(createSyncEngine(liveCtx).computeLagMs(), null);

  const noDuration = noWarp(timers);
  noDuration.transport.duration = 0;
  noDuration.getContext = () => ({ playbackStartedAt: -1000, deviceLatencyMs: 0, scatterOffsetMs: 0 });
  assert.equal(createSyncEngine(noDuration).computeLagMs(), null);
});

test('computeLagMs matches expectedPosition - currentTime', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  ctx.transport.duration = 200;
  ctx.transport.currentTime = 5;
  // playbackStartedAt must be non-zero (0 is falsy and reads as "no reference")
  ctx.getContext = () => ({ playbackStartedAt: -10000, deviceLatencyMs: 0, scatterOffsetMs: 0 });
  // syncedNow() = timers.now() = 0 here, so elapsed = (0 - (-10000)) / 1000 = 10s

  const engine = createSyncEngine(ctx);
  const lagMs = engine.computeLagMs();
  const expected = expectedPosition({ elapsedS: 10, duration: 200, deviceLatencyMs: 0, scatterOffsetMs: 0 });
  assert.ok(Math.abs(lagMs - (expected - 5) * 1000) < 1e-9);
});

// ── Phase 3: defect #1 — lag wrap at the track boundary ───────

test('wrapLag: a near-full-track lag wraps to a small lag the other direction', () => {
  // expected 199.9s, actual 0.1s on a 200s track -> raw lag ~ -199.8s,
  // which should wrap to ~+0.2s (a tiny lag), not read as a near-full-track desync.
  const wrapped = wrapLag((199.9 - 0.1) * -1000, 200000);
  assert.ok(Math.abs(wrapped - 200) < 1e-6, `expected ~200ms, got ${wrapped}`);
});

test('computeLagMs wraps a near-loop-point lag to a small value, not a near-full-track one', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  ctx.transport.duration = 200;
  ctx.transport.currentTime = 0.1; // just past the loop point
  ctx.getContext = () => ({ playbackStartedAt: -199900, deviceLatencyMs: 0, scatterOffsetMs: 0 });
  // elapsed = 199.9s -> expected = expectedPosition(199.9 + SEEK_STAB_S, ...) wraps near 0,
  // so raw (expected - currentTime) is near -199.8s -- should wrap to a small positive value.

  const engine = createSyncEngine(ctx);
  const lagMs = engine.computeLagMs();
  assert.ok(Math.abs(lagMs) < 1000, `expected a small wrapped lag, got ${lagMs}ms`);
});

// ── Phase 3: defect #3 — BPM-warp-aware position math ─────────

test('expectedPosition: warpRate scales elapsed time before wrapping', () => {
  // At 2x rate, track position advances twice as fast as wall-clock elapsed time.
  const rate1 = expectedPosition({ elapsedS: 10, duration: 200, deviceLatencyMs: 0, scatterOffsetMs: 0, warpRate: 1 });
  const rate2 = expectedPosition({ elapsedS: 10, duration: 200, deviceLatencyMs: 0, scatterOffsetMs: 0, warpRate: 2 });
  assert.ok(Math.abs(rate2 - rate1 * 2) < 1e-9, `expected rate2 (${rate2}) ~= 2x rate1 (${rate1})`);
});

test('computeLagMs uses getBaseRate() as the warpRate', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  ctx.transport.duration = 200;
  ctx.transport.currentTime = 5;
  ctx.getContext = () => ({ playbackStartedAt: -10000, deviceLatencyMs: 0, scatterOffsetMs: 0 });
  ctx.getBaseRate = () => 2; // master BPM warp at 2x

  const engine = createSyncEngine(ctx);
  const lagMs = engine.computeLagMs();
  const expected = expectedPosition({ elapsedS: 10, duration: 200, deviceLatencyMs: 0, scatterOffsetMs: 0, warpRate: 2 });
  assert.ok(Math.abs(lagMs - (expected - 5) * 1000) < 1e-9);
});

test('requestCorrection: warp correction duration scales inversely with baseRate', () => {
  const timers1 = createFakeTimers();
  const ctx1 = noWarp(timers1);
  const engine1 = createSyncEngine(ctx1);
  engine1.requestCorrection(150);
  assert.equal(ctx1.transport.playbackRate, 1.03);
  timers1.advance(150 / 0.03 + 1);
  assert.equal(engine1.getDriftState(), 'idle');

  // At 2x base rate, the same |lagMs| should resolve in half the wall-clock time.
  const timers2 = createFakeTimers();
  const ctx2 = noWarp(timers2);
  ctx2.getBaseRate = () => 2;
  const engine2 = createSyncEngine(ctx2);
  engine2.requestCorrection(150);
  assert.equal(ctx2.transport.playbackRate, 2 * 1.03);

  timers2.advance(150 / (0.03 * 2) - 1);
  assert.equal(engine2.getDriftState(), 'warping', 'should not have settled yet');

  timers2.advance(2);
  assert.equal(engine2.getDriftState(), 'idle');
  assert.equal(ctx2.transport.playbackRate, 2);
});

// ── Phase 3: defect #5 — cancelDriftCorrection invalidates an in-flight duck ──

test('cancelDriftCorrection during ducking prevents the orphaned duck from re-seeking or settling again', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  ctx.transport.currentTime = 10;
  const engine = createSyncEngine(ctx);

  engine.requestCorrection(600); // -> ducking, ramp-down begins
  assert.equal(engine.getDriftState(), 'ducking');

  // Partway through the ramp-down, a coordinated snap arrives.
  timers.advance(750); // halfway through the 1500ms duck-down
  engine.cancelDriftCorrection();
  assert.equal(engine.getDriftState(), 'idle');
  assert.equal(ctx.transport.playbackRate, 1);

  // The DJ-commanded snap takes over.
  ctx.transport.volume = 1;
  ctx.transport.currentTime = 42;
  engine.seekPreservingBT(42);

  // Advance past when the orphaned duck's remaining timers would have fired
  // (ramp-down completion, 80ms pause, ramp-up, 5s safety timeout).
  timers.advance(6000);

  // The orphaned duck must not have re-seeked or dipped the volume again.
  assert.equal(ctx.transport.currentTime, 42, 'orphaned duck must not overwrite the snap seek');
  assert.equal(ctx.transport.volume, 1, 'orphaned duck must not dip volume after cancellation');
  assert.equal(engine.getDriftState(), 'idle');
});

// ── Phase 5r: micro-rate correction ────────────────────────────────────────

test('microCorrectionRate: zero lag returns baseRate unchanged', () => {
  assert.equal(microCorrectionRate(0, 1), 1);
  assert.equal(microCorrectionRate(0, 2), 2);
});

test('microCorrectionRate: positive lag (behind) speeds up, negative (ahead) slows down', () => {
  assert.ok(microCorrectionRate(50, 1) > 1);
  assert.ok(microCorrectionRate(-50, 1) < 1);
});

test('microCorrectionRate: scales linearly with lagMs via MICRO_GAIN_PER_MS below the cap', () => {
  const lagMs = 10; // 10 * MICRO_GAIN_PER_MS = 0.002, well under MICRO_MAX_PCT
  assert.ok(Math.abs(MICRO_GAIN_PER_MS * lagMs) < MICRO_MAX_PCT);
  const rate = microCorrectionRate(lagMs, 1);
  assert.ok(Math.abs(rate - (1 + MICRO_GAIN_PER_MS * lagMs)) < 1e-12);
});

test('microCorrectionRate: clamps to +/-MICRO_MAX_PCT for large lag', () => {
  assert.equal(microCorrectionRate(100000, 1), 1 + MICRO_MAX_PCT);
  assert.equal(microCorrectionRate(-100000, 1), 1 - MICRO_MAX_PCT);
});

test('microCorrectionRate: scales with baseRate (BPM warp)', () => {
  const rate = microCorrectionRate(10, 2);
  assert.ok(Math.abs(rate - 2 * (1 + 10 * MICRO_GAIN_PER_MS)) < 1e-12);
});

test('applyMicroCorrection: trims playbackRate around baseRate while idle', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  const engine = createSyncEngine(ctx);

  engine.applyMicroCorrection(10); // below the cap (10 * MICRO_GAIN_PER_MS < MICRO_MAX_PCT)
  assert.equal(engine.getDriftState(), 'idle');
  assert.ok(Math.abs(ctx.transport.playbackRate - (1 + 10 * MICRO_GAIN_PER_MS)) < 1e-12);
});

test('applyMicroCorrection: does not fight an in-flight warp/duck (no-op unless idle)', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  const engine = createSyncEngine(ctx);

  engine.requestCorrection(600); // -> ducking
  assert.equal(engine.getDriftState(), 'ducking');
  const rateDuringDuck = ctx.transport.playbackRate;

  engine.applyMicroCorrection(50);
  assert.equal(ctx.transport.playbackRate, rateDuringDuck, 'micro correction must not touch playbackRate mid-duck');
});

// ── Phase 5r: a constant hardware clock-rate error converges toward 0,
// not just toward the snap threshold ──────────────────────────────────────

test('micro correction converges a constant hardware-drift lag toward 0 over time', () => {
  const timers = createFakeTimers();
  const ctx = noWarp(timers);
  ctx.transport.duration = 200;
  ctx.transport.currentTime = 0;
  const startedAt = -1; // computeLagMs treats 0 as "no reference yet" (see sync-sim.html)
  const hwDriftPct = 0.005; // worst-case +/-0.5% modeled in sync-sim.html
  ctx.getContext = () => ({ playbackStartedAt: startedAt, deviceLatencyMs: 0, scatterOffsetMs: 0 });
  const engine = createSyncEngine(ctx);

  const TICK_MS = 5000; // fastDriftCorrect cadence
  let lagMs = engine.computeLagMs();
  const history = [lagMs];
  for (let t = 0; t < 600000; t += TICK_MS) { // 10 simulated minutes
    // advance playback at the current (possibly trimmed) rate, with the
    // device's constant hardware clock-rate error applied
    ctx.transport.currentTime = (ctx.transport.currentTime + (TICK_MS / 1000) * ctx.transport.playbackRate * (1 + hwDriftPct) + ctx.transport.duration) % ctx.transport.duration;
    timers.advance(TICK_MS);
    lagMs = engine.computeLagMs();
    engine.applyMicroCorrection(lagMs);
    history.push(lagMs);
  }

  // Steady state (last quarter of the run) should sit close to 0 — well
  // under the old 300ms snap threshold, and under the ~50ms target —
  // converging from the initial ~190ms SEEK_STAB_S offset.
  assert.ok(Math.abs(history[0]) > 100, `expected a real initial offset to converge from, got ${history[0]}`);
  const steady = history.slice(-30);
  const maxAbsSteady = Math.max(...steady.map(Math.abs));
  assert.ok(maxAbsSteady < 50, `expected steady-state |lag| < 50ms, got ${maxAbsSteady}`);
});
