#!/usr/bin/env node
// octonary-cascade-sim.mjs — offline validation of the NTP/PTP-stratum-style
// cascade anchor design, NOW PORTED FOR REAL into ternary/layer.js (see
// "OCTONARY CASCADE CONSENSUS" section there). This sim exercises ONLY the
// real internal maybeCascadeCorrect()/pickCascadeAnchor() via tick() — no
// external duplicate logic. (An earlier version of this file had its own
// parallel pickAnchor/maybeCascadeCorrect implementation for pre-port design
// validation; once the real code was ported into layer.js, that duplicate
// was firing ALONGSIDE the real one every tick — silently double-correcting
// and invalidating the "ALL PASS" result from that run. Removed entirely.)
//
// Design: instead of a flat weighted median of all peers (room-consensus
// v3's approach, see room-consensus-sim.mjs), each device locks onto its
// single highest-octonary-weight visible peer and corrects toward THAT
// peer's refMs — a flagship emerges naturally as the room's true reference,
// trust propagates outward one hop at a time, exactly like NTP stratum
// 0→1→2... Motivated by real CSV evidence
// (byob-obs-2026-07-14T17-37-57-018Z.csv): one device was the lowest/most-
// reference-like refMs in 106/106 five-second windows across a whole
// session — a stable natural flagship nothing in the flat-median approach
// recognized or used.
//
// NO DJ participation in this port (deliberately deferred — would need
// bridge.mjs changes, a different/riskier file — see TUNING_LOG.md). Only
// phone-to-phone cascade scenarios here.
//
// Runs MULTIPLE independent copies of the REAL ternary/layer.js (one per
// simulated device) sharing one wall clock, exchanging trit+refMs broadcasts
// through an in-process bus.
//
// Usage: node sync/octonary-cascade-sim.mjs

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const layerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../ternary/layer.js'), 'utf8');

// ── One shared wall clock for the whole room ────────────────────────────────
const INITIAL_CLOCK_MS = 1_000_000;
const INITIAL_CURRENT_TIME_S = 10;

