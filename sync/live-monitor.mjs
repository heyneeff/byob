// BYOB Live Sync Monitor — continuous, auto-logging, no CSV drops needed
// Usage: node live-monitor.mjs
// Ctrl+C to stop and print final summary.
//
// Writes a rolling log to ./monitor-logs/YYYY-MM-DD_HH-MM.csv automatically.
// Tracks per-device drift, stall signature, P/Z/N state distribution in real time.

import { createClient } from '@supabase/supabase-js';
import { createWriteStream, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const SUPABASE_URL = 'https://ohacvuwzvuifpyqckise.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9oYWN2dXd6dnVpZnB5cWNraXNlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5ODc4NTcsImV4cCI6MjA5MjU2Mzg1N30.EX_DF-hFaQQuA1R9cZMKgR6TwjubwP61Ph4Gwa87beY';

const REPORT_INTERVAL_MS  = 30_000;   // print summary every 30s
const STALL_DETECT_MS     = 40;       // jump ≥ this between ticks = stall event
const TICK_WINDOW         = 40;       // rolling window of ticks per device

// Launch verification (Phase 4.1) — acceptance test for synced entry
const LAUNCH_WINDOW_MS    = 20_000;   // observe this long after a track_change
const LAUNCH_TARGET_MS    = 50;       // convergence bar: every device must reach |drift| < this…
const LAUNCH_TARGET_S     = 3_000;    // …within this many ms of the launch event
const LAUNCH_SPREAD_PASS_MS = 25;     // room mutual spread — listenability bar
const MASTER_PASS_MS      = 50;       // median offset vs bridge master_tick — alignment bar

const __dir = dirname(fileURLToPath(import.meta.url));
const logDir = join(__dir, 'monitor-logs');
mkdirSync(logDir, { recursive: true });

const ts = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
const csvPath = join(logDir, `${ts}.csv`);
const csvStream = createWriteStream(csvPath, { flags: 'a' });

const CSV_HEADER = 'wall_ts,deviceId,driftMs,terTritLabel,playbackRate,terSnapCount,terLastFloor,terCalState,terConsecN';
csvStream.write(CSV_HEADER + '\n');

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Per-device state ──────────────────────────────────────────────────────────
const devices = {};  // deviceId → DeviceState

function getDevice(id) {
  if (!devices[id]) {
    devices[id] = {
      id,
      ticks: [],          // rolling window of {ts, drift, label, rate}
      stalls: [],         // detected stall magnitudes
      pnTransitions: [],  // {ts, fromDrift, toDrift, jump} — P→N jumps
      calEvents: [],      // auto-cal corrections
      lastLabel: null,
      packetCount: 0,
    };
  }
  return devices[id];
}

// ── Launch verification (Phase 4.1) ───────────────────────────────────────────
// A track_change/hard_sync sync_event opens a launch window. Every hud_data
// tick inside the window is collected per device; when the window closes we
// print a per-launch report: time-to-target per device, spread, snap counts,
// and a PASS/FAIL against LAUNCH_TARGET_MS within LAUNCH_TARGET_S.
let _launch = null; // { kind, t0, devices: { id → { ticks:[{dtMs,drift}], snap0, convergedAtMs } }, timer }
let _masterTick = null; // latest { position, ts } master reference (DJ anchor preferred)
let _masterFromAnchor = false; // once the DJ anchor is heard, bridge ticks are ignored

function openLaunchWindow(kind, deviceId) {
  const now = Date.now();
  if (_launch && now - _launch.t0 < 3000) {
    // Same launch seen from another device — don't restart the window
    return;
  }
  if (_launch) closeLaunchWindow('superseded');
  _launch = { kind, t0: now, firstDevice: deviceId, devices: {}, timer: setTimeout(() => closeLaunchWindow('window end'), LAUNCH_WINDOW_MS) };
  console.log(`\n🚀 LAUNCH DETECTED (${kind}) — observing ${LAUNCH_WINDOW_MS/1000}s…`);
}

function launchTick(id, drift, snapCount) {
  if (!_launch) return;
  // One row per physical phone: ter_/dev_ prefixes are two reporting layers
  // of the same device. Prefer the ter layer (canonical, has snap counts) —
  // ignore the dev layer whenever a ter row for the same suffix exists.
  const suffix = id.replace(/^(ter_|dev_)/, '');
  if (id.startsWith('dev_') && _launch.devices['ter_' + suffix]) return;
  const dtMs = Date.now() - _launch.t0;
  if (dtMs > LAUNCH_WINDOW_MS) return;
  const d = _launch.devices[id] ??= { ticks: [], snap0: snapCount ?? null, convergedAtMs: null };
  d.ticks.push({ dtMs, drift, snapCount: snapCount ?? null });
  if (d.convergedAtMs === null && Math.abs(drift) < LAUNCH_TARGET_MS) d.convergedAtMs = dtMs;
}

function closeLaunchWindow(reason) {
  if (!_launch) return;
  clearTimeout(_launch.timer);
  const L = _launch; _launch = null;
  // launchTick's dev_-skip only works when the ter_ row arrived first; if the
  // dev layer ticked first its row was already created. Re-dedupe at report
  // time so one phone never grades (and fails) twice.
  // Grade ONLY ter_ rows (the engine's own drift). Legacy dev_ rows measure
  // against whatever reference their layer holds and produced every fake
  // multi-second "scattered entry" alarm on 2026-07-07 — informational only.
  const allIds = Object.keys(L.devices).filter(id =>
    !(id.startsWith('dev_') && L.devices['ter_' + id.replace(/^dev_/, '')]));
  const ids = allIds.filter(id => id.startsWith('ter_')).length
    ? allIds.filter(id => id.startsWith('ter_')) : allIds;
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`🚀 LAUNCH REPORT (${L.kind}, ${reason}) — ${ids.length} devices`);
  if (!ids.length) { console.log('  (no device ticks during window)\n'); return; }
  // A graded row that ENDS tens of seconds off means the window straddled a
  // reference re-mint (hard_sync ghost) — the room isn't scattered, the ruler
  // moved. Judged on the final tick only: every normal launch begins with a
  // huge transient (old position vs new reference) that a max-based check
  // would flag, ghosting all grading.
  const ghost = ids.some(id => Math.abs(L.devices[id].ticks.at(-1).drift) > 10000);
  if (ghost) {
    console.log('  ⚠ REFERENCE GHOST — window straddled a re-mint; not graded');
    console.log('─'.repeat(62) + '\n');
    return;
  }
  let pass = true;
  for (const id of ids) {
    const d = L.devices[id];
    const drifts = d.ticks.map(t => Math.abs(t.drift));
    const maxD = Math.round(Math.max(...drifts));
    const lastD = Math.round(d.ticks.at(-1).drift);
    const snaps = (d.ticks.at(-1).snapCount != null && d.snap0 != null)
      ? d.ticks.at(-1).snapCount - d.snap0 : null;
    const conv = d.convergedAtMs;
    const ok = conv !== null && conv <= LAUNCH_TARGET_S;
    if (!ok) pass = false;
    const mOff = devices[id]?.masterOffMs;
    console.log(`  ${ok ? '✓' : '✗'} ${id}  converged=${conv !== null ? (conv/1000).toFixed(1)+'s' : 'never'}  max=${maxD}ms  final=${lastD}ms${snaps !== null ? `  snaps=${snaps}` : ''}${mOff != null ? `  master=${mOff}ms` : ''}  (${d.ticks.length} ticks)`);
  }
  // Two separate goods (plan "Listenable Entry"): SPREAD is what ears hear
  // (max−min of final drifts — listenability); MASTER is the median offset
  // vs the bridge's master_tick (alignment — feeds the zone_offset_ms knob).
  const finals = ids.map(id => L.devices[id].ticks.at(-1).drift);
  const spread = Math.round(Math.max(...finals) - Math.min(...finals));
  const spreadPass = spread < LAUNCH_SPREAD_PASS_MS;
  const mOffs = ids.map(id => devices[id]?.masterOffMs).filter(v => v != null).sort((a, b) => a - b);
  const masterMedian = mOffs.length ? mOffs[Math.floor(mOffs.length / 2)] : null;
  console.log(`  SPREAD ${spreadPass ? '✅' : '❌'} ${spread}ms (listenability, target <${LAUNCH_SPREAD_PASS_MS}ms)`);
  if (masterMedian !== null)
    console.log(`  MASTER ${Math.abs(masterMedian) < MASTER_PASS_MS ? '✅' : '❌'} median ${masterMedian}ms vs master clock (target <${MASTER_PASS_MS}ms — trim zone_offset_ms by ${-masterMedian}ms)`);
  console.log(`  convergence: target |drift|<${LAUNCH_TARGET_MS}ms within ${LAUNCH_TARGET_S/1000}s`);
  console.log(`  ${pass && spreadPass ? '✅ PASS — entered synced' : '❌ FAIL — scattered entry'}`);
  console.log('─'.repeat(62) + '\n');
  csvStream.write(`# LAUNCH ${new Date(L.t0).toISOString()} kind=${L.kind} devices=${ids.length} spread=${spread} masterMedian=${masterMedian ?? ''} pass=${pass && spreadPass}\n`);
}

