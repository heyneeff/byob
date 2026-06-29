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
  .on('broadcast', { event: 'sync_event' }, ({ payload: p }) => {
    if (p?.kind !== 'ter_calibration') return;
    const id = p.deviceId;
    if (!id) return;
    const dev = getDevice(id);
    const entry = `🔧 AUTO-CAL  floor=${p.floorMs}ms → correction=${p.correctionMs}ms  (#${p.calCount})`;
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
