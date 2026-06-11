// Phase 2 — seeded "party" harness, ported from sync-sim.html, driving the
// real createSyncEngine() instances (not a transcription of the corrector).
//
// Run with: node --test 'sync/**/*.test.js'

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine, expectedPosition, wrapLag } from './sync-engine.js';

// ── Constants — mirror listener.html / sync-sim.html ─────────
const DURATION = 200;        // simulated track length, seconds
const TICK_MS = 250;         // simulated ms advanced per step
const FAST_CHECK_MS = 5000;  // fastDriftCorrect cadence

// ── Fake timers (same as sync-engine.test.js) ─────────────────
function createFakeTimers() {
  let now = 0;
  let idCounter = 1;
  const tasks = new Map();

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
    setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn,
    setInterval: setIntervalFn, clearInterval: clearIntervalFn,
    requestAnimationFrame, now: () => now, advance,
  };
}

// ── Seeded RNG — mulberry32, ported from sync-sim.html ────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Party runner ───────────────────────────────────────────────
// Builds `listenerCount` independent createSyncEngine() instances sharing
// one fake-timer event loop and a global simState { simNow, startedAt },
// then drives them through a deterministic disruption schedule (same
// probabilities as sync-sim.html). Each listener gets its own clock offset,
// BT device latency, and hardware drift — randomized imperfections that
// never go away.
function makePartyListener(rng, id, timers, simState) {
  const clockOffset = (rng() - 0.5) * 70;        // +/-35ms residual clock-sync error
  const deviceLatencyMs = 60 + rng() * 260;       // 60-320ms BT output latency
  const hwDriftPct = (rng() - 0.5) * 0.01;        // +/-0.5% hardware clock drift
  let scatterOffsetMs = 0;

  const transport = {
    duration: DURATION,
    currentTime: rng() * DURATION,
    playbackRate: 1,
    volume: 1,
    hasSrcObject: () => false,
  };
  const clock = { syncedNow: () => simState.simNow + clockOffset };
  const getContext = () => ({ playbackStartedAt: simState.startedAt, deviceLatencyMs, scatterOffsetMs });
  const getBaseRate = () => 1;
  const engine = createSyncEngine({ transport, timers, clock, getContext, getBaseRate });

  return {
    id, clockOffset, deviceLatencyMs, hwDriftPct,
    transport, engine,
    nextFastCheck: rng() * FAST_CHECK_MS,
    setScatter(ms) { scatterOffsetMs = ms; },
    dipCount: 0, warpCount: 0, hardSeekCount: 0,
    history: [],
  };
}

function currentLagMs(L, simState) {
  const elapsed = (simState.simNow + L.clockOffset - simState.startedAt) / 1000;
  const expected = expectedPosition({
    elapsedS: elapsed, duration: DURATION,
    deviceLatencyMs: L.deviceLatencyMs, scatterOffsetMs: L._scatterOffsetMs ?? 0,
  });
  return (expected - L.transport.currentTime) * 1000;
}

// Coordinated snap: cancel any in-flight correction, then jump straight to
// expectedPosition for the (possibly just-changed) reference/scatter.
function forcedSnap(L, simState) {
  L.engine.cancelDriftCorrection();
  const elapsed = (simState.simNow + L.clockOffset - simState.startedAt) / 1000;
  const expected = expectedPosition({
    elapsedS: elapsed, duration: DURATION,
    deviceLatencyMs: L.deviceLatencyMs, scatterOffsetMs: L._scatterOffsetMs ?? 0,
  });
  L.engine.seekPreservingBT(expected);
  L.hardSeekCount++;
}

// Deterministic per-event listener picker — identical regardless of run order.
function pick(ev, L, frac) {
  const x = Math.abs(Math.sin((L.id + 1) * 12.9898 + ev.r * 78.233) * 43758.5453);
  return (x - Math.floor(x)) < (frac !== undefined ? frac : ev.frac);
}