// ── Stall detection ───────────────────────────────────────────────────────────
function detectStall(dev, drift, label) {
  const prev = dev.ticks.at(-1);
  if (!prev) return;
  const jump = drift - prev.drift;
  if (jump >= STALL_DETECT_MS && Math.abs(drift) < 2000 && Math.abs(prev.drift) < 2000) {
    dev.stalls.push(jump);
    if (dev.stalls.length > 50) dev.stalls.shift();
  }
  // P→N transition
  if (prev.label === 'CONVERGED' && label === 'DIVERGING' && Math.abs(jump) < 2000) {
    dev.pnTransitions.push({ ts: Date.now(), fromDrift: prev.drift, toDrift: drift, jump });
    if (dev.pnTransitions.length > 100) dev.pnTransitions.shift();
  }
}

// ── Per-device stats ──────────────────────────────────────────────────────────
function stats(dev) {
  const t = dev.ticks;
  if (t.length < 3) return null;

  const valid = t.filter(x => Math.abs(x.drift) < 2000);
  const drifts = valid.map(x => x.drift).sort((a, b) => a - b);
  const med = drifts[Math.floor(drifts.length / 2)] ?? 0;
  const max = Math.max(...drifts.map(Math.abs));

  const P = t.filter(x => x.label === 'CONVERGED').length;
  const Z = t.filter(x => x.label === 'NEGOTIATING').length;
  const N = t.filter(x => x.label === 'DIVERGING').length;
  const total = t.length || 1;

  const stallMed = dev.stalls.length
    ? [...dev.stalls].sort((a,b)=>a-b)[Math.floor(dev.stalls.length/2)]
    : 0;

  const recentPN = dev.pnTransitions.slice(-10);
  const pnMed = recentPN.length
    ? [...recentPN.map(x=>x.jump)].sort((a,b)=>a-b)[Math.floor(recentPN.length/2)]
    : 0;

  return {
    n: t.length,
    med: Math.round(med),
    max: Math.round(max),
    P: Math.round(100*P/total),
    Z: Math.round(100*Z/total),
    N: Math.round(100*N/total),
    stalls: dev.stalls.length,
    stallMed: Math.round(stallMed),
    pnCount: dev.pnTransitions.length,
    pnMed: Math.round(pnMed),
    last: dev.ticks.at(-1),
  };
}

