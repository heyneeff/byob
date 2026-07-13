// BYOB Live Sync Tuner — runs in terminal, reports parameter recommendations
// Usage: node live-tuner.mjs [collect_seconds]
// Subscribes to byob_debug, collects hud_data, sweeps engine params, reports.

import '../byob-shim.js';
const { createClient } = globalThis.supabase;

const SUPABASE_URL = 'http://localhost:3100';
const SUPABASE_KEY = 'local';
const COLLECT_S = parseInt(process.argv[2] || '90'); // default 90s collection window

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Per-device data buffer ────────────────────────────────────────────────────
const buffers = {};   // deviceId → [{elapsed, currentTime, driftMs, playbackRate, snapCount, driftState, deviceLatencyMs}]
let packetCount = 0;

// ── Stall model extraction ────────────────────────────────────────────────────
function extractModel(id) {
  const buf = buffers[id];
  if (buf.length < 4) return null;

  const bt = parseFloat(buf.at(-1).deviceLatencyMs) || 0;
  const stalls = [], idleDrifts = [];
  let stallEvents = 0, totalWindows = 0;

  for (let i = 1; i < buf.length; i++) {
    const prev = buf[i - 1], curr = buf[i];
    const sc0 = parseInt(prev.snapCount) || 0, sc1 = parseInt(curr.snapCount) || 0;
    const el0 = parseFloat(prev.elapsed), el1 = parseFloat(curr.elapsed);
    const ct0 = parseFloat(prev.currentTime), ct1 = parseFloat(curr.currentTime);
    const rate = parseFloat(prev.playbackRate) || 1.0;
    if (!isFinite(el0) || !isFinite(el1) || !isFinite(ct0) || !isFinite(ct1)) continue;
    const wallDelta = el1 - el0;
    if (wallDelta < 0.5 || wallDelta > 8) continue;
    totalWindows++;
    if (sc0 === sc1 && curr.driftState !== 'seeking') {
      const stall = Math.max(0, (wallDelta * rate - (ct1 - ct0)) * 1000);
      if (stall < 500) { stalls.push(stall); if (stall > 50) stallEvents++; }
      const d = parseFloat(curr.driftMs);
      if (isFinite(d) && Math.abs(d) < 2000) idleDrifts.push(d);
    }
  }

  const sorted = [...stalls].sort((a, b) => a - b);
  const medStall = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const sortedD = [...idleDrifts].sort((a, b) => a - b);
  const medFloor = sortedD.length ? sortedD[Math.floor(sortedD.length / 2)] : 0;
  const stallPer = stallEvents > 0 ? Math.round(totalWindows * 3 / stallEvents) : 10;
  const recentDrifts = buf.slice(-5).map(r => parseFloat(r.driftMs)).filter(isFinite);
  const recentMean = recentDrifts.length ? recentDrifts.reduce((a, b) => a + b, 0) / recentDrifts.length : 0;

  return {
    bt, floor: Math.round(medFloor), avgStall: Math.round(medStall),
    stallPer: Math.max(2, Math.min(15, stallPer)),
    recentDrift: Math.round(recentMean),
    lastState: buf.at(-1).driftState || '?',
    snapCount: parseInt(buf.at(-1).snapCount) || 0,
    n: buf.length,
  };
}

// ── Simulation engine ─────────────────────────────────────────────────────────
function simulate(model, params, seed = 42) {
  // Simple deterministic PRNG
  let s = seed | 0;
  const rand = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

  const TICK_S = params.tick / 1000;
  const TICKS  = Math.floor(300 / TICK_S); // 5-min session
  let drift = model.floor, rate = 1.0, warpRem = 0, cooldown = 0, nextStall = 0;
  let audible = 0, pCount = 0, pStreak = 0, maxStreak = 0;
  let sumAbsDrift = 0;

  for (let t = 0; t < TICKS; t++) {
    // Stall injection
    if (nextStall <= 0 && model.avgStall > 0) {
      const jit = 1 + (rand() - 0.5) * 0.6;
      drift -= model.avgStall * jit;
      nextStall = Math.round(model.stallPer / TICK_S * (1 + (rand() - 0.5) * 0.3));
    }
    nextStall--;

    // Warp recovery
    if (warpRem > 0) {
      drift += Math.sign(-drift) * params.warp * TICK_S * 1000;
      warpRem--;
      if (warpRem <= 0) rate = 1.0;
    }

    const abs = Math.abs(drift);
    sumAbsDrift += abs;

    if (cooldown > 0) { cooldown--; }
    else if (abs >= params.snap) {
      drift = model.floor; // seek resets to floor
      audible++;
      cooldown = Math.ceil((params.settle + params.ramp) / params.tick);
      rate = 1.0; warpRem = 0;
    } else if (abs >= params.thSeek) {
      drift = model.floor;
      audible++;
      cooldown = Math.ceil((params.settle + params.ramp) / params.tick);
    } else if (abs >= 15) {
      const corrTicks = Math.ceil(abs / (params.warp * 1000 * TICK_S));
      warpRem = Math.min(corrTicks, Math.ceil(10 / TICK_S));
      rate = 1.0 + Math.sign(-drift) * params.warp;
    } else {
      rate = 1.0;
    }

    if (abs < 10) { pCount++; pStreak++; maxStreak = Math.max(maxStreak, pStreak); }
    else pStreak = 0;
  }

  return {
    audible,
    pPct:      Math.round(100 * pCount / TICKS),
    meanDrift: Math.round(sumAbsDrift / TICKS),
    bestStreak: Math.round(maxStreak * TICK_S),
  };
}

