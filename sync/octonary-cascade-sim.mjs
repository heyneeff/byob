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
// bridge.mjs changes, a different/riskier file — see TUNING_LOG.md).
// Scenarios A/B/D are phone-to-phone only.
//
// Scenarios E/F/G (added for the master-rooted design, roadmap Phase 1 /
// cast 61.4.5→38 "the team horse follows its master"): a synthetic MASTER
// bus participant models the bridge publishing its own refMs on the trit
// channel. E: master at ANCHORING weight (2.0 — deliverable with zero
// layer.js changes). F: adversarial tie — a confidently-wrong phone reaches
// ANCHORING and is seen FIRST, so at equal weight it wins pickCascadeAnchor's
// strict-> tie-break against the master. G: SIM-ONLY WHAT-IF of the proposed
// master weight 3.0 (patched into the loaded source for this scenario only —
// NOT an engine change; the real layer.js/bridge.mjs change goes to cast).
// With a master present the checks become ABSOLUTE (refs vs the master's
// truth), which phone-only scenarios cannot even define.
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
function makeDevice(id, { clock, trueClockErrorMs, trueLatencyMs, model = 'Linux; Android 13; Pixel 7', src }) {
  const handlers = {};
  const outbox = [];
  let clockOffsetMs = 0;
  let deviceLatencyMs = 0;
  const adjustCalls = [];
  let currentTime = INITIAL_CURRENT_TIME_S;
  const duration = 300;

  function ownRefMs() {
    // mirrors shipped computeOwnRefMs (plus form, daab95f)
    return (clock.now() + clockOffsetMs) - (currentTime + deviceLatencyMs / 1000) * 1000;
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
  vm.runInContext(src ?? layerSrc, sandbox);

  return {
    id, handlers, outbox, window,
    get clockOffsetMs() { return clockOffsetMs; },
    get deviceLatencyMs() { return deviceLatencyMs; },
    // The audible truth — what the lag signal is built from. refMs in this
    // sim is belief-derived (ct never moves in response to corrections), so
    // refs can agree perfectly while this is still huge. Any scenario check
    // that ignores this number can "pass" a room that is audibly wrong.
    get residualMs() { return (trueClockErrorMs - clockOffsetMs) + (trueLatencyMs - deviceLatencyMs); },
    adjustCalls, ownRefMs,
    tick() {
      const residual = (trueClockErrorMs - clockOffsetMs) + (trueLatencyMs - deviceLatencyMs);
      const lagMs = residual + (Math.random() * 2 - 1) * 8; // small measurement noise
      currentTime += 2.5;
      window._terLayer.tick(lagMs); // real tick() — internally calls the real maybeCascadeCorrect
    },
  };
}

// ── DEVICE MODEL V2: engine-response model ──────────────────────────────────
// The v1 model above has no engine: currentTime never reacts to lag, so lag
// residuals have nowhere to go and every metric is belief-level only (see
// the WARN in runScenario). V2 closes the loop with the real mechanics:
//   - ct (element position) is real state, advancing at playbackRate
//   - a simplified fastDriftCorrect runs every tick: |lag|≥500 → snap
//     (ct = own believed expected), 15–500 → proportional warp (±2.5% cap),
//     <15 → rate 1
//   - expected uses the REAL seek-formula shape:
//       expected = (syncedNow - startedAt)/1000 - deviceLatencyMs/1000
//   - syncedNow = wall + trueClockErrorMs + clockOffsetMs (belief clock)
//   - the real layer.js sees the real ct (its computeOwnRefMs is now honest)
// True acoustic (BT) latency stays deliberately UNMODELED — it is invisible
// to every ct-domain mechanism in the real system too (that's roadmap error
// line 3/5, the acoustic referee's job). What V2 measures instead is the
// ct-domain position error vs the true schedule:
//   posErrMs = (ct - (wall - trackStart)/1000) * 1000
// which is exactly what live CSV / hud_data capture measures.
function makeDeviceV2(id, { clock, trueClockErrorMs = 0, initialDeviceLatencyMs = 0,
                            wanderMsPerTick = 0, stallStealSPerTick = 0, refErrorMs = 0,
                            wedgeSeekBroken = false, wedgeOffsetS = 0,
                            model = 'Linux; Android 13; Pixel 7', src, bugged = false }) {
  const handlers = {};
  const outbox = [];
  let clockOffsetMs = 0;
  let deviceLatencyMs = initialDeviceLatencyMs;
  const adjustCalls = [];
  const clockAdjustCalls = [];
  let snapCount = 0;
  let refNullCount = 0, refSentCount = 0; // trit broadcasts with gated (null) vs live refMs
  let playbackRate = 1;
  const duration = 300;
  const S = TRUE_REF_MS;           // the TRUE start instant — posErrMs grades against this
  const S_belief = S + refErrorMs; // what THIS device believes (refErrorMs models a stale
                                   // playback_started_at — error line 2, the cascade's
                                   // legitimate rescue territory; see X3)

  const syncedNowMs = () => clock.now() + trueClockErrorMs + clockOffsetMs;
  const expectedS = () => (syncedNowMs() - S_belief) / 1000 - deviceLatencyMs / 1000;

  // enter already converged to OWN belief — models post-entry steady state,
  // the regime the live "stable but 0.5-1s apart" symptom lives in.
  // wedgeOffsetS shifts the entry point; with wedgeSeekBroken the engine can
  // never seek it away (the same-track-relaunch wedge: currentTime writes
  // no-op, only rate still works) — the regime of the first live rescue.
  let currentTime = expectedS() - wedgeOffsetS;

  const chan = {
    on(type, filter, handler) { handlers[filter?.event] = handler; return chan; },
    subscribe() { return chan; },
    send(msg) {
      if (msg?.event !== 'trit') return;
      if (msg.payload?.refMs == null) refNullCount++; else refSentCount++;
      outbox.push({ from: id, event: 'trit', payload: msg.payload });
    },
  };

  const window = {
    db: { channel: () => chan },
    listenerId: id,
    _debugChannel: chan,
    _terLatencyWasStored: true,
    _terGetDeviceLatencyMs: () => deviceLatencyMs,
    _terAdjustLatency: (delta) => {
      const prev = deviceLatencyMs;
      deviceLatencyMs = Math.max(0, Math.min(1200, deviceLatencyMs + delta));
      adjustCalls.push({ t: clock.now(), delta, result: deviceLatencyMs });
      return deviceLatencyMs - prev;
    },
    _terGetZone: () => ({ playback_started_at: new Date(0).toISOString() }),
    SyncEngine: { isEntryPhase: () => false, getDriftState: () => 'idle' },
    _audio: { get currentTime() { return currentTime; }, duration, get playbackRate() { return playbackRate; } },
    syncedNow: () => syncedNowMs(),
    activeZone: { name: 'sim' },
    _terAdjustClockOffset: (deltaMs) => {
      clockOffsetMs += deltaMs;
      clockAdjustCalls.push({ t: clock.now(), deltaMs, result: clockOffsetMs });
      return deltaMs;
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
  vm.runInContext(src ?? layerSrc, sandbox);

  return {
    id, handlers, outbox, window, adjustCalls, clockAdjustCalls,
    get clockOffsetMs() { return clockOffsetMs; },
    get deviceLatencyMs() { return deviceLatencyMs; },
    get snapCount() { return snapCount; },
    get refNullCount() { return refNullCount; },
    get refSentCount() { return refSentCount; },
    // mirror whichever computeOwnRefMs formula this scenario's layer runs
    // (shipped = plus form; bugged demo = the old minus form)
    ownRefMs: () => syncedNowMs() - (currentTime + (bugged ? -1 : 1) * deviceLatencyMs / 1000) * 1000,
    posErrMs: () => (currentTime - (clock.now() - S) / 1000) * 1000,
    tick() {
      // physics — stallStealSPerTick models Class-C restlessness: the audio
      // element loses real time (BT buffer underruns / render stalls) and the
      // engine's catch-up warp perpetually chases the deficit. Mean steal per
      // 2.5s tick ≈ the option value; standing deficit settles where warp
      // capacity (0.0002·|lag| ≤ 2.5%) cancels the steal rate.
      const stolen = stallStealSPerTick ? Math.min(2, stallStealSPerTick * (0.5 + Math.random())) : 0;
      currentTime += (2.5 - stolen) * playbackRate;
      // slow clock wander — the live steady-state signature (2026-07-14:
      // room refSpread breathing 5→150→8ms between rate-limited pulls)
      if (wanderMsPerTick) trueClockErrorMs += (Math.random() * 2 - 1) * wanderMsPerTick;
      const lagMs = (currentTime - expectedS()) * 1000
                    + (Math.random() * 2 - 1) * 8;       // measurement noise
      if (Math.abs(lagMs) >= 500) {                      // fastDriftCorrect: snap
        if (!wedgeSeekBroken) currentTime = expectedS(); // wedged: the seek no-ops
        playbackRate = 1;
        snapCount++;
      } else if (Math.abs(lagMs) >= 15) {                // proportional warp
        playbackRate = 1 - Math.sign(lagMs) * Math.min(0.025, Math.abs(lagMs) * 0.0002);
      } else {
        playbackRate = 1;
      }
      window._terLayer.tick(lagMs);                      // real layer.js
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

// ── Synthetic master (the bridge as stratum-0) ──────────────────────────────
// Not a layer.js instance — a bare bus participant, like bridge.mjs would be.
// Publishes the same trit-payload shape phones use. Its refMs is the true
// track-start instant in this sim's convention (a zero-error, zero-latency
// participant's computeOwnRefMs): TRUE_REF = wall clock at t0 minus the
// position already elapsed at t0.
const TRUE_REF_MS = INITIAL_CLOCK_MS - INITIAL_CURRENT_TIME_S * 1000;
function makeMaster(id = 'sim-master') {
  const outbox = [];
  return {
    id, outbox,
    handlers: {},              // master ignores incoming — it IS the reference
    ownRefMs: () => TRUE_REF_MS,
    tick() {
      outbox.push({ from: id, event: 'trit', payload: {
        deviceId: id, trit: 1 /* P */, lagMs: 0, octoState: 0 /* ANCHORING */,
        ts: Date.now(), model: 'bridge', latencyMs: 0, calSettled: true,
        refMs: TRUE_REF_MS } });
    },
  };
}

// SIM-ONLY WHAT-IF (scenario G): the proposed master weight 3.0. Patches the
// loaded source so pickCascadeAnchor treats the master's deviceId specially.
// This is design exploration in the harness — the on-disk layer.js is
// untouched, and the real change (a MASTER weight in bridge.mjs + layer.js)
// requires its own cast before implementation.
// REGRESSION DEMONSTRATION (H*b scenarios): re-introduce the pre-daab95f
// computeOwnRefMs sign bug (fixed live 2026-07-14, cast 61.3→44). The buggy
// minus form gave a converged phone refMs = trackStart + 2·devLat (clock
// terms cancel), so peer "disagreement" was latency difference doubled —
// un-closable by clockOffset corrections → the live mutual orbit. Keeping
// it reproducible here documents the failure mode and guards the sign.
const BUG_FIND = 'return ts - (ct + lat / 1000) * 1000;';
const layerSrcBugged = layerSrc.replace(BUG_FIND, 'return ts - (ct - lat / 1000) * 1000;');
if (layerSrcBugged === layerSrc) {
  console.error('WARN: bug-demo patch anchor not found in layer.js — H*b scenarios will run stock (has the shipped sign fix moved?)');
}

const W3_FIND = 'const weight = OCTO_WEIGHT_TABLE[p.octoState] ?? 0;';
const layerSrcW3 = layerSrc.replace(W3_FIND,
  "const weight = (id === 'sim-master') ? 3.0 : (OCTO_WEIGHT_TABLE[p.octoState] ?? 0);");
if (layerSrcW3 === layerSrc) {
  console.error('WARN: w3 patch anchor not found in layer.js — scenario G will run at stock weights');
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
// Informational only — printed, never counted. Used by the legacy V1
// belief-model scenarios (A–G below), which have no engine model (ct never
// reacts to lag) and were superseded by the V2 engine-model scenarios
// (H*). Kept because their scenario shapes (CSV-derived rooms, master
// variants, adversarial orderings) remain useful reference dynamics.
// Authoritative pass/fail lives in the V2 section.
function info(name, cond, detail) {
  console.log(`  ${cond ? '·' : '·'} info: ${name} ${cond ? 'holds' : 'does NOT hold'}${detail ? ' — ' + detail : ''}`);
}

function runScenario({ label, minutes, deviceSpecs, master = null }) {
  console.log(`\n[${label}] ${deviceSpecs.length} devices${master ? ` + MASTER (${master})` : ''}, ${minutes}min`);
  const clock = makeClock();
  const src = master === 'w3' ? layerSrcW3 : layerSrc;
  const phones = deviceSpecs.map((spec, i) => makeDevice(`d${i}`, { clock, src, ...spec }));
  // Master LAST in bus order — adversarial: any wrong phone's key lands in
  // _peerTrits first, so at equal weight the wrong phone wins the strict->
  // tie-break. If the design only works when the master is seen first, it
  // doesn't work.
  const participants = master ? [...phones, makeMaster()] : phones;

  const totalTicks = Math.round(minutes * 60 / 2.5);
  const history = [];
  for (let i = 0; i < totalTicks; i++) {
    clock.advance(2500);
    for (const p of participants) p.tick();
    deliverBus(participants);
    if (i % 24 === 0) {
      const refs = phones.map(d => d.ownRefMs());
      const spread = Math.max(...refs) - Math.min(...refs);
      const absErr = master ? Math.max(...refs.map(r => Math.abs(r - TRUE_REF_MS))) : null;
      const maxResid = Math.max(...phones.map(d => Math.abs(d.residualMs)));
      history.push({ minute: Math.round(i * 2.5 / 60), spread, absErr, maxResid, lats: phones.map(d => Math.round(d.deviceLatencyMs)) });
    }
  }

  console.log('  minute-by-minute room spread (max-min refMs across devices):');
  history.forEach(h => console.log(`    m${h.minute}: spread=${h.spread.toFixed(0)}ms${h.absErr != null ? `  absErr=${h.absErr.toFixed(0)}ms` : ''}  resid=${h.maxResid.toFixed(0)}ms  latencies=[${h.lats.join(',')}]`));

  const finalRefs = phones.map(d => d.ownRefMs());
  const finalSpread = Math.max(...finalRefs) - Math.min(...finalRefs);
  const last3 = history.slice(-3).map(h => h.spread);
  const spreadHeld = Math.max(...last3) - Math.min(...last3);
  const anchorChoices = phones.map(d => d.window._terLayer.getCascadeAnchorId());

  console.log(`  final anchor choices: ${anchorChoices.join(', ')}`);
  info('room spread converges under 100ms', finalSpread < 100, `spread=${finalSpread.toFixed(0)}ms`);
  info('spread holds steady in final 3 checkpoints (<40ms wobble)', spreadHeld < 40, `wobble=${spreadHeld.toFixed(0)}ms`);
  info('no device latency ran away past the cap', phones.every(d => d.deviceLatencyMs <= 1200), '');
  // WARN, not FAIL — this harness has NO engine model: currentTime never
  // seeks/warps in response to lag, so the residual (the corrector's input
  // signal) has nowhere to go once cal's budget is spent. A large value here
  // does NOT prove the ported code wrong; it proves this harness validates
  // BELIEF-consistency (refs agreeing) and cannot yet say anything about
  // AUDIBLE alignment. That applies to every scenario in this file,
  // including A/B/D's historical passes. Before leaning on this sim for the
  // bridge-as-stratum-0 cast, add an engine-response model (ct that seeks
  // toward the device's own believed expected position) and promote this to
  // a hard check. Found 2026-07-14 while adding the master scenarios.
  const finalResid = Math.max(...phones.map(d => Math.abs(d.residualMs)));
  if (finalResid >= 100) {
    console.log(`  ⚠ WARN unresolved residual ${finalResid.toFixed(0)}ms — belief-level pass only; harness has no engine model (see comment)`);
  } else {
    console.log(`  ✓ residual also converged (${finalResid.toFixed(0)}ms) — belief AND signal-level agreement`);
  }
  if (master) {
    const finalAbs = Math.max(...finalRefs.map(r => Math.abs(r - TRUE_REF_MS)));
    info('room converges to the MASTER\'S TRUTH, not just to itself (<100ms abs)', finalAbs < 100, `absErr=${finalAbs.toFixed(0)}ms`);
    const followers = anchorChoices.filter(a => a === 'sim-master').length;
    console.log(`  phones anchored to master: ${followers}/${phones.length}`);
  }

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

runScenario({
  label: 'E: MASTER at ANCHORING weight (2.0, zero layer.js changes) — same room as A',
  minutes: 20,
  master: 'w2',
  deviceSpecs: [
    { trueClockErrorMs: 0,    trueLatencyMs: 40 },
    { trueClockErrorMs: 1300, trueLatencyMs: 200 },
    { trueClockErrorMs: 420,  trueLatencyMs: 350 },
  ],
});

// F/G adversary design: the error must be SMALL enough that calibration can
// fully self-absorb it (residual → 0 → sustained P → ANCHORING) while the
// device's refMs sits ~180ms off truth — a phone that is confidently,
// stably WRONG. (First attempt used 330ms total error: cal's budget ran out
// with the device still REACHING, so it never competed for anchor and the
// tie was never actually tested.)
runScenario({
  label: 'F: ADVERSARIAL TIE — confidently-wrong phone reaches ANCHORING, seen before master (both 2.0)',
  minutes: 25,
  master: 'w2',
  deviceSpecs: [
    { trueClockErrorMs: 120, trueLatencyMs: 60 },   // the adversary — fully self-absorbable
    { trueClockErrorMs: 200, trueLatencyMs: 150 },
    { trueClockErrorMs: 80,  trueLatencyMs: 250 },
  ],
});

runScenario({
  label: 'G: SIM-ONLY WHAT-IF — master at proposed weight 3.0, same adversarial room as F',
  minutes: 25,
  master: 'w3',
  deviceSpecs: [
    { trueClockErrorMs: 120, trueLatencyMs: 60 },
    { trueClockErrorMs: 200, trueLatencyMs: 150 },
    { trueClockErrorMs: 80,  trueLatencyMs: 250 },
  ],
});

// ── V2 scenarios: engine-response model ─────────────────────────────────────
function runScenarioV2({ label, minutes, deviceSpecs, master = null, bugged = false, srcOverride = null, checks }) {
  console.log(`\n[${label}] ${deviceSpecs.length} devices${master ? ` + MASTER (${master})` : ''}${bugged ? ' [BUGGED refMs demo]' : ''}, ${minutes}min  (V2 engine model)`);
  const clock = makeClock();
  const src = srcOverride ?? (bugged ? layerSrcBugged : (master === 'w3' ? layerSrcW3 : layerSrc));
  const phones = deviceSpecs.map((spec, i) => makeDeviceV2(`d${i}`, { clock, src, bugged, ...spec }));
  const participants = master ? [...phones, makeMaster()] : phones;

  const totalTicks = Math.round(minutes * 60 / 2.5);
  const history = [];
  for (let i = 0; i < totalTicks; i++) {
    clock.advance(2500);
    for (const p of participants) p.tick();
    deliverBus(participants);
    if (i % 24 === 0) {
      const pos = phones.map(d => d.posErrMs());
      const refs = phones.map(d => d.ownRefMs());
      history.push({
        minute: Math.round(i * 2.5 / 60),
        posSpread: Math.max(...pos) - Math.min(...pos),
        posAbs: Math.max(...pos.map(Math.abs)),
        refSpread: Math.max(...refs) - Math.min(...refs),
        snaps: phones.map(d => d.snapCount),
        casc: phones.map(d => d.clockAdjustCalls.length),
        lats: phones.map(d => Math.round(d.deviceLatencyMs)),
      });
    }
  }

  console.log('  minute: posSpread (ct-domain, THE room metric) | refSpread | snaps | cascade-corrections | latencies');
  history.forEach(h => console.log(
    `    m${String(h.minute).padStart(2)}: pos=${h.posSpread.toFixed(0)}ms  ref=${h.refSpread.toFixed(0)}ms  snaps=[${h.snaps.join(',')}]  casc=[${h.casc.join(',')}]  lat=[${h.lats.join(',')}]`));

  const final = history[history.length - 1];
  const fiveMinAgo = history[Math.max(0, history.length - 6)];
  const lateSnaps = final.snaps.map((s, i) => s - fiveMinAgo.snaps[i]);
  const result = {
    posSpread: final.posSpread,
    posAbs: final.posAbs,
    refSpread: final.refSpread,
    lateSnapTotal: lateSnaps.reduce((a, b) => a + b, 0),
    cascTotal: final.casc.reduce((a, b) => a + b, 0),
    meanPosSpread: history.reduce((a, h) => a + h.posSpread, 0) / history.length,
    maxPosSpread: Math.max(...history.map(h => h.posSpread)),
  };
  console.log(`  final: posSpread=${result.posSpread.toFixed(0)}ms posAbs=${result.posAbs.toFixed(0)}ms refSpread=${result.refSpread.toFixed(0)}ms snapsLast5min=${result.lateSnapTotal} cascadeCorrections=${result.cascTotal}`);
  checks(result, phones);
  return result;
}

// H1 — THE LIVE SYMPTOM room, on the SHIPPED formula (post-daab95f):
// phones individually stable, deviceLatencyMs beliefs differing by hundreds
// of ms, no clock error. Expectation: converged phones all report
// trackStart → no false gap → cascade stays silent, room stays quiet.
// (The remaining posSpread is the true underlying problem — wrong latency
// beliefs — which belongs to calibration/acoustic ground truth, not to
// clock jumps.)
runScenarioV2({
  label: 'H1: converged room, devLat beliefs [0,300,600] — shipped formula',
  minutes: 25,
  deviceSpecs: [
    { initialDeviceLatencyMs: 0 },
    { initialDeviceLatencyMs: 300 },
    { initialDeviceLatencyMs: 600 },
  ],
  checks: (r) => {
    check('zero cascade corrections (no false gap)', r.cascTotal === 0, `corrections=${r.cascTotal}`);
    check('steady state quiet (no snaps last 5min)', r.lateSnapTotal === 0, `snaps=${r.lateSnapTotal}`);
    check('refSpread near zero (<20ms)', r.refSpread < 20, `ref=${r.refSpread.toFixed(0)}ms`);
  },
});

// H1b — the same room on the PRE-FIX formula: the mutual-orbit runaway,
// kept reproducible as regression documentation (observed live 2026-07-14:
// mirror-image corrections matching 2·Δlat within a few ms, clockOffsets
// accumulating past -1300ms before the fix shipped).
runScenarioV2({
  label: 'H1b: same room, BUGGED pre-daab95f formula — must reproduce the orbit',
  minutes: 25, bugged: true,
  deviceSpecs: [
    { initialDeviceLatencyMs: 0 },
    { initialDeviceLatencyMs: 300 },
    { initialDeviceLatencyMs: 600 },
  ],
  checks: (r) => {
    check('reproduces the runaway (≥20 corrections)', r.cascTotal >= 20, `corrections=${r.cascTotal}`);
    check('position spread diverges (>5000ms) — the orbit', r.posSpread > 5000, `pos=${r.posSpread.toFixed(0)}ms`);
  },
});

// H2 — shipped formula + master at stock ANCHORING weight: agreement, quiet.
runScenarioV2({
  label: 'H2: converged room + MASTER (w2.0) — shipped formula',
  minutes: 25, master: 'w2',
  deviceSpecs: [
    { initialDeviceLatencyMs: 0 },
    { initialDeviceLatencyMs: 300 },
    { initialDeviceLatencyMs: 600 },
  ],
  checks: (r) => {
    check('zero cascade corrections (agreement with master)', r.cascTotal === 0, `corrections=${r.cascTotal}`);
    check('steady state quiet (no snaps last 5min)', r.lateSnapTotal === 0, `snaps=${r.lateSnapTotal}`);
  },
});

// H3 — clock-error-only room: documents the honest null. Converged phones
// absorb clock error into position; refMs carries no clock signal, so the
// cascade correctly stays silent AND the room correctly stays apart —
// this error line belongs to LAN-first clock sync (roadmap Phase 4), not
// to refMs consensus. If this check ever "fails" by converging, something
// new is moving clocks — investigate before celebrating.
runScenarioV2({
  label: 'H3: clock errors [0,+400,-250] — shipped formula (honest null)',
  minutes: 25,
  deviceSpecs: [
    { trueClockErrorMs: 0 },
    { trueClockErrorMs: 400 },
    { trueClockErrorMs: -250 },
  ],
  checks: (r) => {
    check('zero cascade corrections (no false signal)', r.cascTotal === 0, `corrections=${r.cascTotal}`);
    check('steady state quiet (no snaps last 5min)', r.lateSnapTotal === 0, `snaps=${r.lateSnapTotal}`);
    check('clock error remains invisible (posSpread ≥500ms) — Phase 4 territory', r.posSpread >= 500, `pos=${r.posSpread.toFixed(0)}ms`);
  },
});

// ── W: wander scenarios — the tightening question (2026-07-14 late) ─────────
// Live steady state on the honest signal: room refSpread breathes as clocks
// wander; cascade pulls it back whenever the 4-sample avg crosses the 60ms
// deadband. Those pulls are warp-sized (<500ms) — inaudible — so the
// deadband is NOT an audibility guard, it's just the allowed room spread.
// Tightening candidate: CASCADE_THRESHOLD_MS 60 → 35 (still >> the ±8ms
// measurement noise after 4-sample averaging). W1/W2 compare them under
// identical wander.
const T35_FIND = 'const CASCADE_THRESHOLD_MS     = 60;';
const layerSrcT35 = layerSrc.replace(T35_FIND, 'const CASCADE_THRESHOLD_MS     = 35;');
if (layerSrcT35 === layerSrc) console.error('WARN: T35 patch anchor not found — W2 runs stock');

const WANDER_SPECS = [
  { wanderMsPerTick: 6 },
  { wanderMsPerTick: 6, initialDeviceLatencyMs: 300 },
  { wanderMsPerTick: 6, initialDeviceLatencyMs: 150 },
];

// FINDING (first run, 2026-07-14): the deadband is irrelevant here — ZERO
// corrections fired at 60ms OR 35ms while posSpread wandered to 300-500ms.
// Converged phones' refMs ≡ trackStart regardless of clock state, so
// refMs consensus is STRUCTURALLY BLIND to slow clock wander. These
// scenarios now document that blindness (and note: this harness omits the
// real system's 30s measureClockOffset loop, which bounds wander live —
// EXCEPT on devices where _cascadeEngaged has permanently silenced it).
// The tightening levers for wander are LAN clock (kills it at the source)
// and a position-domain master signal (master_verdict math) — not refMs.
const wanderChecks = (r) => {
  check('no snaps in steady state (corrections stay warp-sized)', r.lateSnapTotal === 0, `snaps=${r.lateSnapTotal}`);
  check('cascade is BLIND to slow clock wander (zero corrections) — if this fails, refMs can suddenly see clocks: investigate', r.cascTotal === 0, `corrections=${r.cascTotal}`);
  console.log(`  → meanSpread=${r.meanPosSpread.toFixed(0)}ms maxSpread=${r.maxPosSpread.toFixed(0)}ms corrections=${r.cascTotal} (unbounded wander — no NTP loop modeled)`);
};

runScenarioV2({
  label: 'W1: wandering clocks (±6ms/tick), stock deadband 60ms — documents refMs wander-blindness',
  minutes: 40,
  deviceSpecs: WANDER_SPECS,
  checks: wanderChecks,
});

runScenarioV2({
  label: 'W2: same wander, deadband 35ms — identical blindness (deadband is not the lever)',
  minutes: 40,
  srcOverride: layerSrcT35,
  deviceSpecs: WANDER_SPECS,
  checks: wanderChecks,
});

// ── X: warp-gate scenarios — warp breaks refMs time-invariance (2026-07-15) ──
// Cast 8→55 lines 1·3·4·5. Measured live to ~0.1ms/s precision
// (byob-obs-2026-07-15T02-01 / 02-17): while a device warps, its refMs slides
// at exactly -(rate-1)*1000 ms/s; at rate 1 it is flat (calm-pair slide 0.0).
// Live warp duty ran 30-70% on restless devices, so most 40s cascade windows
// contained poisoned samples — the whole steady-state both-negative creep
// (-62..-125ms pulls every 1-3min, common-mode clockOffset walk, unbounded).
//
// THE GATE: while |playbackRate - base| > 0.003 (base = BPM-warp rate, 1.0
// when none), skip own cascade samples AND broadcast refMs as null.
// pickCascadeAnchor already skips null-refMs peers, so a warping flagship
// stops being anchor-eligible with zero peer-side logic (line 4: hold to him
// outwardly too). Line 5 constraint: the gate only excludes — no staleness
// compensation, no peer-side rate judging.
//
// ensureGated/ensureUngated make these scenarios independent of whether the
// real layer.js carries the gate yet: X1 strips it (permanent creep-
// reproduction guard, mirroring H1b), X2/X3 add it if absent.
//
// Modeling note: constant steal ⇒ ~100% warp duty at the standing deficit
// (live duty is 30-70%, oscillating). That's the conservative direction on
// both sides — maximal slide for the creep reproduction, maximal gating for
// the gate scenarios.
function ensureGated(src) {
  if (src.includes('cascadeWarpGated')) return src;
  let out = src.replace(/(const CASCADE_MIN_WEIGHT[^\n]*\n)/,
    `$1  const CASCADE_WARP_RATE_GATE   = 0.003; // |rate-base| beyond this ⇒ refMs is sliding, not comparable\n`);
  if (out === src) { console.error('FATAL: gate-const anchor not found'); process.exit(1); }
  const withFn = out.replace('function maybeCascadeCorrect() {',
`function cascadeWarpGated() {
    const rate = window._audio?.playbackRate;
    if (rate == null || !isFinite(rate)) return false;
    const base = window.SpatialRouting?.getBpmWarpRate?.() ?? 1;
    return Math.abs(rate - base) > CASCADE_WARP_RATE_GATE;
  }

  function maybeCascadeCorrect() {`);
  if (withFn === out) { console.error('FATAL: maybeCascadeCorrect anchor not found'); process.exit(1); }
  out = withFn.replace('    _lastCascadeCheckTs = now;',
    '    _lastCascadeCheckTs = now;\n    if (cascadeWarpGated()) return;');
  const final = out.replace('refMs: computeOwnRefMs(),',
    'refMs: cascadeWarpGated() ? null : computeOwnRefMs(),');
  if (final === out) { console.error('FATAL: broadcast refMs anchor not found'); process.exit(1); }
  return final;
}
function ensureUngated(src) {
  if (!src.includes('cascadeWarpGated')) return src;
  let out = src.replace(/\n[ \t]*if \(cascadeWarpGated\(\)\) return;[^\n]*/, '');
  if (out === src) { console.error('FATAL: ungate sample-site anchor not found'); process.exit(1); }
  const final = out.replace(/refMs: cascadeWarpGated\(\) \? null : computeOwnRefMs\(\),/, 'refMs: computeOwnRefMs(),');
  if (final === out) { console.error('FATAL: ungate broadcast anchor not found'); process.exit(1); }
  return final;
}
const layerSrcUngated = ensureUngated(layerSrc);
const layerSrcGated   = ensureGated(layerSrc);

const STALL_ROOM = [
  { stallStealSPerTick: 0.0375 }, // heavy: ~15ms/s steal → standing deficit ~75ms, rate ~1.015 (the live mrviaw/f4zzg4 picture)
  { stallStealSPerTick: 0.025 },  // moderate: ~10ms/s → deficit ~50ms, mostly under the 60ms deadband
  {},                             // clean witness — never fires, and makes the creep VISIBLE as posSpread
];

runScenarioV2({
  label: 'X1: stall-warp room, UNGATED — must reproduce the both-negative creep',
  minutes: 25,
  srcOverride: layerSrcUngated,
  deviceSpecs: STALL_ROOM,
  checks: (r, phones) => {
    const stallFires = phones[0].clockAdjustCalls.length + phones[1].clockAdjustCalls.length;
    const walk = [...phones[0].clockAdjustCalls, ...phones[1].clockAdjustCalls]
      .reduce((a, c) => a + c.deltaMs, 0);
    check('false fires on zero-clock-error stall devices (≥3)', stallFires >= 3, `fires=${stallFires}`);
    check('clean witness never fires', phones[2].clockAdjustCalls.length === 0, `fires=${phones[2].clockAdjustCalls.length}`);
    check('same-sign negative walk (≤-150ms cumulative)', walk <= -150, `walk=${walk.toFixed(0)}ms`);
    check('creep is audible against the clean witness (maxPosSpread ≥500ms)', r.maxPosSpread >= 500, `max=${r.maxPosSpread.toFixed(0)}ms`);
  },
});

runScenarioV2({
  label: 'X2: identical room, GATED — the creep must go quiet',
  minutes: 25,
  srcOverride: layerSrcGated,
  deviceSpecs: STALL_ROOM,
  checks: (r, phones) => {
    check('zero cascade corrections (every fire here would be false)', r.cascTotal === 0, `corrections=${r.cascTotal}`);
    const d0 = phones[0], nullShare = d0.refNullCount / Math.max(1, d0.refNullCount + d0.refSentCount);
    check('warping device broadcasts refMs:null (≥50% of trits) — anchor-side cover', nullShare >= 0.5, `nullShare=${(100 * nullShare).toFixed(0)}%`);
    check('spread bounded at the physical deficit (maxPosSpread ≤250ms)', r.maxPosSpread <= 250, `max=${r.maxPosSpread.toFixed(0)}ms`);
    check('no snaps', r.lateSnapTotal === 0, `snaps=${r.lateSnapTotal}`);
  },
});

// X3 — the rescue the cascade legitimately owns must SURVIVE the gate: the
// WEDGED device (same-track-relaunch wedge — currentTime writes no-op, so
// the engine attempts a snap every tick, each one an audible mute+ramp cut,
// forever). It sits at rate 1 (snap branch, not warping) so its samples
// flow through the gate; one correction moves its BELIEF to its immovable
// physics; the thrash ends and the room's references agree. Offline twin of
// the first live rescue (Jul 15: one -1111ms pull, settled, no repeat).
// Honest scope: the physical position stays off — freeing the audio element
// is the same-track-relaunch fix's job, not the cascade's.
runScenarioV2({
  label: 'X3: wedged device (seeks no-op, -800ms), GATED — one-shot belief rescue',
  minutes: 10,
  srcOverride: layerSrcGated,
  deviceSpecs: [
    { initialDeviceLatencyMs: 0 },
    { initialDeviceLatencyMs: 150 },
    { wedgeSeekBroken: true, wedgeOffsetS: 0.8 },
  ],
  checks: (r, phones) => {
    const rescued = phones[2];
    check('rescue fires despite the gate (1-2 corrections)', rescued.clockAdjustCalls.length >= 1 && rescued.clockAdjustCalls.length <= 2, `fires=${rescued.clockAdjustCalls.length}`);
    check('snap thrash ends (no snap attempts last 5min)', r.lateSnapTotal === 0, `snaps=${r.lateSnapTotal}`);
    check('room refs agree after rescue (refSpread <60ms)', r.refSpread < 60, `ref=${r.refSpread.toFixed(0)}ms`);
    check('honest physics: wedged audio does NOT move (~-800ms posErr) — if this "improves", seeks started working: re-scope', Math.abs(rescued.posErrMs() + 800) <= 150, `posErr=${rescued.posErrMs().toFixed(0)}ms`);
  },
});

// X4 — HONEST LIMIT (H3's sibling), found by this harness while building X3:
// a stale-REFERENCE device with WORKING seeks cannot be rescued by clockOffset
// corrections at all — the engine re-converges ct to the stale row belief
// after every pull, refMs returns to the same wrong value, and the cascade
// orbits (each cycle shifts the physical position another step). GATE-NEUTRAL:
// fires happen at rate 1, so the warp-gate neither causes nor stops it.
// Live exposure is low because reference divergence has dedicated owners
// (artist.html row-repair heartbeat, anchor-scoping fix 9718f40, bridge
// follow-the-row) — this scenario documents that those owners are LOAD-
// BEARING for the cascade era: if row-repair regresses, the cascade will
// actively walk stale-row devices away, not fix them.
for (const [tag, src] of [['GATED', layerSrcGated], ['UNGATED', layerSrcUngated]]) {
  runScenarioV2({
    label: `X4-${tag}: stale playback_started_at (+800ms), working seeks — documents the orbit`,
    minutes: 10,
    srcOverride: src,
    deviceSpecs: [
      { initialDeviceLatencyMs: 0 },
      { initialDeviceLatencyMs: 150 },
      { refErrorMs: 800 },
    ],
    checks: (r, phones) => {
      const stale = phones[2];
      check('orbit reproduces (≥4 fires on the stale-row device) — if quiet, something new owns reference repair: investigate', stale.clockAdjustCalls.length >= 4, `fires=${stale.clockAdjustCalls.length}`);
      check('each pull walks physical position (|posErr| grows past 2000ms)', Math.abs(stale.posErrMs()) > 2000, `posErr=${stale.posErrMs().toFixed(0)}ms`);
    },
  });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
