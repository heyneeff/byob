// Phase 1 smoke tests for sync/sync-engine.js — run with:
//   node --test sync/
//
// These pin the verbatim port against the corrector behavior described in
// CLAUDE.md / SYNC_ENGINE.md. Phase 2 expands this into the full seeded-party
// harness (ported from sync-sim.html); Phase 3 adds failing tests for the
// known bugs (lag wrap, BPM-warp position math) before fixing them.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSyncEngine,
  expectedPosition,
  computeSeekTime,
  computeClockOffset,
  bpmWarpRate,
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
