// ════════════════════════════════════════════════════════════
// BYOB Link Bridge
//
// Ableton Link → Supabase realtime → 1000 phones
//
// 1. Clock sync  — measures offset vs Supabase server_now
// 2. Link sync   — reads tempo + beat timeline from Ableton Link
// 3. Supabase    — pushes hard_sync, spatial commands, slot FX
// 4. HTTP + WS   — serves localhost:3000 (spatial UI)
// ════════════════════════════════════════════════════════════

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { AbletonLink } from '@ktamas77/abletonlink';
import {
  startCapture, stopCapture, listAudioDevices, findBlackholeDevice,
  makeListenerToken, LIVEKIT_URL, ROOM_NAME
} from './stems.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────
const SUPABASE_URL      = 'https://ohacvuwzvuifpyqckise.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9oYWN2dXd6dnVpZnB5cWNraXNlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5ODc4NTcsImV4cCI6MjA5MjU2Mzg1N30.EX_DF-hFaQQuA1R9cZMKgR6TwjubwP61Ph4Gwa87beY';
const HTTP_PORT = 3000;
const WS_PORT   = 3001;

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json' };

// ── Runtime state ─────────────────────────────────────────────
let _clockOffset       = 0;
let _activeZoneId      = null;
let _syncChannel       = null;
let _presenceChannel   = null;
let _linkBpm           = 120;
let _linkBeat          = 0;
let _playbackStartedAt = null;
let _slotVolumes       = {};
let _slotFx            = {};
let _movementTimer     = null;
let _movementIndex     = 0;

const db   = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const link = new AbletonLink(120);
link.enable(true);
link.enableStartStopSync(true);

// When Ableton (or any Link peer) changes tempo, push to UI
link.setTempoCallback(bpm => {
  _linkBpm = bpm;
  broadcastToUI({ type: 'link_state', bpm, beat: _linkBeat, playback_started_at: _playbackStartedAt });
  sendSpatialConfig({ master_bpm: bpm });
});

// ── Clock sync ────────────────────────────────────────────────
async function measureClockOffset() {
  const samples = [];
  for (let i = 0; i < 8; i++) {
    try {
      const t0 = Date.now();
      const { data, error } = await db.rpc('server_now').single();
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (!error && data && rtt < 400) {
        const ms = new Date(data).getTime();
        if (!isNaN(ms)) samples.push(ms - (t0 + rtt / 2));
      }
    } catch (_) {}
    await sleep(80);
  }
  if (samples.length) {
    samples.sort((a, b) => a - b);
    _clockOffset = samples[Math.floor(samples.length / 2)];
    console.log(`[clock] offset ${_clockOffset > 0 ? '+' : ''}${_clockOffset}ms`);
  }
}

function serverNow() { return Date.now() + _clockOffset; }

setInterval(measureClockOffset, 30_000);

// ── Ableton Link ──────────────────────────────────────────────
setInterval(() => {
  const bpm  = link.getTempo();
  const beat = link.getBeat();

  if (Math.abs(bpm - _linkBpm) > 0.01) {
    _linkBpm = bpm;
    if (_playbackStartedAt) reanchor(bpm, beat);
    broadcastToUI({ type: 'link_state', bpm, beat, playback_started_at: _playbackStartedAt });
    sendSpatialConfig({ master_bpm: bpm });
  }
  _linkBeat = beat;

  // Pulse beat counter to UI at ~10Hz
  broadcastToUI({ type: 'beat_tick', bpm, beat });
}, 100);

function computeStartedAt(bpm, beat) {
  const msElapsed = (beat / bpm) * 60_000;
  return new Date(serverNow() - msElapsed).toISOString();
}