// ── Terminal report ───────────────────────────────────────────────────────────
let packetCount = 0;
let lastReportAt = Date.now();

function report(final = false) {
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const header = final ? 'FINAL REPORT' : 'STATUS';
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`BYOB MONITOR — ${header}  ${elapsed}s · ${packetCount} pkts · ${Object.keys(devices).length} devices`);
  console.log(`Log: ${csvPath}`);
  console.log('═'.repeat(62));

  const active = Object.values(devices).filter(d => {
    const last = d.ticks.at(-1);
    return last && (Date.now() - last.ts) < 15000;
  });

  if (!active.length) {
    console.log('  (no active devices — waiting for listeners with HUD open)\n');
    return;
  }

  for (const dev of active) {
    const s = stats(dev);
    if (!s) continue;
    const stateBar = `P=${s.P}% Z=${s.Z}% N=${s.N}%`;
    const stallInfo = s.stalls > 0
      ? `  stall med=${s.stallMed}ms (${s.stalls} detected)`
      : '  no stalls';
    const pnInfo = s.pnCount > 0
      ? `  P→N jumps=${s.pnCount} med=${s.pnMed}ms`
      : '';

    const driftColor = s.N > 50 ? '⚠' : s.P > 30 ? '✓' : '~';

    console.log(`\n  ${driftColor} ${dev.id}  (${s.n} ticks)`);
    console.log(`    drift  med=${s.med}ms  max=${s.max}ms`);
    console.log(`    state  ${stateBar}`);
    console.log(`    ${stallInfo}${pnInfo}`);
    if (dev.calEvents.length) {
      dev.calEvents.slice(-2).forEach(e => console.log(`    ${e}`));
    }
  }

  const inactive = Object.values(devices).filter(d => {
    const last = d.ticks.at(-1);
    return !last || (Date.now() - last.ts) >= 15000;
  });
  if (inactive.length) {
    console.log(`\n  (silent: ${inactive.map(d=>d.id).join(', ')})`);
  }
  console.log();
}

