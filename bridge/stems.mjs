// ════════════════════════════════════════════════════════════
// BYOB Stem Broadcaster
//
// Captures audio from Blackhole virtual channels (one per Ableton stem)
// and publishes each as a named Livekit track.
//
// Ableton routing (set up once in Ableton audio prefs):
//   Track 1 → Blackhole 64ch output ch 1/2
//   Track 2 → Blackhole 64ch output ch 3/4
//   Track 3 → Blackhole 64ch output ch 5/6
//   ...
//
// Each stereo pair → one Livekit audio track named "stem-C", "stem-1", etc.
// ════════════════════════════════════════════════════════════

import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { Room, LocalAudioTrack, AudioSource } from '@livekit/rtc-node';
import portAudio from 'naudiodon';

// ── Config (set via env or bridge.mjs) ───────────────────────
export const LIVEKIT_URL    = process.env.LIVEKIT_URL    || 'wss://your-project.livekit.cloud';
export const LIVEKIT_KEY    = process.env.LIVEKIT_KEY    || '';
export const LIVEKIT_SECRET = process.env.LIVEKIT_SECRET || '';
export const ROOM_NAME      = process.env.LIVEKIT_ROOM   || 'byob-live';

// Slot names — must match BYOB slot keys
const SLOT_NAMES = ['C', '1', '2', '3', '4', '5', '6', '7'];

// Audio capture constants
const SAMPLE_RATE   = 48000;
const CHANNELS_PER_STEM = 2;  // stereo per stem
const FRAMES        = 480;    // 10ms @ 48kHz

// ── State ─────────────────────────────────────────────────────
let _room        = null;
let _captureStream = null;
let _audioSources = {};   // slotName → AudioSource
let _tracks       = {};   // slotName → LocalAudioTrack
let _running      = false;
let _slotCount    = 1;    // how many stems to capture

// ── Token generation ──────────────────────────────────────────
export function makePublisherToken(identity = 'byob-bridge') {
  const at = new AccessToken(LIVEKIT_KEY, LIVEKIT_SECRET, { identity });
  at.addGrant({ roomJoin: true, room: ROOM_NAME, canPublish: true, canSubscribe: false });
  return at.toJwt();
}

export function makeListenerToken(identity, slot) {
  const at = new AccessToken(LIVEKIT_KEY, LIVEKIT_SECRET, { identity });
  // Listener can subscribe but not publish; metadata carries their slot
  at.addGrant({ roomJoin: true, room: ROOM_NAME, canPublish: false, canSubscribe: true });
  at.metadata = JSON.stringify({ slot });
  return at.toJwt();
}

// ── List available audio devices ──────────────────────────────
export function listAudioDevices() {
  return portAudio.getDevices().filter(d => d.maxInputChannels > 0);
}

export function findBlackholeDevice() {
  const devices = portAudio.getDevices();
  return devices.find(d =>
    d.name.toLowerCase().includes('blackhole') && d.maxInputChannels >= 2
  ) || null;
}

// ── Start capturing stems from Blackhole ──────────────────────
export async function startCapture({ deviceIndex, slotCount = 4, onStatus }) {
  if (_running) await stopCapture();
  _slotCount = slotCount;
  _running   = true;

  const totalChannels = slotCount * CHANNELS_PER_STEM;

  status(`Starting capture: ${slotCount} stems on device ${deviceIndex}`, onStatus);

  // Create one AudioSource + LocalAudioTrack per stem slot
  for (let i = 0; i < slotCount; i++) {
    const slot = SLOT_NAMES[i];
    _audioSources[slot] = new AudioSource(SAMPLE_RATE, CHANNELS_PER_STEM);
    _tracks[slot]       = LocalAudioTrack.createAudioTrack(`stem-${slot}`, _audioSources[slot]);
  }

  // Publish tracks to Livekit room
  await publishTracks(onStatus);

  // Open Blackhole input stream — all channels at once
  _captureStream = new portAudio.AudioIO({
    inOptions: {
      channelCount:  totalChannels,
      sampleFormat: portAudio.SampleFormat16Bit,
      sampleRate:   SAMPLE_RATE,
      deviceId:     deviceIndex,
      closeOnError: true,
    }
  });

  _captureStream.on('data', buf => {
    if (!_running) return;
    // Deinterleave: buf is [ch0L, ch0R, ch1L, ch1R, ...] per sample
    // Split into per-stem buffers and push to AudioSource
    const samplesPerFrame = buf.length / 2 / totalChannels; // int16 = 2 bytes
    for (let i = 0; i < slotCount; i++) {
      const slot   = SLOT_NAMES[i];
      const src    = _audioSources[slot];
      if (!src) continue;

      // Extract stereo pair for this slot
      const out = Buffer.alloc(samplesPerFrame * CHANNELS_PER_STEM * 2);
      for (let f = 0; f < samplesPerFrame; f++) {
        const srcOff = (f * totalChannels + i * CHANNELS_PER_STEM) * 2;
        const dstOff = f * CHANNELS_PER_STEM * 2;
        buf.copy(out, dstOff, srcOff, srcOff + CHANNELS_PER_STEM * 2);
      }
      src.captureFrame(new Int16Array(out.buffer));
    }
  });

  _captureStream.on('error', err => {
    status(`Capture error: ${err.message}`, onStatus, true);
    _running = false;
  });

  _captureStream.start();
  status(`Capturing ${slotCount} stems live`, onStatus);
}

// ── Connect to Livekit and publish tracks ─────────────────────
async function publishTracks(onStatus) {
  if (!LIVEKIT_KEY || !LIVEKIT_SECRET) {
    status('⚠ No Livekit credentials — set LIVEKIT_URL, LIVEKIT_KEY, LIVEKIT_SECRET', onStatus, true);
    return;
  }

  _room = new Room();
  const token = makePublisherToken('byob-bridge');

  status('Connecting to Livekit…', onStatus);
  await _room.connect(LIVEKIT_URL, token);
  status(`Livekit connected — room: ${ROOM_NAME}`, onStatus);

  for (const [slot, track] of Object.entries(_tracks)) {
    await _room.localParticipant.publishTrack(track, {
      name: `stem-${slot}`,
      source: 'microphone',  // treated as live audio
    });
    status(`Published stem-${slot}`, onStatus);
  }
}

// ── Stop capture ──────────────────────────────────────────────
export async function stopCapture() {
  _running = false;
  if (_captureStream) { try { _captureStream.quit(); } catch (_) {} _captureStream = null; }
  if (_room)          { try { await _room.disconnect(); } catch (_) {} _room = null; }
  _audioSources = {};
  _tracks       = {};
}

// ── Generate listener token (called by bridge for each phone) ─
export async function getLivekitToken(identity, slot) {
  return makeListenerToken(identity, slot);
}

// ── Room info ─────────────────────────────────────────────────
export async function getRoomInfo() {
  if (!LIVEKIT_KEY) return null;
  const svc = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_KEY, LIVEKIT_SECRET);
  try {
    const rooms = await svc.listRooms([ROOM_NAME]);
    return rooms[0] || null;
  } catch { return null; }
}

function status(msg, cb, isErr = false) {
  if (cb) cb(msg, isErr);
  console.log(`[stems] ${msg}`);
}