// Bar-quantized scheduled launch: the next Link bar boundary at least
// MIN_LAUNCH_LEAD_MS away. Phones preload silently during the lead and all
// enter together at play_at (listener.html _armScheduledStart).
const MIN_LAUNCH_LEAD_MS = 2500;
const BEATS_PER_BAR = 4;
function computeLaunchAt() {
  const bpm  = link.getTempo();
  const beat = link.getBeat();
  const msPerBeat = 60_000 / bpm;
  let target = Math.ceil(beat / BEATS_PER_BAR) * BEATS_PER_BAR;
  while ((target - beat) * msPerBeat < MIN_LAUNCH_LEAD_MS) target += BEATS_PER_BAR;
  const playAt = serverNow() + (target - beat) * msPerBeat;
  return { playAt, bpm, beat, leadMs: Math.round((target - beat) * msPerBeat) };
}

function reanchor(bpm, beat) {
  // Oracle 3.2→60 (Limitation): the bridge must never re-anchor from Link's
  // ABSOLUTE beat count — that measures time since Ableton's transport
  // started, not since the track launched, and each re-anchor jolted every
  // listener by 20-160s (observed live 2026-07-06, growing with transport
  // age). Tempo changes already propagate as master_bpm via spatial_config;
  // the wall-clock reference stays where the launch put it. The DJ anchor
  // heartbeat (artist.html) is the live ground truth for corrections.
  broadcastToUI({ type: 'link_state', bpm, beat, playback_started_at: _playbackStartedAt });
}

// ── Master tick — the master clock as a measurable broadcast ──────────────
// Every 5s, publish the bridge's own playback position on byob_debug so
// sync/live-monitor.mjs can print each device's offset vs the master clock
// (plan "Listenable Entry + Master-Clock Alignment", Piece 3). Same shape as
// the DJ anchor: { position, ts }, both server-clock based.
const _debugChannel = db.channel('byob_debug');

// ── Master verdict — the field watches the unwatched authority ────────────
// (Ternary research transfer, 2026-07-12, cast 47→9: the master's self-check
// references state its own adopt path writes, so it can't see its own slide
// — the −68s dawn bug. Every listener independently measures the master; a
// consensus over those measurements is an opinion the master doesn't write.)
// Per-device offset math copied from sync/live-monitor.mjs:326-333. A trit
// sign-vote (tcons, deadband ±50ms) plus the median must agree for 3
// consecutive ticks (~15s) before one master_verdict fires; re-arms after.
const VERDICT_DEADBAND_MS = 50;
const VERDICT_OFF_MS      = 150;
const VERDICT_MIN_DEVICES = 3;
const VERDICT_RUN_TICKS   = 3;
const tcons = (...ts) => { const s = ts.reduce((a, v) => a + v, 0); return s > 0 ? 1 : s < 0 ? -1 : 0; };
const _fieldOffsets = new Map(); // deviceId → { offMs, ts }
let _verdictRun = 0;

_debugChannel.on('broadcast', { event: 'hud_data' }, ({ payload: p }) => {
  if (!p?.deviceId || !_playbackStartedAt) return;
  const startedMs = new Date(_playbackStartedAt).getTime();
  if (isNaN(startedMs) || p.currentTime == null || !p.ts || !p.duration) return;
  const durMs = parseFloat(p.duration) * 1000;
  const audiblePos = parseFloat(p.currentTime) - (parseFloat(p.deviceLatencyMs) || 0) / 1000;
  const masterPos = (p.ts - startedMs) / 1000;
  let off = (audiblePos - masterPos) * 1000;
  if (!isFinite(off)) return;
  if (durMs > 0) { off = ((off % durMs) + durMs) % durMs; if (off > durMs / 2) off -= durMs; }
  _fieldOffsets.set(p.deviceId, { offMs: off, ts: Date.now() });
});
_debugChannel.subscribe();