function runParty({ seed, listenerCount, totalMs, disruptRate = 1.0 }) {
  const rng = mulberry32(seed);
  const timers = createFakeTimers();
  const simState = { simNow: 0, startedAt: -1 }; // -1: truthy "just started" reference

  const listeners = Array.from({ length: listenerCount }, (_, i) => {
    const L = makePartyListener(rng, i, timers, simState);
    L._scatterOffsetMs = 0;
    return L;
  });

  // Pre-roll a deterministic disruption schedule (same shape as sync-sim.html).
  const schedule = [];
  for (let t = 5000; t < totalMs; t += 1) {
    if (rng() < 0.00006 * disruptRate) schedule.push({ t, type: 'visibilityWake' });
    if (rng() < 0.00004 * disruptRate) {
      const voices = 2 + Math.floor(rng() * 4), maxMs = 400 + rng() * 900;
      schedule.push({ t, type: 'scatterChange', voices, maxMs });
    }
    if (rng() < 0.000015 * disruptRate) schedule.push({ t, type: 'hardSync' });
    if (rng() < 0.00004 * disruptRate) {
      const frac = 0.2 + rng() * 0.5, r = rng();
      schedule.push({ t, type: 'clusterAssign', frac, r });
    }
    if (rng() < 0.00001 * disruptRate) {
      const changedFrac = 0.3 + rng() * 0.5, r = rng();
      schedule.push({ t, type: 'sceneFire', changedFrac, r });
    }
  }
  schedule.sort((a, b) => a.t - b.t);

  let idx = 0;
  for (let simNow = 0; simNow < totalMs; simNow += TICK_MS) {
    simState.simNow = simNow;
    timers.advance(TICK_MS);

    const events = {};
    while (idx < schedule.length && schedule[idx].t <= simNow) {
      const ev = schedule[idx++];
      events[ev.type] = ev;
    }

    // Coordinated reference resets — happen once per tick, before per-listener processing.
    if (events.hardSync || events.sceneFire) {
      simState.startedAt = simNow;
      for (const L of listeners) forcedSnap(L, simState);
    }
    if (events.scatterChange) {
      const { voices, maxMs } = events.scatterChange;
      for (const L of listeners) {
        L._scatterOffsetMs = Math.round(((L.id % voices) / Math.max(1, voices - 1)) * maxMs);
        L.setScatter(L._scatterOffsetMs);
        forcedSnap(L, simState);
      }
    }
    if (events.clusterAssign) {
      for (const L of listeners) {
        if (pick(events.clusterAssign, L)) forcedSnap(L, simState);
      }
    }

    for (const L of listeners) {
      // Real playback advances regardless of corrector state.
      L.transport.currentTime = (L.transport.currentTime + (TICK_MS / 1000) * L.transport.playbackRate * (1 + L.hwDriftPct) + DURATION) % DURATION;

      if (simNow >= L.nextFastCheck) {
        L.nextFastCheck += FAST_CHECK_MS;
        const lag = L.engine.computeLagMs();
        if (lag != null && Math.abs(lag) > 60) {
          const before = L.engine.getDriftState();
          L.engine.requestCorrection(lag);
          const after = L.engine.getDriftState();
          if (before !== 'ducking' && after === 'ducking') L.dipCount++;
          if (before !== 'warping' && after === 'warping') L.warpCount++;
        }
      }
      if (events.visibilityWake) {
        const lag = L.engine.computeLagMs();
        if (lag != null && Math.abs(lag) > 60) L.engine.requestCorrection(lag);
      }

      L.history.push({ t: simNow, drift: wrapLag(currentLagMs(L, simState), DURATION * 1000) });
    }
  }

  return { listeners, schedule };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ── Invariant tests (single listener, direct engine calls) ───

test('coordinated snap cancels an in-flight warp before re-seeking', () => {
  const timers = createFakeTimers();
  const transport = { duration: DURATION, currentTime: 0, playbackRate: 1, volume: 1, hasSrcObject: () => false };
  const simState = { simNow: 0, startedAt: -1 };
  const clock = { syncedNow: () => simState.simNow };
  const getContext = () => ({ playbackStartedAt: simState.startedAt, deviceLatencyMs: 0, scatterOffsetMs: 0 });
  const engine = createSyncEngine({ transport, timers, clock, getContext, getBaseRate: () => 1 });

  engine.requestCorrection(150); // -> warping, +3% rate
  assert.equal(engine.getDriftState(), 'warping');

  // DJ fires hard_sync: new reference, immediate forced snap
  simState.startedAt = 0;
  engine.cancelDriftCorrection();
  engine.seekPreservingBT(42);

  assert.equal(engine.getDriftState(), 'idle');
  assert.equal(transport.playbackRate, 1);
  assert.equal(transport.currentTime, 42);
});

test('one playback_started_at reference survives a cluster reassign — drift stays ~0 after the snap', () => {
  const timers = createFakeTimers();
  const transport = { duration: DURATION, currentTime: 50, playbackRate: 1, volume: 1, hasSrcObject: () => false };
  const simState = { simNow: 30000, startedAt: 0 }; // track started 30s ago
  const clock = { syncedNow: () => simState.simNow };
  const getContext = () => ({ playbackStartedAt: simState.startedAt, deviceLatencyMs: 0, scatterOffsetMs: 0 });
  const engine = createSyncEngine({ transport, timers, clock, getContext, getBaseRate: () => 1 });

  // Spatial reassign: NOT a reference reset — startedAt unchanged, just a
  // forced snap to the existing timeline (assigns a different stem in prod).
  const beforeStartedAt = simState.startedAt;
  engine.cancelDriftCorrection();
  const expected = expectedPosition({ elapsedS: (simState.simNow - simState.startedAt) / 1000, duration: DURATION, deviceLatencyMs: 0, scatterOffsetMs: 0 });
  engine.seekPreservingBT(expected);

  assert.equal(simState.startedAt, beforeStartedAt); // reference untouched
  const lag = engine.computeLagMs();
  assert.ok(Math.abs(lag) < 1e-6, `expected ~0 lag, got ${lag}`);
});

test('scatter offset change is applied as a forced snap, not fed through requestCorrection', () => {
  const timers = createFakeTimers();
  const transport = { duration: DURATION, currentTime: 50, playbackRate: 1, volume: 1, hasSrcObject: () => false };
  const simState = { simNow: 10000, startedAt: 0 };
  let scatterOffsetMs = 0;
  const clock = { syncedNow: () => simState.simNow };
  const getContext = () => ({ playbackStartedAt: simState.startedAt, deviceLatencyMs: 0, scatterOffsetMs });
  const engine = createSyncEngine({ transport, timers, clock, getContext, getBaseRate: () => 1 });

  // Sweep assigns this listener a 600ms offset — a multi-hundred-ms jump that
  // would trigger a ducking correction if (mis)fed to requestCorrection.
  scatterOffsetMs = 600;
  engine.cancelDriftCorrection();
  const expected = expectedPosition({ elapsedS: (simState.simNow - simState.startedAt) / 1000, duration: DURATION, deviceLatencyMs: 0, scatterOffsetMs });
  engine.seekPreservingBT(expected);

  assert.equal(engine.getDriftState(), 'idle'); // never entered 'ducking'
  assert.ok(Math.abs(engine.computeLagMs()) < 1e-6);
});

// ── Fuzz: multi-listener party, multiple seeds ────────────────
//
// Baseline assertion for the CURRENT engine (computeLagMs unwrapped — known
// defect #1 in ROADMAP.md). Despite that bug, every duck/warp resolves via
// expectedPosition (itself wrapped), so settled drift should still stay low.
// Phase 3 should be able to TIGHTEN these bounds (and add a duck-count
// assertion) once the lag-wrap fix lands — it should not need to loosen them.
for (const seed of [1, 2, 3]) {
  test(`party seed=${seed}: settled drift stays low across a 2-minute set`, () => {
    const { listeners } = runParty({ seed, listenerCount: 6, totalMs: 120000, disruptRate: 1.0 });

    for (const L of listeners) {
      // Skip the startup window: each listener begins at a random position
      // (representing an unsynced phone before the engine has run at all),
      // and the first fastDriftCorrect + duck takes up to ~FAST_CHECK_MS +
      // 2.5s to resolve it.
      const settled = L.history.filter(p => p.t > 2 * FAST_CHECK_MS).map(p => Math.abs(p.drift));
      const p50 = median(settled);
      const max = Math.max(...settled);

      // The corrector only checks every FAST_CHECK_MS (5s) and corrects to
      // <15ms; between checks, residual clock offset + ~0.5% hw drift grow
      // a sawtooth of up to ~tens of ms. 150ms is the current baseline —
      // Phase 3 (rate-aware BPM warp, lag wrap) may tighten this, but
      // shouldn't need to loosen it.
      assert.ok(p50 < 150, `listener ${L.id}: median |drift| ${p50.toFixed(1)}ms >= 150ms`);
      assert.ok(max < 2500, `listener ${L.id}: max |drift| ${max.toFixed(1)}ms >= 2500ms (a full duck-cycle's worth — something didn't converge)`);
    }
  });
}
