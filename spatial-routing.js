// ════════════════════════════════════════════════════════════
// SPATIAL ROUTING — slot assignment, sweep/scatter offsets, BPM warp,
// and the cluster_assign / spatial_config / sweep_* broadcast handlers.
//
// Lives entirely separate from the sync engine on purpose: spatial/DJ-tool
// changes go here, never into listener.html's sync-engine block
// (see CLAUDE.md invariants — "spatial/DJ-tool logic must stay separate
// from the sync engine's reference/corrector code").
//
// This is a module script (loaded via <script type="module" src=
// "spatial-routing.js">), deferred like sync/sync-engine.js's wiring module
// — by the time any broadcast handler fires, this module has already run.
// Per the documented pattern (see listener.html's sync-engine module
// comment), top-level `let`/`const`/`function` declarations in the page's
// classic <script> live in the realm's shared global environment, so this
// module reads/writes them directly: userLat, userLng, liveGuests,
// activeZone, audio, _deviceLatencyMs, _scatterOffsetMs, syncedNow,
// cancelDriftCorrection, seekPreservingBT, loadTrack, showToast, boomSay,
// getBearing, distM, simpleHash, showPlayerTipBtn, listenerId.
//
// The ONLY way spatial code may move playback position is the standard
// coordinated-snap pattern: cancelDriftCorrection() then seekPreservingBT()
// (or window.SyncEngine.expectedPosition() to compute the target). Never
// touch audio.currentTime directly, never bypass cancelDriftCorrection().
// ════════════════════════════════════════════════════════════

// ── Bearing-quadrant self-assignment ──────────────────────────────────────
// Deterministic — every listener runs the same algo on the same data,
// result: self-organizing clusters with no server round-trip.
function getSlot(config) {
  if (!userLat || !config?.zone_lat) return 'C';

  const voices  = config.voices || 4;
  const zoneLat = config.zone_lat;
  const zoneLng = config.zone_lng;

  const myDist = distM(userLat, userLng, zoneLat, zoneLng);
  const myBearing = getBearing(zoneLat, zoneLng, userLat, userLng);

  const allListeners = Object.values(liveGuests || {});
  if (!allListeners.length) return 'C'; // solo = center

  // Listeners within 30m radial distance of me = my cluster
  const myCluster = allListeners.filter(l => l.dist != null && Math.abs(l.dist - myDist) < 30);

  const clusterBearing = myCluster.length
    ? myCluster.reduce((sum, l) => sum + (l.bearing || 0), myBearing) / (myCluster.length + 1)
    : myBearing;

  const slotKeys = Object.keys(config.zone_tracks || {}).filter(k => k !== 'C');
  if (!slotKeys.length) return 'C';

  const slotCount = Math.min(slotKeys.length, voices);
  const sector = 360 / slotCount;
  const slotIdx = Math.floor(((clusterBearing % 360) + sector / 2) % 360 / sector) % slotCount;

  return slotKeys[slotIdx] || 'C';
}

// ── Master BPM warp ────────────────────────────────────────────────────────
// Returns the playbackRate base the drift corrector should treat as "1.0" —
// see CLAUDE.md "Master BPM + scene launcher".
function getBpmWarpRate() {
  const masterBpm = window._masterBPM;
  if (!masterBpm) return 1.0;
  const config = window._spatialConfig;
  if (!config) return 1.0;
  const mySlot = getSlot(config);
  const trackBpm = (window._trackBpms || {})[mySlot];
  if (!trackBpm) return 1.0;
  return Math.max(0.25, Math.min(4.0, masterBpm / trackBpm));
}

function applyBpmWarp(slot, url) {
  const masterBpm = window._masterBPM;
  if (!masterBpm) { audio.playbackRate = 1.0; return; }
  const trackBpms = window._trackBpms || {};
  let trackBpm = trackBpms[slot];
  if (!trackBpm) {
    // Fall back to scanning all slots for a URL match
    const config = window._spatialConfig;
    if (config?.zone_tracks) {
      for (const [s, u] of Object.entries(config.zone_tracks)) {
        if (u === url && trackBpms[s]) { trackBpm = trackBpms[s]; break; }
      }
    }
  }
  if (!trackBpm) return; // unknown BPM — don't warp
  const rate = masterBpm / trackBpm;
  audio.playbackRate = Math.max(0.25, Math.min(4.0, rate));
}

