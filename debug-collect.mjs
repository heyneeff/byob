// debug-collect.mjs — subscribe to byob_debug and write a timestamped CSV
// Usage: node debug-collect.mjs [duration-seconds]
// Default duration: 300s (5 minutes). Ctrl-C also exits cleanly.
//
// Output: byob-debug-session-<ISO>.csv in the current directory,
// identical format to debug.html's "Export CSV" button.

import './byob-shim.js';
const { createClient } = globalThis.supabase;
import { writeFileSync, appendFileSync } from 'fs';

const SUPABASE_URL      = 'http://localhost:3100';
const SUPABASE_ANON_KEY = 'local';

const durationMs = parseInt(process.argv[2] || '300', 10) * 1000;

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -1) + 'Z';
const outFile = `byob-debug-session-${ts}.csv`;

const HEADER = 'timestamp,kind,deviceId,build,browser,zone,elapsed,currentTime,expectedPos,driftMs,duration,deviceLatencyMs,outputLatencyMs,calOffset,syncState,playbackRate,driftState,driftPending,src,visibilityState,lastDriftCheckAgoMs,readyState,stallCount,isMuted,engineLagMs,snapCount,seekIntendedMs,seekMeasuredMs,note';

writeFileSync(outFile, HEADER + '\n');
console.log(`Writing to ${outFile} for ${durationMs / 1000}s (Ctrl-C to stop early)`);

function esc(v) {
  if (v == null) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function hud(p, now) {
  // hud_data payload → CSV row matching debug.html's export format
  const row = [
    now,
    'sync',
    esc(p.deviceId),
    esc(p.build),
    esc(p.browser),
    esc(p.zone),
    esc(p.elapsed),
    esc(p.currentTime),
    esc(p.expectedPos),
    esc(p.driftMs),
    esc(p.duration),
    esc(p.deviceLatencyMs),
    esc(p.outputLatencyMs),
    esc(p.calOffset),
    esc(p.syncState),
    esc(p.playbackRate),
    esc(p.driftState),
    esc(p.driftPending),
    esc(p.src),
    esc(p.visibilityState),
    esc(p.lastDriftCheckAgoMs),
    esc(p.readyState),
    esc(p.stallCount),
    esc(p.isMuted),
    esc(p.engineLagMs),
    esc(p.snapCount),
    esc(p.seekIntendedMs),
    esc(p.seekMeasuredMs),
    '',
  ];
  return row.join(',');
}

function health(p, now) {
  // listener_health payload fields (see broadcastDebug in listener.html):
  //   deviceId, zone, elapsed (=dist_m), currentTime (=Date.now()),
  //   expectedPos (=GPS lat;lng), driftMs (=dist_m again), deviceLatencyMs (=interval 0/1),
  //   channelOk (0/1), syncState (status string), src (bearing string), browser, build
  const row = [
    now, 'health',
    esc(p.deviceId), esc(p.build), esc(p.browser), esc(p.zone),
    esc(p.elapsed), esc(p.currentTime), esc(p.expectedPos), esc(p.driftMs),
    '', esc(p.deviceLatencyMs), '', '', esc(p.syncState), '', '', '', esc(p.src),
    '', '', '', '', '', '', '', '', '',
  ];
  return row.join(',');
}

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const seen = new Set();

const channel = db.channel('byob_debug')
  .on('broadcast', { event: 'hud_data' }, ({ payload: p }) => {
    const now = new Date().toISOString();
    appendFileSync(outFile, hud(p, now) + '\n');
  })
  .on('broadcast', { event: 'listener_health' }, ({ payload: p }) => {
    const now = new Date().toISOString();
    appendFileSync(outFile, health(p, now) + '\n');
  })
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') console.log('Connected to byob_debug channel');
    else if (status === 'CHANNEL_ERROR' || status === 'CLOSED') {
      console.error('Channel error:', status);
    }
  });

const timer = setTimeout(() => {
  console.log(`\nDone. ${outFile}`);
  channel.unsubscribe();
  process.exit(0);
}, durationMs);

process.on('SIGINT', () => {
  clearTimeout(timer);
  console.log(`\nStopped. ${outFile}`);
  channel.unsubscribe();
  process.exit(0);
});