function makeClock() {
  let now = INITIAL_CLOCK_MS;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

// ── One simulated device: real layer.js + a tiny local audio/clock model ───
function makeDevice(id, { clock, trueClockErrorMs, trueLatencyMs, model = 'Linux; Android 13; Pixel 7' }) {
  const handlers = {};
  const outbox = [];
  let clockOffsetMs = 0;
  let deviceLatencyMs = 0;
  const adjustCalls = [];
  let currentTime = INITIAL_CURRENT_TIME_S;
  const duration = 300;

  function ownRefMs() {
    return (clock.now() + clockOffsetMs) - (currentTime - deviceLatencyMs / 1000) * 1000;
  }

  const chan = {
    on(type, filter, handler) { handlers[filter?.event] = handler; return chan; },
    subscribe() { return chan; },
    send(msg) { if (msg?.event === 'trit') outbox.push({ from: id, event: 'trit', payload: msg.payload }); },
  };

  const window = {
    db: { channel: () => chan },
    listenerId: id,
    _debugChannel: chan,
    _terLatencyWasStored: true, // veteran — greenhorn lane isn't what's under test here
    _terGetDeviceLatencyMs: () => deviceLatencyMs,
    _terAdjustLatency: (delta) => {
      const prev = deviceLatencyMs;
      deviceLatencyMs = Math.max(0, Math.min(1200, deviceLatencyMs + delta));
      adjustCalls.push({ t: clock.now(), delta, result: deviceLatencyMs });
      return deviceLatencyMs - prev;
    },
    _terGetZone: () => ({ playback_started_at: new Date(0).toISOString() }),
    SyncEngine: { isEntryPhase: () => false, getDriftState: () => 'idle' },
    _audio: { get currentTime() { return currentTime; }, duration, playbackRate: 1 },
    syncedNow: () => clock.now() + clockOffsetMs,
    activeZone: { name: 'sim' },
    _terAdjustClockOffset: (deltaMs) => {
      const prev = clockOffsetMs;
      clockOffsetMs += deltaMs;
      return clockOffsetMs - prev;
    },
  };
  window.window = window;

  const sandbox = {
    window,
    document: { readyState: 'complete', createElement: () => ({ style: {}, appendChild(){} }),
                getElementById: () => null, body: { appendChild(){} }, addEventListener(){} },
    navigator: { userAgent: `Mozilla/5.0 (${model}) SimKit/1.0` },
    console: { log: (...a) => { if (process.env.DEBUG_CASCADE) console.error('   [layer.js]', ...a); }, warn: () => {} },
    Date: { now: () => clock.now() },
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: (fn) => { fn(); }, clearTimeout: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(layerSrc, sandbox);

  return {
    id, handlers, outbox, window,
    get clockOffsetMs() { return clockOffsetMs; },
    get deviceLatencyMs() { return deviceLatencyMs; },
    adjustCalls, ownRefMs,
    tick() {
      const residual = (trueClockErrorMs - clockOffsetMs) + (trueLatencyMs - deviceLatencyMs);
      const lagMs = residual + (Math.random() * 2 - 1) * 8; // small measurement noise
      currentTime += 2.5;
      window._terLayer.tick(lagMs); // real tick() — internally calls the real maybeCascadeCorrect
    },
  };
}

function deliverBus(devices) {
  for (const d of devices) {
    for (const msg of d.outbox) {
      for (const other of devices) {
        if (other.id === d.id) continue;
        other.handlers['trit']?.({ payload: msg.payload });
      }
    }
    d.outbox.length = 0;
  }
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

function runScenario({ label, minutes, deviceSpecs }) {
  console.log(`\n[${label}] ${deviceSpecs.length} devices, ${minutes}min`);
  const clock = makeClock();
  const devices = deviceSpecs.map((spec, i) => makeDevice(`d${i}`, { clock, ...spec }));

  const totalTicks = Math.round(minutes * 60 / 2.5);
  const history = [];
  for (let i = 0; i < totalTicks; i++) {
    clock.advance(2500);
    for (const d of devices) d.tick();
    deliverBus(devices);
    if (i % 24 === 0) {
      const refs = devices.map(d => d.ownRefMs());
      const spread = Math.max(...refs) - Math.min(...refs);
      history.push({ minute: Math.round(i * 2.5 / 60), spread, lats: devices.map(d => Math.round(d.deviceLatencyMs)) });
    }
  }

  console.log('  minute-by-minute room spread (max-min refMs across devices):');
  history.forEach(h => console.log(`    m${h.minute}: spread=${h.spread.toFixed(0)}ms  latencies=[${h.lats.join(',')}]`));

  const finalRefs = devices.map(d => d.ownRefMs());
  const finalSpread = Math.max(...finalRefs) - Math.min(...finalRefs);
  const last3 = history.slice(-3).map(h => h.spread);
  const spreadHeld = Math.max(...last3) - Math.min(...last3);
  const anchorChoices = devices.map(d => d.window._terLayer.getCascadeAnchorId());

  console.log(`  final anchor choices: ${anchorChoices.join(', ')}`);
  check('room spread converges under 100ms', finalSpread < 100, `spread=${finalSpread.toFixed(0)}ms`);
  check('spread holds steady in final 3 checkpoints (<40ms wobble)', spreadHeld < 40, `wobble=${spreadHeld.toFixed(0)}ms`);
  check('no device latency ran away past the cap', devices.every(d => d.deviceLatencyMs <= 1200), '');

  return { finalSpread };
}

runScenario({
  label: 'A: real-CSV shape — one flagship (0 error), two others at stable +1300ms/+400ms-class bias',
  minutes: 20,
  deviceSpecs: [
    { trueClockErrorMs: 0,    trueLatencyMs: 40 },
    { trueClockErrorMs: 1300, trueLatencyMs: 200 },
    { trueClockErrorMs: 420,  trueLatencyMs: 350 },
  ],
});

runScenario({
  label: 'B: four devices, no clear flagship yet (all mid-range errors)',
  minutes: 20,
  deviceSpecs: [
    { trueClockErrorMs: 150, trueLatencyMs: 100 },
    { trueClockErrorMs: 220, trueLatencyMs: 180 },
    { trueClockErrorMs: 90,  trueLatencyMs: 260 },
    { trueClockErrorMs: 300, trueLatencyMs: 60 },
  ],
});

runScenario({
  label: 'D: one badly-broken device (latency-capped, 1200ms) should NOT be chosen as anchor',
  minutes: 20,
  deviceSpecs: [
    { trueClockErrorMs: 0,    trueLatencyMs: 60 },
    { trueClockErrorMs: 3200, trueLatencyMs: 1200 },
  ],
});

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