setInterval(() => {
  if (!_playbackStartedAt) return;
  const startedMs = new Date(_playbackStartedAt).getTime();
  if (isNaN(startedMs)) return;
  const now = serverNow();
  try {
    _debugChannel.send({
      type: 'broadcast', event: 'master_tick',
      payload: { position: (now - startedMs) / 1000, ts: now, bpm: _linkBpm },
    });
  } catch (_) {}

  // Verdict pass — after the tick, judge the field's opinion of the master.
  for (const [id, o] of _fieldOffsets) if (Date.now() - o.ts > 30000) _fieldOffsets.delete(id);
  const offs = [..._fieldOffsets.values()].map(o => o.offMs);
  if (offs.length < VERDICT_MIN_DEVICES) { _verdictRun = 0; return; }
  const sorted = [...offs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const trits = offs.map(v => v > VERDICT_DEADBAND_MS ? 1 : v < -VERDICT_DEADBAND_MS ? -1 : 0);
  const consensus = tcons(...trits);
  // Wrap-ambiguity guard: a median further out than makes physical sense for
  // clock drift is a stale/foreign reference, not a verdict-worthy offset.
  if (consensus !== 0 && Math.abs(med) > VERDICT_OFF_MS && Math.abs(med) < 60000) {
    if (++_verdictRun >= VERDICT_RUN_TICKS) {
      _verdictRun = 0; // one verdict per sustained episode
      try {
        _debugChannel.send({
          type: 'broadcast', event: 'master_verdict',
          payload: { medianOffMs: Math.round(med), deviceCount: offs.length, ts: serverNow() },
        });
      } catch (_) {}
      console.log(`[verdict] field says master off by ${Math.round(med)}ms (${offs.length} devices)`);
      broadcastToUI({ type: 'master_verdict', medianOffMs: Math.round(med), deviceCount: offs.length });
    }
  } else {
    _verdictRun = 0;
  }
}, 5000);

// ── Supabase channels ─────────────────────────────────────────
function buildSyncChannel(zoneId) {
  if (_syncChannel) { try { _syncChannel.unsubscribe(); } catch (_) {} }
  _syncChannel = db.channel(`sync_${zoneId}`);
  _syncChannel.subscribe(status => {
    broadcastToUI({ type: 'channel_status', channel: 'sync', status });
  });
  console.log(`[supabase] sync_${zoneId}`);
}

function buildPresenceChannel(zoneId) {
  if (_presenceChannel) { try { _presenceChannel.unsubscribe(); } catch (_) {} }
  _presenceChannel = db.channel(`presence_${zoneId}`);
  _presenceChannel
    .on('broadcast', { event: 'presence' }, ({ payload }) => {
      broadcastToUI({ type: 'presence', payload });
    })
    .subscribe();
  console.log(`[supabase] presence_${zoneId}`);
}

// ── Broadcast helpers ─────────────────────────────────────────
function broadcastHardSync({ playback_started_at, resetOffsets = false, track_url, track_name }) {
  if (!_syncChannel) return;
  _syncChannel.send({
    type: 'broadcast', event: 'hard_sync',
    payload: { resyncAt: serverNow() + 1000, playback_started_at, resetOffsets, track_url, track_name }
  });
}

function sendSpatialConfig(extra = {}) {
  if (!_syncChannel) return;
  _syncChannel.send({
    type: 'broadcast', event: 'spatial_config',
    payload: { master_bpm: _linkBpm, slot_volumes: _slotVolumes, slot_fx: _slotFx, ...extra }
  });
}

function broadcastClusterAssign(assignments, zoneTracks = {}) {
  if (!_syncChannel) return;
  _syncChannel.send({
    type: 'broadcast', event: 'cluster_assign',
    payload: {
      assignments,
      zone_tracks: zoneTracks,
      playback_started_at: _playbackStartedAt,
      play_at: serverNow() + 400,
    }
  });
}

// ── Zone management ───────────────────────────────────────────
async function fetchZones() {
  // No .order('created_at') — if that column errors the query silently
  // returned [] and the UI showed no zones even with an active zone live.
  const { data, error } = await db.from('zones').select('id,name,current_track_url,track_name,playback_started_at,zone_tracks,active').eq('active', true).limit(20);
  if (error) { console.error('[zones]', error.message); return []; }
  if (data?.length) return data;
  // No active zones (they deactivate when a broadcast ends). The bridge IS
  // the broadcaster, so offer recent zones — selecting one re-activates it.
  const recent = await db.from('zones').select('id,name,current_track_url,track_name,playback_started_at,zone_tracks,active').order('playback_started_at', { ascending: false, nullsFirst: false }).limit(10);
  if (recent.error) { console.error('[zones]', recent.error.message); return []; }
  return recent.data || [];
}

function connectZone(z, how) {
  _activeZoneId = z.id;
  buildSyncChannel(z.id);
  buildPresenceChannel(z.id);
  if (z.playback_started_at) _playbackStartedAt = z.playback_started_at;
  broadcastToUI({ type: 'zone_loaded', zoneId: z.id, ...z });
  console.log(`[zones] ${how} → "${z.name}" (${z.id})`);
}

// Auto-connect: if exactly one zone is active, select it without a click.
// Also FOLLOW the broadcast: artist.html's zone creation deactivates the
// host's old zones and mints a new id — if the bridge stays pinned to the
// dead id it broadcasts into sync_{old} while every phone listens on the new
// zone (observed live 2026-07-07). set_zone re-activates whatever the UI
// picks, so a manual selection stays active and is never yanked away here.
async function autoSelectZone() {
  const zones = await fetchZones();
  const active = zones.filter(z => z.active);
  if (_activeZoneId) {
    const mine = zones.find(z => z.id === _activeZoneId);
    if ((!mine || !mine.active) && active.length === 1) {
      connectZone(active[0], `followed (superseded ${_activeZoneId})`);
    }
    return;
  }
  if (zones.length === 1) {
    connectZone(zones[0], 'auto-connected');
  } else if (zones.length) {
    broadcastToUI({ type: 'zones', zones });
  }
}
setInterval(autoSelectZone, 10_000);

// ── Movement mode ─────────────────────────────────────────────
function startMovement({ pattern = 'wave', intervalMs = 4000, phones = [], slots = [] }) {
  stopMovement();
  if (!phones.length || !slots.length) return;

  function tick() {
    const assignments = {};
    phones.forEach((id, i) => {
      let slotIdx;
      if (pattern === 'wave')   slotIdx = (i + _movementIndex) % slots.length;
      if (pattern === 'pulse')  slotIdx = _movementIndex % slots.length;
      if (pattern === 'orbit')  slotIdx = Math.floor((i + _movementIndex) / slots.length) % slots.length;
      if (pattern === 'swing')  slotIdx = _movementIndex % 2 === 0 ? i % slots.length : (slots.length - 1 - i % slots.length);
      assignments[id] = slots[slotIdx ?? 0];
    });
    broadcastClusterAssign(assignments);
    _movementIndex++;
  }

  tick();
  _movementTimer = setInterval(tick, intervalMs);
  console.log(`[movement] ${pattern} every ${intervalMs}ms`);
}

function stopMovement() {
  if (_movementTimer) { clearInterval(_movementTimer); _movementTimer = null; }
  _movementIndex = 0;
}

// ── WebSocket ─────────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });
const uiClients = new Set();

wss.on('connection', ws => {
  uiClients.add(ws);
  ws.send(JSON.stringify({
    type: 'state',
    bpm: _linkBpm,
    beat: _linkBeat,
    zoneId: _activeZoneId,
    playback_started_at: _playbackStartedAt,
    slotVolumes: _slotVolumes,
    slotFx: _slotFx,
  }));
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    handleUIMessage(msg, ws);
  });
  ws.on('close', () => uiClients.delete(ws));
});