// ── Live status line ──────────────────────────────────────────────────────────
function statusLine() {
  const active = Object.values(devices).filter(d => {
    const last = d.ticks.at(-1);
    return last && (Date.now() - last.ts) < 10000;
  });
  if (!active.length) {
    process.stdout.write(`\r  ${packetCount} pkts · waiting for listeners…   `);
    return;
  }
  const parts = active.map(d => {
    const last = d.ticks.at(-1);
    const label = last?.label === 'CONVERGED' ? 'P' : last?.label === 'NEGOTIATING' ? 'Z' : 'N';
    const drift = last ? `${Math.round(last.drift)}ms` : '?';
    return `${d.id.slice(-6)}:${label}/${drift}`;
  });
  process.stdout.write(`\r  ${packetCount} pkts · ${parts.join('  ')}   `);
}

// ── Subscribe ─────────────────────────────────────────────────────────────────
const startedAt = Date.now();
console.log(`\nBYOB Live Monitor — logging to ${csvPath}`);
console.log('Open listener.html on each machine with HUD panel open.');
console.log('Ctrl+C to stop.\n');

// The DJ anchor heartbeat is the master audio's ground truth (broadcast on
// the zone's sync channel every 5s). Subscribe to the active zone and prefer
// it over the bridge's master_tick, whose reference goes stale when launches
// don't pass through the bridge.
(async () => {
  try {
    const { data } = await db.from('zones').select('id,name').eq('active', true).limit(1).single();
    if (!data) return;
    db.channel(`sync_${data.id}`)
      .on('broadcast', { event: 'anchor' }, ({ payload: p }) => {
        if (p && isFinite(p.position) && isFinite(p.ts)) {
          _masterTick = { position: p.position, ts: p.ts };
          _masterFromAnchor = true;
        }
      })
      .subscribe();
    console.log(`Master source: DJ anchor on sync_${data.id} ("${data.name}")`);
  } catch (_) {}
})();