// ── Per-slot volume (DJ mix) ──────────────────────────────────────────────
// Pure audio.volume gain — never touches currentTime/playbackRate/
// playback_started_at, so it can't affect drift correction or the seek
// formula. Re-applied whenever this listener's slot assignment changes.
function applySlotVolume(slot) {
  const vols = window._slotVolumes || {};
  audio.volume = vols[slot] ?? 1;
}

// ── Per-slot volume-pulse FX (tremolo) ────────────────────────────────────
// Modulates audio.volume on top of the slot's base volume, phase-locked to
// syncedNow() so every listener's pulse lands on the same beat. Like
// applySlotVolume, this is pure audio.volume — never touches currentTime,
// playbackRate, or playback_started_at, so it can't interact with the drift
// corrector (see CLAUDE.md "Sync engine" invariants).
let _fxLoopId = null;
function startFxLoop() {
  if (_fxLoopId) return;
  function tick() {
    const config = window._spatialConfig || {};
    const mySlot = getSlot(config);
    const baseVol = (window._slotVolumes || {})[mySlot] ?? 1;
    const fx = (window._slotFx || {})[mySlot];
    if (fx?.type === 'pulse' && window._masterBPM) {
      const beatMs = (60000 / window._masterBPM) * (fx.beats || 1);
      const phase = (syncedNow() % beatMs) / beatMs;
      const depth = fx.depth ?? 0.6;
      const mod = 1 - depth * 0.5 * (1 - Math.cos(2 * Math.PI * phase));
      audio.volume = Math.max(0, Math.min(1, baseVol * mod));
    } else {
      audio.volume = baseVol;
    }
    _fxLoopId = requestAnimationFrame(tick);
  }
  tick();
}

// ── Circular sweep response ─────────────────────────────────────────────
// Each listener delays based on when the sweep beam hits their bearing.
function applySweepOffset(sweep) {
  if (!userLat || !activeZone?.lat) return;

  const myBearing = getBearing(activeZone.lat, activeZone.lng, userLat, userLng);
  const rpm = sweep.rpm || 4;
  const dir = sweep.dir || 1;
  const msPerRev = (60 / rpm) * 1000;

  const startAngle = sweep.startAngle || 0;
  const angleDiff = ((myBearing - startAngle) * dir + 360) % 360;
  const delayMs = (angleDiff / 360) * msPerRev;

  _scatterOffsetMs = delayMs;

  setTimeout(() => {
    if (!audio.duration || !activeZone?.playback_started_at) return;
    cancelDriftCorrection();
    const elapsed = (syncedNow() - new Date(activeZone.playback_started_at).getTime()) / 1000;
    seekPreservingBT(window.SyncEngine.expectedPosition({
      elapsedS: elapsed, duration: audio.duration,
      deviceLatencyMs: _deviceLatencyMs, scatterOffsetMs: _scatterOffsetMs,
      warpRate: getBpmWarpRate(),
    }));
    showToast('◎ Sweep hit — ' + Math.round(delayMs) + 'ms');
  }, delayMs);
}

// ── Broadcast handlers (sync_{zone_id} channel) ───────────────────────────