function broadcastToUI(obj) {
  const data = JSON.stringify(obj);
  for (const ws of uiClients) if (ws.readyState === 1) ws.send(data);
}

async function handleUIMessage(msg, ws) {
  switch (msg.type) {

    case 'get_zones': {
      const zones = await fetchZones();
      ws.send(JSON.stringify({ type: 'zones', zones }));
      break;
    }

    case 'set_zone': {
      _activeZoneId = msg.zoneId;
      buildSyncChannel(msg.zoneId);
      buildPresenceChannel(msg.zoneId);
      // Selecting a zone from the bridge ACTIVATES it — the bridge is the
      // broadcaster, so picking a zone means "broadcast here" (no artist.html
      // round-trip needed to reactivate after a stopped session).
      await db.from('zones').update({ active: true }).eq('id', msg.zoneId);
      // fetch zone to restore playback_started_at
      const { data } = await db.from('zones').select('name,playback_started_at,zone_tracks,track_name,current_track_url').eq('id', msg.zoneId).single();
      if (data?.playback_started_at) _playbackStartedAt = data.playback_started_at;
      broadcastToUI({ type: 'zone_loaded', zoneId: msg.zoneId, ...data });
      console.log(`[ui] zone → ${msg.zoneId}`);
      break;
    }

    case 'play': {
      // Scheduled synced entry: anchor to the next bar boundary ≥2.5s out.
      // Phones preload muted during the lead and enter together at play_at.
      const { playAt, bpm, beat, leadMs } = computeLaunchAt();
      _playbackStartedAt = new Date(playAt).toISOString();
      if (_syncChannel) {
        _syncChannel.send({
          type: 'broadcast', event: 'hard_sync',
          payload: { resyncAt: playAt, playback_started_at: _playbackStartedAt,
                     track_url: msg.track_url, track_name: msg.track_name, resetOffsets: false }
        });
      }
      // persist to zones table so phones that join later get the right anchor
      if (_activeZoneId) {
        await db.from('zones').update({
          playback_started_at: _playbackStartedAt, play_at: playAt, play_from_s: 0,
          ...(msg.track_url ? { current_track_url: msg.track_url, track_name: msg.track_name } : {}),
        }).eq('id', _activeZoneId);
      }
      broadcastToUI({ type: 'link_state', bpm, beat, playback_started_at: _playbackStartedAt, launch_in_ms: leadMs });
      console.log(`[bridge] play → launches in ${leadMs}ms at ${_playbackStartedAt} (next bar @ ${bpm.toFixed(1)}bpm)`);
      break;
    }

    case 'hard_sync': {
      // Use the EXISTING reference — never recompute from Link's absolute
      // beat (oracle 3.2→60, see reanchor()). A sync command snaps everyone
      // to the current timeline; it must not move the timeline itself.
      if (!_playbackStartedAt && _activeZoneId) {
        const { data } = await db.from('zones').select('playback_started_at').eq('id', _activeZoneId).single();
        _playbackStartedAt = data?.playback_started_at || null;
      }
      if (_playbackStartedAt) {
        broadcastHardSync({ playback_started_at: _playbackStartedAt, resetOffsets: true });
      }
      break;
    }

    case 'single': {
      stopMovement();
      if (!_syncChannel) break;
      sendSpatialConfig({ voices: 'single' });
      break;
    }

    case 'cluster': {
      stopMovement();
      const { phones, slots, k, zoneTracks } = msg;
      // Simple bearing-based k assignment
      const assignments = {};
      const sorted = [...phones].sort((a, b) => (a.bearing || 0) - (b.bearing || 0));
      const segSize = Math.ceil(sorted.length / k);
      sorted.forEach((p, i) => { assignments[p.deviceId] = slots[Math.min(Math.floor(i / segSize), slots.length - 1)]; });
      broadcastClusterAssign(assignments, zoneTracks || {});
      break;
    }

    case 'ring': {
      stopMovement();
      const { phones: rPhones, slots: rSlots, zoneTracks: rTracks } = msg;
      const sorted = [...rPhones].sort((a, b) => (a.dist || 0) - (b.dist || 0));
      const segSize = Math.ceil(sorted.length / rSlots.length);
      const assignments = {};
      sorted.forEach((p, i) => { assignments[p.deviceId] = rSlots[Math.min(Math.floor(i / segSize), rSlots.length - 1)]; });
      broadcastClusterAssign(assignments, rTracks || {});
      break;
    }

    case 'scatter': {
      if (!_syncChannel) break;
      _syncChannel.send({ type: 'broadcast', event: 'scatter', payload: { maxMs: msg.maxMs, voices: msg.voices } });
      break;
    }

    case 'sweep_start': {
      if (!_syncChannel) break;
      _syncChannel.send({ type: 'broadcast', event: 'sweep_start', payload: msg.payload });
      break;
    }

    case 'sweep_stop': {
      if (!_syncChannel) break;
      _syncChannel.send({ type: 'broadcast', event: 'sweep_stop', payload: {} });
      break;
    }

    case 'movement': {
      startMovement(msg);
      break;
    }

    case 'movement_stop': {
      stopMovement();
      break;
    }

    case 'slot_volume': {
      _slotVolumes[msg.slot] = msg.value;
      sendSpatialConfig();
      break;
    }

    case 'slot_fx': {
      if (msg.enabled) _slotFx[msg.slot] = { type: 'pulse', depth: 0.6, beats: 1 };
      else delete _slotFx[msg.slot];
      if (!_syncChannel) break;
      _syncChannel.send({ type: 'broadcast', event: 'slot_fx', payload: { slot_fx: _slotFx } });
      break;
    }

    case 'get_audio_devices': {
      const devices = listAudioDevices();
      const blackhole = findBlackholeDevice();
      ws.send(JSON.stringify({ type: 'audio_devices', devices, blackholeIndex: blackhole?.id ?? null }));
      break;
    }

    case 'start_stems': {
      // msg: { deviceIndex, slotCount }
      try {
        await startCapture({
          deviceIndex: msg.deviceIndex,
          slotCount:   msg.slotCount || 4,
          onStatus: (text, isErr) => broadcastToUI({ type: 'stems_status', text, isErr }),
        });

        // Generate a shared audience token for all phones (subscribe-only)
        const token = await makeListenerToken('byob-audience', 'all');

        // Broadcast livekit config to phones via sync channel
        if (_syncChannel) {
          _syncChannel.send({
            type: 'broadcast', event: 'spatial_config',
            payload: {
              livekit_url:   LIVEKIT_URL,
              livekit_room:  ROOM_NAME,
              livekit_token: token,
              current_track_url: 'livekit-live',
            }
          });
        }

        // Also update zones table so phones joining later get the live flag
        if (_activeZoneId) {
          await db.from('zones').update({ current_track_url: 'livekit-live' }).eq('id', _activeZoneId);
        }

        broadcastToUI({ type: 'stems_live', slotCount: msg.slotCount });
        console.log('[bridge] stems live');
      } catch (err) {
        broadcastToUI({ type: 'stems_status', text: err.message, isErr: true });
      }
      break;
    }

    case 'stop_stems': {
      await stopCapture();
      if (_syncChannel) {
        _syncChannel.send({
          type: 'broadcast', event: 'spatial_config',
          payload: { current_track_url: null, livekit_url: null }
        });
      }
      broadcastToUI({ type: 'stems_status', text: 'Stems stopped', isErr: false });
      break;
    }

    case 'rally': {
      if (!_syncChannel) break;
      _syncChannel.send({ type: 'broadcast', event: 'rally', payload: { lat: msg.lat, lng: msg.lng, label: msg.label } });
      break;
    }

    case 'set_tempo': {
      // Pushes tempo into Ableton Link — all peers (Ableton + phones) follow
      link.setTempo(msg.bpm);
      _linkBpm = msg.bpm;
      broadcastToUI({ type: 'link_state', bpm: msg.bpm, beat: _linkBeat, playback_started_at: _playbackStartedAt });
      break;
    }

    case 'spatial_config': {
      sendSpatialConfig(msg.payload || {});
      break;
    }
  }
}

// ── HTTP server ───────────────────────────────────────────────
const http = createServer((req, res) => {
  const url  = req.url === '/' ? '/index.html' : req.url;
  const path = join(__dir, 'ui', url);
  if (!existsSync(path)) { res.writeHead(404); res.end('not found'); return; }
  const ext  = extname(path);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
  res.end(readFileSync(path));
});

http.listen(HTTP_PORT, async () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║  BYOB Link Bridge                     ║`);
  console.log(`║  UI → http://localhost:${HTTP_PORT}           ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);
  await measureClockOffset();
  console.log('[link] Ableton Link enabled');
  console.log('[ready] Open http://localhost:3000\n');
  autoSelectZone(); // connect to the active zone immediately, no click needed
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
