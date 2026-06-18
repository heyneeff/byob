// byob-player.js — minimal sync-enabled audio player library for BYOB
//
// join(zoneId, audioEl, callbacks) — listener joins a zone, audio plays synced
// cast(zoneId, trackUrl, trackName) — DJ broadcasts a track to all listeners
//
// Pass an already-created Supabase client: new BYOBPlayer({ db })

import {
  createSyncEngine,
  computeClockOffset,
  expectedPosition,
} from './sync/sync-engine.js';

const DRIFT_SNAP_MS = 150;  // mirrors DRIFT_SNAP_THRESHOLD_MS in listener.html
const DRIFT_TICK_MS = 5000;
const CLOCK_TICK_MS = 30000;
const DEBUG_TICK_MS = 3000;

export class BYOBPlayer {
  constructor({ db }) {
    this.db        = db;
    this._offset   = 0;
    this._deviceId = 'party-' + Math.random().toString(36).slice(2, 8);
  }

  syncedNow() { return Date.now() + this._offset; }

  async _measureOffset(n = 5) {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      const { data } = await this.db.rpc('server_now').single();
      const t1 = Date.now();
      samples.push({ t0, t1, serverMs: data ? new Date(data).getTime() : null });
    }
    const off = computeClockOffset(samples);
    if (off != null) this._offset = off;
  }

  // DJ: update zone record + broadcast hard_sync so all listeners snap immediately
  async cast(zoneId, trackUrl, trackName) {
    await this._measureOffset();
    const startedAt = new Date(this.syncedNow()).toISOString();
    const { error } = await this.db.from('zones').update({
      current_track_url:   trackUrl,
      track_name:          trackName,
      playback_started_at: startedAt,
      play_at:             null,
      play_from_s:         null,
    }).eq('id', zoneId);
    if (error) throw error;

    // Subscribe to sync channel, send hard_sync, then leave
    const ch = this.db.channel(`sync_${zoneId}`);
    await new Promise(resolve => {
      ch.subscribe(status => {
        if (status !== 'SUBSCRIBED') return;
        ch.send({
          type: 'broadcast', event: 'hard_sync',
          payload: {
            resyncAt:            this.syncedNow() + 600,
            playback_started_at: startedAt,
            track_url:           trackUrl,
            track_name:          trackName,
            resetOffsets:        true,
          },
        });
        setTimeout(() => { ch.unsubscribe(); resolve(); }, 500);
      });
    });
    return startedAt;
  }

  // Listener: join a zone and start synced playback.
  // Loads the current track into audioEl, subscribes to sync/zone/presence channels,
  // and runs the same drift-correction loop as listener.html.
  // Returns a cleanup () => void.
  async join(zoneId, audioEl, {
    onListenerCount = () => {},
    onTrackChange   = () => {},
    onSync          = () => {},
  } = {}) {
    await this._measureOffset();

    const { data: zone, error } = await this.db
      .from('zones')
      .select('id, current_track_url, track_name, playback_started_at, listeners')
      .eq('id', zoneId)
      .single();
    if (error || !zone) throw new Error('Zone not found');

    let _startedAt = zone.playback_started_at
      ? new Date(zone.playback_started_at).getTime() : null;
    const _latencyMs = parseFloat(localStorage.getItem('byob_device_latency') || '0');
    let _trackUrl  = zone.current_track_url;

    onTrackChange({ name: zone.track_name || '', url: _trackUrl });
    onListenerCount(zone.listeners || 0);

    // Transport bridge — maps the audio element to the sync engine interface
    const transport = {
      get currentTime()   { return audioEl.currentTime; },
      set currentTime(v)  { audioEl.currentTime = v; },
      get playbackRate()  { return audioEl.playbackRate; },
      set playbackRate(v) { audioEl.playbackRate = v; },
      get volume()        { return audioEl.volume; },
      set volume(v)       { audioEl.volume = v; },
      get duration()      { return isFinite(audioEl.duration) ? audioEl.duration : null; },
      hasSrcObject:       () => !!audioEl.srcObject,
    };

    const engine = createSyncEngine({
      transport,
      timers: {
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: fn => requestAnimationFrame(fn),
        now: () => performance.now(),
      },
      clock:       { syncedNow: () => this.syncedNow() },
      getContext:  () => ({ playbackStartedAt: _startedAt, deviceLatencyMs: _latencyMs, scatterOffsetMs: 0 }),
      getBaseRate: () => 1.0,
    });

    const _seekToSync = () => {
      if (!_startedAt || !audioEl.duration) return;
      const elapsed = (this.syncedNow() - _startedAt) / 1000;
      const target  = expectedPosition({
        elapsedS: elapsed, duration: audioEl.duration,
        deviceLatencyMs: _latencyMs, scatterOffsetMs: 0,
      });
      audioEl.currentTime = Math.max(0, Math.min(target, audioEl.duration - 0.1));
    };

    audioEl.addEventListener('loadedmetadata', _seekToSync);
    if (_trackUrl) { audioEl.src = _trackUrl; audioEl.loop = true; }

    // Drift correction — mirrors fastDriftCorrect() in listener.html
    const driftTick = setInterval(() => {
      const lagMs = engine.computeLagMs();
      if (lagMs == null) return;
      engine.applyMicroCorrection(lagMs);
      if (Math.abs(lagMs) >= DRIFT_SNAP_MS) engine.requestCorrection(lagMs);
      onSync({ lagMs, driftState: engine.getDriftState() });
    }, DRIFT_TICK_MS);

    const clockTick = setInterval(() => this._measureOffset(), CLOCK_TICK_MS);

    // Debug bridge — broadcast hud_data to byob_debug so debug.html sees this device
    const _debugCh = this.db.channel('byob_debug').subscribe();
    const debugTick = setInterval(() => {
      const lagMs = engine.computeLagMs();
      _debugCh.send({
        type: 'broadcast', event: 'hud_data',
        payload: {
          deviceId:        this._deviceId,
          currentTime:     audioEl.currentTime,
          expectedPos:     lagMs != null ? audioEl.currentTime + lagMs / 1000 : null,
          driftMs:         lagMs,
          deviceLatencyMs: _latencyMs,
          playbackRate:    audioEl.playbackRate,
          driftState:      engine.getDriftState(),
          playing:         !audioEl.paused && audioEl.currentTime > 0,
          paused:          audioEl.paused,
          calOffset:       this._offset,
          trackUrl:        _trackUrl,
          source:          'byob-player',
        },
      });
    }, DEBUG_TICK_MS);

    // Sync channel — hard_sync and track changes from DJ
    const syncCh = this.db.channel(`sync_${zoneId}`)
      .on('broadcast', { event: 'hard_sync' }, ({ payload }) => {
        engine.cancelDriftCorrection();
        if (payload.track_url && payload.track_url !== _trackUrl) {
          _trackUrl = payload.track_url;
          audioEl.src = _trackUrl; audioEl.loop = true;
          onTrackChange({ name: payload.track_name || '', url: _trackUrl });
        }
        if (payload.playback_started_at) _startedAt = new Date(payload.playback_started_at).getTime();
        const delay = Math.max(0, (payload.resyncAt || this.syncedNow()) - this.syncedNow());
        setTimeout(() => { _seekToSync(); audioEl.play().catch(() => {}); }, delay);
      })
      .subscribe();

    // Zone postgres changes — DB-level track/state updates (60s polling backup)
    const zoneCh = this.db.channel(`zone_${zoneId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'zones', filter: `id=eq.${zoneId}`,
      }, ({ new: z }) => {
        if (z.current_track_url && z.current_track_url !== _trackUrl) {
          _trackUrl = z.current_track_url; audioEl.src = _trackUrl; audioEl.loop = true;
          onTrackChange({ name: z.track_name || '', url: _trackUrl });
        }
        if (z.playback_started_at) _startedAt = new Date(z.playback_started_at).getTime();
        onListenerCount(z.listeners || 0);
      })
      .subscribe();

    // Presence — live listener count via Supabase presence
    const presenceCh = this.db.channel(`presence_${zoneId}`, {
      config: { presence: { key: this._deviceId } },
    })
      .on('presence', { event: 'sync' }, () =>
        onListenerCount(Object.keys(presenceCh.presenceState()).length))
      .subscribe(async status => {
        if (status === 'SUBSCRIBED') await presenceCh.track({ joined_at: Date.now() });
      });

    return () => {
      clearInterval(driftTick);
      clearInterval(clockTick);
      clearInterval(debugTick);
      engine.cancelDriftCorrection();
      syncCh.unsubscribe();
      zoneCh.unsubscribe();
      presenceCh.unsubscribe();
      _debugCh.unsubscribe();
      audioEl.removeEventListener('loadedmetadata', _seekToSync);
    };
  }

  // ── Jam session — channel-only sync, no DB, no auth required ──────────────
  //
  // One call handles both host (jamId=null → generates a new session) and
  // guest (jamId=string → joins existing). Returns a session object.
  //
  // Session object:
  //   .jamId   — the session ID (put in URL as ?j=...)
  //   .jamUrl  — full shareable URL
  //   .cast(audioEl, url, name)  — broadcast a track + start playing locally
  //   .listen(audioEl)           — tune in (guest tap → start playing current track)
  //   .castFile(audioEl, file)   — upload then cast (requires anon auth + storage policy)
  //   .cleanup()
  //
  // audioEl must be passed to cast()/listen() on the first user-gesture call.
  // The page owns the AudioContext + AnalyserNode; pass audioEl after connecting it.
  jam(jamId = null, {
    onListenerCount = () => {},
    onTrackChange   = () => {},
    onSync          = () => {},
  } = {}) {
    const _id    = jamId || Math.random().toString(36).slice(2, 9);
    const _devId = 'd-' + Math.random().toString(36).slice(2, 8);
    const jamUrl = `${location.origin}${location.pathname}?j=${_id}`;

    let _audioEl     = null;
    let _trackUrl    = null, _trackName = null, _startedAtMs = null;
    let _engine      = null, _driftTick = null, _clockTick   = null;
    let _debugCh     = null;

    // Channel — broadcast only, no DB read/write
    const _ch = this.db.channel(`jam_${_id}`, { config: { presence: { key: _devId } } });

    // Anyone with the current track state answers state requests (late joiners)
    _ch.on('broadcast', { event: 'need_state' }, () => {
      if (!_trackUrl || !_startedAtMs) return;
      _ch.send({ type: 'broadcast', event: 'state', payload: {
        trackUrl: _trackUrl, trackName: _trackName,
        startedAt: new Date(_startedAtMs).toISOString(),
      }});
    });

    const _applyTrack = ({ trackUrl, trackName, startedAt }) => {
      _trackUrl    = trackUrl;
      _trackName   = trackName;
      _startedAtMs = new Date(startedAt).getTime();
      onTrackChange({ name: _trackName || '', url: _trackUrl });
      if (_audioEl) _playNow(_trackUrl, _startedAtMs);
    };
    _ch.on('broadcast', { event: 'cast'  }, ({ payload }) => _applyTrack(payload));
    _ch.on('broadcast', { event: 'state' }, ({ payload }) => { if (!_trackUrl) _applyTrack(payload); });

    _ch.on('presence', { event: 'sync' }, () =>
      onListenerCount(Object.keys(_ch.presenceState()).length));

    _ch.subscribe(async (status) => {
      if (status !== 'SUBSCRIBED') return;
      await _ch.track({ t: Date.now() });
      if (jamId) _ch.send({ type: 'broadcast', event: 'need_state', payload: {} });
    });

    // Start/restart audio — called once audioEl exists and a track URL is known
    const _playNow = (url, startedAtMs) => {
      if (_driftTick) { clearInterval(_driftTick); _driftTick = null; }
      if (_engine)    { _engine.cancelDriftCorrection(); _engine = null; }

      _audioEl.src  = url;
      _audioEl.loop = true;
      _audioEl.addEventListener('loadedmetadata', () => {
        const elapsed = (this.syncedNow() - startedAtMs) / 1000;
        const target  = expectedPosition({
          elapsedS: elapsed, duration: _audioEl.duration,
          deviceLatencyMs: 0, scatterOffsetMs: 0,
        });
        _audioEl.currentTime = Math.max(0, Math.min(target, _audioEl.duration - 0.1));
      }, { once: true });
      _audioEl.play().catch(() => {});

      const _st = startedAtMs;
      _engine = createSyncEngine({
        transport: {
          get currentTime()   { return _audioEl.currentTime; },
          set currentTime(v)  { _audioEl.currentTime = v; },
          get playbackRate()  { return _audioEl.playbackRate; },
          set playbackRate(v) { _audioEl.playbackRate = v; },
          get volume()        { return _audioEl.volume; },
          set volume(v)       { _audioEl.volume = v; },
          get duration()      { return isFinite(_audioEl.duration) ? _audioEl.duration : null; },
          hasSrcObject:       () => false,
        },
        timers: {
          setTimeout, clearTimeout, setInterval, clearInterval,
          requestAnimationFrame: fn => requestAnimationFrame(fn),
          now: () => performance.now(),
        },
        clock:       { syncedNow: () => this.syncedNow() },
        getContext:  () => ({ playbackStartedAt: _st, deviceLatencyMs: 0, scatterOffsetMs: 0 }),
        getBaseRate: () => 1.0,
      });

      _driftTick = setInterval(() => {
        const lag = _engine.computeLagMs();
        if (lag == null) return;
        _engine.applyMicroCorrection(lag);
        if (Math.abs(lag) >= DRIFT_SNAP_MS) _engine.requestCorrection(lag);
        onSync({ lagMs: lag, driftState: _engine.getDriftState() });
        if (_debugCh) _debugCh.send({ type: 'broadcast', event: 'hud_data', payload: {
          deviceId: _devId, currentTime: _audioEl.currentTime,
          expectedPos: _audioEl.currentTime + lag / 1000,
          driftMs: lag, deviceLatencyMs: 0, playbackRate: _audioEl.playbackRate,
          driftState: _engine.getDriftState(), playing: !_audioEl.paused,
          paused: _audioEl.paused, calOffset: this._offset, source: 'byob-jam',
        }});
      }, DRIFT_TICK_MS);
    };

    // First-use setup (requires audioEl to be connected to an AudioContext already)
    const _init = async (audioEl) => {
      if (_audioEl) return; // already initialized
      _audioEl   = audioEl;
      await this._measureOffset();
      _clockTick = setInterval(() => this._measureOffset(), CLOCK_TICK_MS);
      _debugCh   = this.db.channel('byob_debug').subscribe();
    };

    const session = {
      jamId: _id,
      jamUrl,

      // Guest: tune in — call on user gesture (tap JOIN)
      listen: async (audioEl) => {
        await _init(audioEl);
        if (_trackUrl && _startedAtMs) _playNow(_trackUrl, _startedAtMs);
      },

      // Host or guest: broadcast a track and start playing it
      cast: async (audioEl, url, name) => {
        await _init(audioEl);
        _trackUrl    = url;
        _trackName   = name || decodeURIComponent(url.split('/').pop().replace(/\.[^.]+$/, '')) || 'Track';
        _startedAtMs = this.syncedNow();
        onTrackChange({ name: _trackName, url: _trackUrl });
        _ch.send({ type: 'broadcast', event: 'cast', payload: {
          trackUrl: _trackUrl, trackName: _trackName,
          startedAt: new Date(_startedAtMs).toISOString(),
        }});
        _playNow(_trackUrl, _startedAtMs);
      },

      // Upload a file (needs anon auth — run migration_jam_anon_storage.sql first)
      // then cast it. Falls back to a local blob URL if upload fails.
      castFile: async (audioEl, file) => {
        let url = null;
        try {
          await this.db.auth.signInAnonymously();
          const path = `jams/${_id}/${Date.now()}-${file.name.replace(/[^a-z0-9._-]/gi, '_')}`;
          const { error } = await this.db.storage.from('boombox').upload(path, file, { contentType: file.type });
          if (!error) url = this.db.storage.from('boombox').getPublicUrl(path).data.publicUrl;
        } catch (_) { /* anon auth not enabled */ }
        if (!url) url = URL.createObjectURL(file); // local-only fallback
        await session.cast(audioEl, url, file.name.replace(/\.[^.]+$/, ''));
      },

      cleanup: () => {
        if (_driftTick) clearInterval(_driftTick);
        if (_clockTick) clearInterval(_clockTick);
        if (_engine)    _engine.cancelDriftCorrection();
        _ch.unsubscribe();
        _debugCh?.unsubscribe();
      },
    };
    return session;
  }
}