function onSpatialConfig(payload) {
  window._spatialConfig = payload;
  window._masterBPM = payload.master_bpm || null;
  window._trackBpms = payload.track_bpms || {};
  if (payload.slot_volumes) window._slotVolumes = payload.slot_volumes;
  if (payload.slot_fx) window._slotFx = payload.slot_fx;
  if (payload.suggested_donation) { window._suggestedDonation = payload.suggested_donation; showPlayerTipBtn(); }
  if (payload.tip_url) { window._zoneTipUrl = payload.tip_url; showPlayerTipBtn(); }

  const mySlot = getSlot(payload);
  applySlotVolume(mySlot);
  startFxLoop();
  const trackUrl = payload.zone_tracks?.[mySlot] || payload.zone_tracks?.['C'];
  if (trackUrl && trackUrl !== audio.src) {
    loadTrack(trackUrl, 'Zone ' + mySlot, payload.playback_started_at);
    showToast('🔊 Slot ' + mySlot);
  } else if (trackUrl && trackUrl === audio.src) {
    applyBpmWarp(mySlot, trackUrl);
    // Scene fires reset playback_started_at for the whole zone. A listener
    // whose stem didn't change must still adopt the new reference point —
    // otherwise it limps on the old one until fastDriftCorrect ducks it
    // (up to 5s late). Forced snap, same family as hard_sync/scatter.
    const newStart = payload.playback_started_at ? new Date(payload.playback_started_at).getTime() : null;
    const curStart = activeZone?.playback_started_at ? new Date(activeZone.playback_started_at).getTime() : null;
    if (newStart && audio.duration && (!curStart || Math.abs(newStart - curStart) > 250)) {
      if (activeZone) activeZone.playback_started_at = payload.playback_started_at;
      cancelDriftCorrection();
      const elapsed = (syncedNow() - newStart) / 1000;
      seekPreservingBT(window.SyncEngine.expectedPosition({
        elapsedS: elapsed, duration: audio.duration,
        deviceLatencyMs: _deviceLatencyMs, scatterOffsetMs: _scatterOffsetMs,
        warpRate: getBpmWarpRate(),
      }));
    }
  }
}

function onSweepStart(payload) {
  window._sweepConfig = payload;
  applySweepOffset(payload);
}

function onSweepStop() {
  window._sweepConfig = null;
  _scatterOffsetMs = 0;
}

function onScatter(payload) {
  const maxMs = payload.maxMs || 1000;
  const voices = payload.voices || 4;
  const slot = simpleHash(listenerId) % voices;
  _scatterOffsetMs = voices > 1 ? Math.round((slot / (voices - 1)) * maxMs) : 0;
  boomSay(`♩ +${(_scatterOffsetMs / 1000).toFixed(2)}s`, 1800, false, 'devious');
  // A scatter offset is a deliberate shift of the reference point itself —
  // not drift to be corrected gradually. Cancel and snap immediately, same
  // family as hard_sync/resync_at/sweep (see SYNC_ENGINE.md step 5).
  if (activeZone?.playback_started_at && audio.duration) {
    cancelDriftCorrection();
    const elapsed = (syncedNow() - new Date(activeZone.playback_started_at).getTime()) / 1000;
    seekPreservingBT(window.SyncEngine.expectedPosition({
      elapsedS: elapsed, duration: audio.duration,
      deviceLatencyMs: _deviceLatencyMs, scatterOffsetMs: _scatterOffsetMs,
      warpRate: getBpmWarpRate(),
    }));
  }
}

function onClusterAssign(payload) {
  const mySlot = payload.assignments?.[listenerId];
  const trackUrl = mySlot
    ? (payload.zone_tracks?.[mySlot] || payload.zone_tracks?.['C'])
    : payload.zone_tracks?.['C'];
  if (!trackUrl || trackUrl === audio.src) return;
  const label = 'Cluster ' + (mySlot || 'C');
  const waitMs = payload.play_at ? Math.max(0, payload.play_at - syncedNow()) : 0;
  setTimeout(() => {
    loadTrack(trackUrl, label, payload.playback_started_at);
    applySlotVolume(mySlot || 'C');
    boomSay('⬡ ' + (mySlot || 'C'), 2000, false, 'regular');
  }, waitMs);
}

// ── Broadcast handler: standalone per-slot volume update ──────────────────
// Sent independently of spatial_config so a volume tweak never re-broadcasts
// zone_tracks/playback_started_at (which would trigger a coordinated re-seek
// on every listener via onSpatialConfig's reference-point check above).
function onSlotVolume(payload) {
  window._slotVolumes = payload.slot_volumes || {};
  const mySlot = getSlot(window._spatialConfig || {});
  applySlotVolume(mySlot);
}

// ── Broadcast handler: standalone per-slot FX update ──────────────────────
// Sent independently of spatial_config, same reasoning as onSlotVolume —
// toggling a pulse FX must never re-broadcast zone_tracks/playback_started_at.
function onSlotFx(payload) {
  window._slotFx = payload.slot_fx || {};
  startFxLoop();
}

window.SpatialRouting = {
  getSlot, getBpmWarpRate, applyBpmWarp, applySweepOffset, applySlotVolume,
  onSpatialConfig, onSweepStart, onSweepStop, onScatter, onClusterAssign, onSlotVolume, onSlotFx,
};
