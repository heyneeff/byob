// BYOB Launch Cycler — fires a track launch every N seconds so live-monitor.mjs
// can grade synced entry repeatedly without waiting for natural track changes.
//
// Usage: node launch-cycler.mjs <zone_id> [intervalS=30]
//   Alternates the zone between its current track and the next zone_tracks
//   entry (or re-anchors the same track if only one), sending the same
//   hard_sync broadcast artist.html sends. Run against a TEST zone.
// Ctrl+C to stop.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://ohacvuwzvuifpyqckise.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9oYWN2dXd6dnVpZnB5cWNraXNlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5ODc4NTcsImV4cCI6MjA5MjU2Mzg1N30.EX_DF-hFaQQuA1R9cZMKgR6TwjubwP61Ph4Gwa87beY';

const zoneId    = process.argv[2];
const intervalS = parseInt(process.argv[3] || '30', 10);
if (!zoneId) {
  console.error('Usage: node launch-cycler.mjs <zone_id> [intervalS=30]');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// Clock offset vs server (same approach as bridge.mjs / listener.html)
let _clockOffset = 0;
async function measureClockOffset() {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const { data, error } = await db.rpc('server_now').single();
    const t1 = Date.now();
    const rtt = t1 - t0;
    if (!error && data && rtt < 400) {
      const ms = new Date(data).getTime();
      if (!isNaN(ms)) samples.push(ms - (t0 + rtt / 2));
    }
    await new Promise(r => setTimeout(r, 80));
  }
  if (samples.length) {
    samples.sort((a, b) => a - b);
    _clockOffset = samples[Math.floor(samples.length / 2)];
  }
}
const serverNow = () => Date.now() + _clockOffset;

const { data: zone, error } = await db.from('zones')
  .select('id,name,active,current_track_url,track_name,zone_tracks')
  .eq('id', zoneId).single();
if (error || !zone) { console.error('Zone not found:', error?.message); process.exit(1); }

// Build the track rotation: current track + any zone_tracks entries
const urls = new Set();
if (zone.current_track_url && !zone.current_track_url.startsWith('webrtc') && !zone.current_track_url.startsWith('livekit')) {
  urls.add(zone.current_track_url);
}
for (const u of Object.values(zone.zone_tracks || {})) if (u) urls.add(u);
const rotation = [...urls];
if (!rotation.length) { console.error('Zone has no file tracks to cycle.'); process.exit(1); }

await measureClockOffset();
const syncChannel = db.channel(`sync_${zoneId}`);
await new Promise(res => syncChannel.subscribe(s => { if (s === 'SUBSCRIBED') res(); }));

console.log(`\nLaunch cycler — zone "${zone.name}" (${zoneId})`);
console.log(`  ${rotation.length} track(s) in rotation, launching every ${intervalS}s. Ctrl+C to stop.\n`);

let n = 0;
async function launch() {
  n++;
  const url  = rotation[n % rotation.length];
  const name = `cycler launch #${n}`;
  const playAt    = serverNow() + 1500; // pre-Phase-1 lead; raise to 2500+ after scheduled start lands
  const startedAt = new Date(playAt).toISOString();

  await db.from('zones').update({
    current_track_url: url, track_name: name,
    playback_started_at: startedAt, play_at: playAt, play_from_s: 0,
  }).eq('id', zoneId);

  syncChannel.send({
    type: 'broadcast', event: 'hard_sync',
    payload: { resyncAt: playAt, playback_started_at: startedAt, track_url: url, track_name: name },
  });
  console.log(`🚀 #${n}  ${new Date().toISOString()}  ${url.split('/').pop()}`);
}

await launch();
const timer = setInterval(launch, intervalS * 1000);
setInterval(measureClockOffset, 30_000);

process.on('SIGINT', () => {
  clearInterval(timer);
  console.log(`\nStopped after ${n} launches.`);
  process.exit(0);
});