// ── Parameter sweep ───────────────────────────────────────────────────────────
function sweep(model) {
  const snapVals  = [100, 150, 200, 300, 500];
  const warpVals  = [0.05, 0.08, 0.10, 0.12, 0.15];
  const thSeekVals= [300, 400, 600, 1000];
  const baseParams = { tick: 2500, settle: 190, ramp: 180 };

  let best = null, bestScore = -Infinity;
  const results = [];

  for (const snap of snapVals) {
    for (const warp of warpVals) {
      for (const thSeek of thSeekVals) {
        if (thSeek <= snap) continue;
        const p = { ...baseParams, snap, warp, thSeek };
        const r = simulate(model, p);
        // Score: penalise audible cuts heavily, reward P-state %
        const score = r.pPct * 2 - r.audible * 5 - r.meanDrift * 0.1;
        results.push({ snap, warp: Math.round(warp * 100), thSeek, ...r, score: Math.round(score) });
        if (score > bestScore) { bestScore = score; best = { snap, warp, thSeek, ...r }; }
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return { best, top5: results.slice(0, 5), current: simulate(model, { ...baseParams, snap: 150, warp: 0.06, thSeek: 400 }) };
}

// ── Reporting ─────────────────────────────────────────────────────────────────
function report() {
  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`BYOB SYNC TUNER — ${packetCount} packets, ${Object.keys(buffers).length} devices`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  for (const [id, buf] of Object.entries(buffers)) {
    const model = extractModel(id);
    if (!model || model.n < 6) { console.log(`${id}: not enough data (${model?.n || 0} readings)\n`); continue; }

    const { best, top5, current } = sweep(model);
    const improved = current.audible - best.audible;
    const arrow = improved > 0 ? `↓${improved} audible cuts` : 'no improvement found';

    console.log(`┌─ ${id} (BT=${model.bt}ms, ${model.n} readings)`);
    console.log(`│  Model: floor=${model.floor}ms · stall≈${model.avgStall}ms/${model.stallPer}s · recent drift=${model.recentDrift}ms (${model.lastState})`);
    console.log(`│`);
    console.log(`│  CURRENT  snap=150ms warp=6%  thSeek=400ms`);
    console.log(`│    → ${current.audible} cuts · P=${current.pPct}% · mean drift=${current.meanDrift}ms · best streak=${current.bestStreak}s`);
    console.log(`│`);
    console.log(`│  BEST     snap=${best.snap}ms warp=${Math.round(best.warp*100)}%  thSeek=${best.thSeek}ms  (${arrow})`);
    console.log(`│    → ${best.audible} cuts · P=${best.pPct}% · mean drift=${best.meanDrift}ms · best streak=${best.bestStreak}s`);
    console.log(`│`);
    console.log(`│  TOP 5:`);
    top5.forEach((r, i) => {
      console.log(`│    ${i + 1}. snap=${r.snap}ms warp=${r.warp}% thSeek=${r.thSeek}ms → ${r.audible} cuts P=${r.pPct}% drift=${r.meanDrift}ms`);
    });
    console.log(`└${'─'.repeat(60)}\n`);
  }
  if (correctionLog.length) {
    console.log('── AUTO-CAL EVENTS THIS SESSION ─────────────────────────────');
    correctionLog.forEach(e => console.log(e));
    console.log();
  }
}

// ── Subscribe ─────────────────────────────────────────────────────────────────
console.log(`Connecting to byob_debug… collecting for ${COLLECT_S}s`);
console.log('(Start a session with listeners to generate data)\n');

const correctionLog = [];

const ch = db.channel('byob_debug')
  .on('broadcast', { event: 'hud_data' }, ({ payload: p }) => {
    const id = p.deviceId;
    if (!id || !id.startsWith('dev_')) return;
    if (!buffers[id]) buffers[id] = [];
    buffers[id].push(p);
    if (buffers[id].length > 60) buffers[id].shift();
    packetCount++;
    process.stdout.write(`\r  ${packetCount} packets · ${Object.keys(buffers).length} device(s): ${Object.keys(buffers).join(', ')}   `);
  })
  .on('broadcast', { event: 'correction_event' }, ({ payload: p }) => {
    const sign = p.correctionMs >= 0 ? '+' : '';
    const ts = new Date(p.ts).toISOString().slice(11, 19);
    const entry = `  🔧 AUTO-CAL ${p.deviceId} @ ${ts}: latency ${p.prevLatencyMs}ms → ${p.newLatencyMs}ms (${sign}${p.correctionMs}ms) drift was ${p.driftMs ?? '?'}ms`;
    correctionLog.push(entry);
    process.stdout.write('\n' + entry + '\n');
  })
  .subscribe();

setTimeout(() => {
  ch.unsubscribe();
  report();
  process.exit(0);
}, COLLECT_S * 1000);
