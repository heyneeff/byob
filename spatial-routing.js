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

// ── DJ-driven cluster assignment override ─────────────────────────────────
// Set by onClusterAssign when the DJ explicitly assigns this listener a slot
// (k-means cluster / ring / movement / remix). getSlot() honors that explicit
// assignment instead of recomputing a bearing-quadrant slot, as long as the
// assigned slot still has a track in the current zone_tracks — otherwise
// spatial_config's self-assignment silently overrides cluster_assign (audit
// finding E) and two listeners standing near each other both fall back to the
// same bearing slot.
//
// Deliberately NOT gated on playback_started_at matching the cluster_assign's:
// as of Jun 15 2026 broadcastAllZones() only mints a fresh playback_started_at
// on a full scene fire (restart=true), but a single clip launch/swap/stop
// still re-broadcasts spatial_config with the *preserved* reference — gating
// on a match would make _clusterSlot evaporate on the next scene fire and
// every listener would recompute bearing-quadrant slots, possibly converging
// onto the same track ("different listeners get different tracks, then start
// playing the same track"). The explicit assignment now persists until the
// NEXT cluster_assign, regardless of how many ordinary clip launches/scene
// fires happen in between.
let _clusterSlot = null;

// ── Bearing-quadrant self-assignment ──────────────────────────────────────
// Deterministic — every listener runs the same algo on the same data,
// result: self-organizing clusters with no server round-trip.
function getSlot(config) {
  if (_clusterSlot && config?.zone_tracks?.[_clusterSlot]) {
    return _clusterSlot;
  }
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
//
// Phase 5v (2026-06-15): temporarily disabled. A live debug session showed
// steady-state drift sitting ~140ms (vs sync-sim's ~12ms prediction) whenever
// playbackRate != 1.0, suggesting BPM warp eats into the micro-correction's
// +/-1.2% headroom. capture.html already pre-tempo-matches clips before
// upload (its edWarpBpm/edSnapBars render step), so runtime warp here is
// largely redundant. Flip BPM_WARP_ENABLED back to true once sync-sim models
// a non-1.0 base rate and the corrector is retuned for it.
const BPM_WARP_ENABLED = false;

function getBpmWarpRate() {
  if (!BPM_WARP_ENABLED) return 1.0;
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
  if (!BPM_WARP_ENABLED) { audio.playbackRate = 1.0; return; }
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
    // Yield audio.volume to whatever is mid-ramp — fadeAudioIn (listener.html,
    // sets window._volumeRampActive) and the drift corrector's seekWithDuck
    // (sync/sync-engine.js, driftState 'ducking') both ramp audio.volume over
    // ~1-4s. At 60fps this loop would stomp their ramp back to baseVol within
    // one frame, defeating fades and turning the corrector's audible duck
    // into a silent click. Resume once the ramp releases the gate.
    if (window._volumeRampActive || window.SyncEngine?.getDriftState?.() === 'ducking') {
      _fxLoopId = requestAnimationFrame(tick);
      return;
    }
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
  // Zone-wide timeline trim — applied inside syncedNow() (listener.html).
  // Only update when the field is present so unrelated broadcasts don't clear it.
  // A changed value is a step-function disturbance to every device's measured
  // drift, same in kind as an anchor-clock slew — without this, auto-cal reads
  // the step as ordinary latency error and partially eats it into
  // deviceLatencyMs, corrupting the real per-device floor (confirmed via sim
  // 2026-07-14: scenario A' — an uncorrected step lands in deviceLatencyMs,
  // holds wrong once the per-track budget exhausts). Gate it the same way the
  // anchor-clock already learned to.
  if (payload.zone_offset_ms != null) {
    const newOffset = parseFloat(payload.zone_offset_ms) || 0;
    if (newOffset !== window._zoneOffsetMs) window._terLayer?.noteExternalDisturbance?.();
    window._zoneOffsetMs = newOffset;
  }
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
    // Pass play_at/play_from_s through — a scene fire carries a scheduled
    // entry instant and loadTrack's seekToSync holds silent until it.
    loadTrack(trackUrl, 'Zone ' + mySlot, payload.playback_started_at, payload.play_at, payload.play_from_s);
    showToast('🔊 Slot ' + mySlot);
  } else if (trackUrl && trackUrl === audio.src) {
    // Don't call applyBpmWarp here — it writes audio.playbackRate directly,
    // fighting the drift corrector's micro-correction/warp state (the
    // corrector already reads the live BPM warp rate via getBaseRate() ==
    // _getBpmWarpRate() on its own ~5s tick). Rapid clip launches rebroadcast
    // spatial_config constantly; stomping playbackRate on every one of them
    // was overriding the corrector's in-progress micro-correction, producing
    // the rate sawing between 1.000/1.006 and drift never settling below
    // ~50ms (the "overcorrect"/snapping feel). A BPM-rate change still gets
    // picked up by the next correction tick, or immediately below if this
    // broadcast also carries a new playback_started_at (cancelDriftCorrection
    // resets playbackRate to the current getBaseRate()).
    // Scene fires reset playback_started_at for the whole zone. A listener
    // whose stem didn't change must still adopt the new reference point —
    // otherwise it limps on the old one until fastDriftCorrect ducks it
    // (up to 5s late). Forced snap, same family as hard_sync/scatter.
    const newStart = payload.playback_started_at ? new Date(payload.playback_started_at).getTime() : null;
    const curStart = activeZone?.playback_started_at ? new Date(activeZone.playback_started_at).getTime() : null;
    if (newStart && audio.duration && (!curStart || Math.abs(newStart - curStart) > 250)) {
      if (activeZone) { activeZone.playback_started_at = payload.playback_started_at; if (payload.play_at) activeZone.play_at = payload.play_at; }
      const schedWaitMs = payload.play_at ? payload.play_at - syncedNow() : 0;
      if (schedWaitMs > 250) {
        // Scheduled scene restart, same stem: hold on the current audio and
        // snap to the new reference exactly at play_at (+ this device's BT
        // latency, matching listener.html _armScheduledStart timing).
        setTimeout(() => {
          if (!audio.duration) return;
          cancelDriftCorrection();
          seekPreservingBT(Math.max(0, ((payload.play_from_s || 0) + window.SyncEngine.SEEK_STAB_S) % audio.duration));
        }, schedWaitMs + _deviceLatencyMs);
      } else {
      cancelDriftCorrection();
      const elapsed = (syncedNow() - newStart) / 1000;
      seekPreservingBT(window.SyncEngine.expectedPosition({
        elapsedS: elapsed, duration: audio.duration,
        deviceLatencyMs: _deviceLatencyMs, scatterOffsetMs: _scatterOffsetMs,
        warpRate: getBpmWarpRate(),
      }));
      }
    }
  } else if (!audio.paused) {
    // No track for this slot AND no Center fallback (DJ stopped the
    // scene/clip stack — zone_tracks came back empty). Without this, the
    // listener just keeps looping whatever was last loaded.
    audio.pause();
    showToast('⏸ DJ stopped playback');
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
  const assigned = payload.assignments?.[listenerId];
  // Remember this explicit assignment so later spatial_config broadcasts
  // (clip launches etc.) don't silently override it via bearing self-assign.
  //
  // If THIS listener is missing from `assignments` (e.g. their phone was
  // backgrounded >90s, got pruned from the DJ's liveListeners, and a
  // re-cluster fired before they reappeared), do NOT pin _clusterSlot to
  // 'C' — getSlot()'s `_clusterSlot && zone_tracks[_clusterSlot]` check
  // would then permanently short-circuit to Center on every future
  // spatial_config as soon as zone_tracks['C'] has a track (a shared
  // drone/root layer), bypassing bearing/cluster recompute entirely until
  // the next cluster_assign happens to include them again — "stuck on C"
  // after a long set as listeners cycle through background/foreground.
  // Clearing it instead falls through to bearing self-assignment, which
  // distributes this listener across the loaded personality stems like
  // everyone else.
  _clusterSlot = assigned || null;
  const mySlot = assigned || getSlot(payload);
  const trackUrl = payload.zone_tracks?.[mySlot] || payload.zone_tracks?.['C'];
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
