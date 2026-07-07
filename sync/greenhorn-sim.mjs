#!/usr/bin/env node
// greenhorn-sim.mjs — offline validation of the greenhorn fast-cal lane
// (oracle 14.2→30) in ternary/layer.js. Runs the REAL layer.js in a vm
// sandbox with a simulated clock, a simulated device latency model, and a
// simulated drift signal — including the calibration loop the 2026-07-07
// master-clock sim famously lacked.
//
// Scenarios:
//   1. plain      — greenhorn, true floor 350ms, quiet room
//   2. deadlock   — greenhorn snapping every ~8s (auto-cal can never run)
//   3. prior      — greenhorn joins a room with 2 settled same-model peers
//   4. tight      — greenhorn whose floor is already <25ms (should stand down)
//   5. veteran    — stored latency present (greenhorn lane must stay dark)
//
// Usage: node sync/greenhorn-sim.mjs

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
    emit: (event, payload) => handlers[event]?.({ payload }),
    deviceLatencyMs: 0,
    adjustCalls: [],
    now: () => simNow,
    advance: (ms) => {
      simNow += ms;
      for (const t of timers) {
        if (!t.interval) continue;
        while (simNow >= t.next) { t.next += t.every; t.fn(); }
      }
    },
    calEvents,
    timers,
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
    setInterval: (fn, every) => { timers.push({ fn, every, next: simNow + every, interval: true }); return timers.length; },
    clearInterval: () => {},
    setTimeout: (fn) => { fn(); },
    clearTimeout: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(layerSrc, sandbox);
  return { state, window, sandbox };
}

const MODEL = 'Linux; Android 13; Pixel 7';

// Drift model: measured lag = trueFloor − appliedLatency + noise.
function lag(trueFloor, state, noise = 15) {
  return trueFloor - state.deviceLatencyMs + (Math.random() * 2 - 1) * noise;
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// ── Scenario 1: plain greenhorn, floor 350ms ────────────────────────────────
{
  console.log('\n[1] plain greenhorn, true floor 350ms, quiet room');
  const { state, window } = makeSandbox({ wasStored: false, model: MODEL });
  const t0 = state.now();
  for (let i = 0; i < 40; i++) {           // 100s of 2.5s ticks
    state.advance(2500);
    window._terLayer.tick(lag(350, state));
  }
  const fired = state.adjustCalls.length >= 1;
  const firstAt = fired ? (state.adjustCalls[0].t - t0) / 1000 : null;
  check('bold correction fired once', state.adjustCalls.length === 1, `calls=${state.adjustCalls.length}`);
  check('fired within 30s', fired && firstAt <= 30, `at ${firstAt}s`);
  check('landed near 350ms', fired && Math.abs(state.deviceLatencyMs - 350) < 40, `latency=${Math.round(state.deviceLatencyMs)}ms`);
  check('greenhorn event broadcast', state.calEvents.some(e => e.kind === 'ter_greenhorn_cal'));
}

// ── Scenario 2: snap↔cal deadlock — disturbance every ~8s ───────────────────
{
  console.log('\n[2] deadlock greenhorn: snap (>120ms jump) every ~7.5s, floor 200ms');
  const { state, window } = makeSandbox({ wasStored: false, model: MODEL });
  const t0 = state.now();
  let tickN = 0;
  for (let i = 0; i < 60; i++) {           // 150s
    state.advance(2500);
    tickN++;
    // every 3rd tick a snap lands: lag collapses to ~0 then rebuilds — the
    // tick-to-tick jump >120ms marks a disturbance each time.
    const phase = tickN % 3;
    const l = phase === 0 ? 0 + (Math.random() * 10)               // just snapped
            : lag(200, state, 10);                                  // rebuilt to floor
    window._terLayer.tick(l);
  }
  // With ≤7.5s between disturbances, auto-cal (needs 10s calm) never samples.
  // Greenhorn (needs 2s calm) gets the phase-1/2 samples.
  const fired = state.adjustCalls.length >= 1;
  check('greenhorn fired despite snap storm', fired, `calls=${state.adjustCalls.length}`);
  if (fired) {
    const firstAt = (state.adjustCalls[0].t - t0) / 1000;
    check('fired within 90s', firstAt <= 90, `at ${firstAt}s`);
    check('correction is floor-sign, meaningful', state.adjustCalls[0].delta > 60, `delta=${Math.round(state.adjustCalls[0].delta)}ms`);
  }
}

// ── Scenario 3: crowd prior — 2 settled same-model peers at 300ms ──────────
{
  console.log('\n[3] crowd prior: 2 settled same-model peers @300ms, own floor 300ms');
  const { state, window } = makeSandbox({ wasStored: false, model: MODEL });
  const t0 = state.now();
  for (const [id, ms] of [['ter_peer01', 295], ['ter_peer02', 305]]) {
    state.emit('trit', { deviceId: id, trit: 1, lagMs: 5, octoState: 1, ts: state.now(),
                         model: MODEL, latencyMs: ms, calSettled: true });
  }
  // First non-entry tick should apply the prior immediately.
  state.advance(2500);
  window._terLayer.tick(lag(300, state));
  const priorAt = state.adjustCalls.length ? (state.adjustCalls[0].t - t0) / 1000 : null;
  check('prior applied on first tick', state.adjustCalls.length === 1 && priorAt < 5, `at ${priorAt}s, latency=${Math.round(state.deviceLatencyMs)}ms`);
  check('seeded near peer median 300ms', Math.abs(state.deviceLatencyMs - 300) < 20, `latency=${Math.round(state.deviceLatencyMs)}ms`);
  check('prior event broadcast', state.calEvents.some(e => e.kind === 'ter_crowd_prior'));
  // Continue quiet — residual is now <25ms, greenhorn should stand down w/o a 2nd correction.
  for (let i = 0; i < 30; i++) { state.advance(2500); window._terLayer.tick(lag(300, state, 8)); }
  check('no second correction (stood down)', state.adjustCalls.length === 1, `calls=${state.adjustCalls.length}`);
}

// ── Scenario 4: already-tight greenhorn (floor 10ms) ───────────────────────
{
  console.log('\n[4] tight greenhorn: floor 10ms — must stand down, zero corrections');
  const { state, window } = makeSandbox({ wasStored: false, model: MODEL });
  for (let i = 0; i < 40; i++) { state.advance(2500); window._terLayer.tick(lag(10, state, 5)); }
  check('no correction fired', state.adjustCalls.length === 0, `calls=${state.adjustCalls.length}`);
}

// ── Scenario 5: veteran (stored latency) — greenhorn lane dark ─────────────
{
  console.log('\n[5] veteran: stored latency present, floor 350ms — greenhorn must NOT fire');
  const { state, window } = makeSandbox({ wasStored: true, model: MODEL });
  state.deviceLatencyMs = 340;
  for (let i = 0; i < 40; i++) { state.advance(2500); window._terLayer.tick(lag(350, state, 10)); }
  const green = state.calEvents.filter(e => e.kind === 'ter_greenhorn_cal');
  check('no greenhorn event', green.length === 0, `events=${green.length}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