db.channel('byob_debug')
  .on('broadcast', { event: 'hud_data' }, ({ payload: p }) => {
    const id = p.deviceId;
    if (!id) return;

    // Accept both ter_ (ternary layer) and dev_ (legacy layer)
    const drift = parseFloat(p.driftMs);
    const label = p.terTritLabel || p.driftState || 'unknown';
    const rate  = parseFloat(p.playbackRate) || 1;

    if (!isFinite(drift) || Math.abs(drift) > 200000) return; // skip wrap artifacts

    const dev = getDevice(id);
    detectStall(dev, drift, label);
    launchTick(id, drift, p.terSnapCount != null ? parseInt(p.terSnapCount) : null);

    // Offset vs the bridge's master clock: device audible position (element
    // position minus BT latency) compared to the master_tick position
    // extrapolated to this HUD packet's server timestamp. Both timestamps are
    // server-clock based (hud ts = syncedNow(), tick ts = bridge serverNow()),
    // so no monitor-local clock enters the math. Wrapped to the loop length.
    if (_masterTick && p.ts && p.currentTime != null && p.duration) {
      const durMs = parseFloat(p.duration) * 1000;
      const audiblePos = parseFloat(p.currentTime) - (parseFloat(p.deviceLatencyMs) || 0) / 1000;
      const masterPos = _masterTick.position + (p.ts - _masterTick.ts) / 1000;
      let off = (audiblePos - masterPos) * 1000;
      if (durMs > 0) { off = ((off % durMs) + durMs) % durMs; if (off > durMs / 2) off -= durMs; }
      dev.masterOffMs = Math.round(off);
    }

    dev.ticks.push({ ts: Date.now(), drift, label, rate });
    if (dev.ticks.length > TICK_WINDOW) dev.ticks.shift();
    dev.lastLabel = label;
    dev.packetCount++;
    packetCount++;

    // Write to CSV
    const row = [
      new Date().toISOString(),
      id,
      Math.round(drift),
      label,
      rate.toFixed(4),
      p.terSnapCount ?? '',
      p.terLastFloor ?? '',
      p.terCalState  ?? '',
      p.terConsecN   ?? '',
    ].join(',');
    csvStream.write(row + '\n');

    statusLine();

    // Periodic full report
    if (Date.now() - lastReportAt >= REPORT_INTERVAL_MS) {
      lastReportAt = Date.now();
      process.stdout.write('\n');
      report();
    }
  })
  .on('broadcast', { event: 'master_tick' }, ({ payload: p }) => {
    // Bridge fallback only — its reference goes stale when launches happen
    // through artist.html rather than the bridge (observed: a 152s "master
    // offset"). The DJ anchor (below) is the live master audio and wins.
    if (p && isFinite(p.position) && isFinite(p.ts) && !_masterFromAnchor)
      _masterTick = { position: p.position, ts: p.ts };
  })
  .on('broadcast', { event: 'sync_event' }, ({ payload: p }) => {
    if (p?.kind === 'track_change' || p?.kind === 'hard_sync') {
      openLaunchWindow(p.kind, p.deviceId);
      return;
    }
    const CAL_KINDS = {
      ter_calibration:   '🔧 AUTO-CAL',
      ter_greenhorn_cal: '🌱 GREENHORN FAST-CAL',
      ter_crowd_prior:   '👥 CROWD PRIOR',
    };
    if (!CAL_KINDS[p?.kind]) return;
    const id = p.deviceId;
    if (!id) return;
    const dev = getDevice(id);
    const entry = `${CAL_KINDS[p.kind]}  floor=${p.floorMs}ms → correction=${p.correctionMs}ms  (#${p.calCount})`;
    dev.calEvents.push(entry);
    process.stdout.write(`\n  ${id}: ${entry}\n`);
  })
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Connected to byob_debug ✓\n');
    }
  });

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  process.stdout.write('\n');
  report(true);
  csvStream.end(() => {
    console.log(`\nLog saved: ${csvPath}`);
    process.exit(0);
  });
});
