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

function reanchor(bpm, beat) {
  _playbackStartedAt = computeStartedAt(bpm, beat);
  broadcastHardSync({ playback_started_at: _playbackStartedAt, resetOffsets: false });
  broadcastToUI({ type: 'link_state', bpm, beat, playback_started_at: _playbackStartedAt });
}

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
  const { data, error } = await db.from('zones').select('id,name,current_track_url,track_name,playback_started_at,zone_tracks,active').eq('active', true).order('created_at', { ascending: false }).limit(20);
  if (error) { console.error('[zones]', error.message); return []; }
  return data || [];
}

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
      // fetch zone to restore playback_started_at
      const { data } = await db.from('zones').select('playback_started_at,zone_tracks,track_name,current_track_url').eq('id', msg.zoneId).single();
      if (data?.playback_started_at) _playbackStartedAt = data.playback_started_at;
      broadcastToUI({ type: 'zone_loaded', zoneId: msg.zoneId, ...data });
      console.log(`[ui] zone → ${msg.zoneId}`);
      break;
    }

    case 'play': {
      const state = { bpm: link.getTempo(), beat: link.getBeat() };
      _playbackStartedAt = computeStartedAt(state.bpm, state.beat);
      broadcastHardSync({ playback_started_at: _playbackStartedAt, track_url: msg.track_url, track_name: msg.track_name, resetOffsets: false });
      // persist to zones table so phones that join later get the right anchor
      if (_activeZoneId) {
        await db.from('zones').update({ playback_started_at: _playbackStartedAt }).eq('id', _activeZoneId);
      }
      broadcastToUI({ type: 'link_state', bpm: state.bpm, beat: state.beat, playback_started_at: _playbackStartedAt });
      console.log(`[bridge] play → ${_playbackStartedAt}`);
      break;
    }

    case 'hard_sync': {
      const state = { bpm: link.getTempo(), beat: link.getBeat() };
      _playbackStartedAt = computeStartedAt(state.bpm, state.beat);
      broadcastHardSync({ playback_started_at: _playbackStartedAt, resetOffsets: true });
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
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
