/**
 * ternary/orchid.js — Iowa string tape warp machine
 *
 * Three University of Iowa string samples, one per ternary role.
 * Warp LFO depth scales with own drift magnitude — the flutter IS the lag.
 * Bloom fires when the whole room holds P consensus for ~45 sustained seconds.
 *
 * Samples (Iowa Electronic Music Studios, unrestricted use):
 *   sepal.wav — Cello arco ff sul A, A3 (220Hz) — diverging, heavy bow
 *   petal.wav — Cello arco mf sul A, A3 (220Hz) — settling, warm
 *   lip.wav   — Violin arco pp sul A, A4 (440Hz) — converged, pure
 */

(function () {
  'use strict';

  const N = -1, Z = 0, P = 1;

  const ROLE_NAME  = { [-1]: 'SEPAL', [0]: 'PETAL', [1]: 'LIP' };
  const ROLE_COLOR = { [-1]: '#40c4f0', [0]: '#f57e20', [1]: '#f04880' };

  const SAMPLE_URLS = {
    [-1]: 'ternary/samples/sepal.wav',
    [ 0]: 'ternary/samples/petal.wav',
    [ 1]: 'ternary/samples/lip.wav',
  };

  const LOOP_START    = 0.35;   // skip bow-contact transient
  const LOOP_END      = 3.75;   // before scale continues
  const FADE_TIME_S   = 1.5;    // crossfade on role switch
  const BLOOM_TICK_MS = 5000;   // poll room consensus every 5s
  const BLOOM_NEEDED  = 9;      // 9 × 5s = 45s sustained room-P

  // Warp LFO: max depth (fraction of playbackRate) and rate (Hz)
  // depth = maxDepth × clamp(|lagMs| / 200, 0, 1)
  const WARP_MAX  = { [-1]: 0.072, [0]: 0.022, [1]: 0.0 };
  const WARP_RATE = { [-1]: 0.27,  [0]: 0.13,  [1]: 0.0 };

  // ── Audio state ───────────────────────────────────────────────
  let _ctx         = null;
  let _masterGain  = null;
  let _source      = null;
  let _sourceGain  = null;
  let _lfoOsc      = null;
  let _lfoGain     = null;
  let _currentTrit = null;
  let _running     = false;

  // ── Bloom state ───────────────────────────────────────────────
  let _bloomConsecP = 0;
  let _bloomFired   = false;
  let _bloomTimer   = null;
  let _peerTrits    = {};
  let _peerChannel  = null;

  // ── Raw ArrayBuffers (fetched without audio context) ──────────
  const _rawAB = {};
  // AudioBuffers decoded into these once ctx exists
  const _bufs  = {};

  // ── Helpers ───────────────────────────────────────────────────
  function ownTrit() {
    const h = window._terLayer?.history?.();
    if (!h?.length) return Z;
    const t = h[h.length - 1]?.trit;
    return t === 'P' ? P : t === 'N' ? N : Z;
  }

  function ownLagMs() {
    const h = window._terLayer?.history?.();
    if (!h?.length) return 0;
    return Math.abs(h[h.length - 1]?.lagMs ?? 0);
  }

  function myId() {
    return 'ter_' + (window.listenerId || 'unknown').slice(0, 6);
  }

  function roomConsensus() {
    const now  = Date.now();
    const live = Object.values(_peerTrits)
      .filter(p => now - p.ts < 20000)
      .map(p => p.trit);
    const own = ownTrit();
    if (!live.length) return own;
    const sum = [own, ...live].reduce((a, v) => a + v, 0);
    return sum > 0 ? P : sum < 0 ? N : Z;
  }

  function warpDepth(trit) {
    const norm = Math.min(ownLagMs() / 200, 1);
    return (WARP_MAX[trit] ?? 0) * norm;
  }

  // ── Audio context ─────────────────────────────────────────────
  function ensureCtx() {
    if (_ctx) return _ctx;
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
    _masterGain = _ctx.createGain();
    _masterGain.gain.value = 0.75;
    _masterGain.connect(_ctx.destination);
    return _ctx;
  }

  async function decodeAll() {
    const ctx = ensureCtx();
    await Promise.all(
      Object.entries(_rawAB).map(async ([trit, ab]) => {
        if (_bufs[trit]) return;
        try {
          _bufs[trit] = await ctx.decodeAudioData(ab.slice(0));
        } catch (e) {
          console.warn('[orchid] decode failed for', ROLE_NAME[trit], e.message);
        }
      })
    );
    // Fetch anything that failed to prefetch
    await Promise.all(
      Object.entries(SAMPLE_URLS).map(async ([trit, url]) => {
        if (_bufs[trit]) return;
        try {
          const ab = await (await fetch(url)).arrayBuffer();
          _bufs[trit] = await ctx.decodeAudioData(ab);
        } catch (e) {
          console.warn('[orchid] sample load failed:', url, e.message);
        }
      })
    );
  }

  // ── Playback ──────────────────────────────────────────────────
  function playRole(trit) {
    const ctx = _ctx;
    if (!ctx || !_bufs[trit]) return;

    const now = ctx.currentTime;

    // Fade out old source
    if (_sourceGain) {
      _sourceGain.gain.setTargetAtTime(0, now, 0.4);
      const oldSrc = _source, oldLfo = _lfoOsc;
      setTimeout(() => {
        try { oldSrc?.stop(); } catch (e) {}
        try { oldLfo?.stop(); } catch (e) {}
      }, 2000);
    }

    // New source gain — fades in
    _sourceGain = ctx.createGain();
    _sourceGain.gain.setValueAtTime(0, now);
    _sourceGain.gain.linearRampToValueAtTime(1, now + FADE_TIME_S);
    _sourceGain.connect(_masterGain);

    // Looped sustain
    _source           = ctx.createBufferSource();
    _source.buffer    = _bufs[trit];
    _source.loop      = true;
    _source.loopStart = LOOP_START;
    _source.loopEnd   = Math.min(LOOP_END, _source.buffer.duration - 0.05);

    // Warp LFO
    const depth = warpDepth(trit);
    if (depth > 0.0005 && WARP_RATE[trit] > 0) {
      _lfoGain = ctx.createGain();
      _lfoGain.gain.setValueAtTime(depth, now);
      _lfoOsc = ctx.createOscillator();
      _lfoOsc.type = 'sine';
      _lfoOsc.frequency.value = WARP_RATE[trit];
      _lfoOsc.connect(_lfoGain);
      _lfoGain.connect(_source.playbackRate);
      _lfoOsc.start();
    } else {
      _lfoGain = null;
      _lfoOsc  = null;
    }

    _source.connect(_sourceGain);
    _source.start(now, LOOP_START);
    _currentTrit = trit;

    updateBadge(trit);
    console.log('[orchid]', ROLE_NAME[trit], '· warp', (depth * 100).toFixed(1) + '%');
  }

  function updateWarp() {
    if (!_ctx || !_lfoGain || !_lfoOsc || _currentTrit === null) return;
    const depth = warpDepth(_currentTrit);
    const now   = _ctx.currentTime;
    _lfoGain.gain.setTargetAtTime(depth, now, 0.8);
  }

  // ── Role / bloom tick ─────────────────────────────────────────
  function tick() {
    if (!_running) return;
    const trit = ownTrit();
    if (trit !== _currentTrit) {
      playRole(trit);
    } else {
      updateWarp();
    }
    checkBloom();
  }

  function checkBloom() {
    if (_bloomFired || !_running) return;
    if (roomConsensus() === P) { _bloomConsecP++; } else { _bloomConsecP = 0; }
    updateBadge(_currentTrit);
    if (_bloomConsecP >= BLOOM_NEEDED) fireBloom();
  }

  function fireBloom() {
    _bloomFired = true;
    console.log('[orchid] ☷ BLOOM — room P for 45s sustained');

    // Warp dissolves over 8 seconds
    if (_lfoGain && _ctx) {
      _lfoGain.gain.linearRampToValueAtTime(0, _ctx.currentTime + 8);
    }

    if (typeof window._terLayer?.onBloom === 'function') window._terLayer.onBloom();

    const bpm   = window._masterBPM ?? 90;
    const barMs = (60 / bpm) * 4 * 1000;  // one musical bar

    // Hold clean for 4 bars, then graceful fade
    setTimeout(() => {
      if (!_ctx || !_masterGain) return;
      const now = _ctx.currentTime;
      _masterGain.gain.linearRampToValueAtTime(0, now + (barMs * 4 / 1000));
      setTimeout(() => {
        stop();
        setTimeout(() => {
          _bloomFired   = false;
          _bloomConsecP = 0;
          if (_masterGain) _masterGain.gain.value = 0.75;
        }, 3000);
      }, barMs * 4 + 600);
    }, barMs * 4);
  }

  // ── Public API ────────────────────────────────────────────────
  async function start() {
    if (_running) return;
    ensureCtx();
    if (_ctx.state === 'suspended') await _ctx.resume();
    await decodeAll();

    _bloomFired   = false;
    _bloomConsecP = 0;

    playRole(ownTrit());
    _running    = true;
    _bloomTimer = setInterval(tick, BLOOM_TICK_MS);

    // Subscribe to peer trits from byob_ternary (independent of arp/layer channels)
    if (!_peerChannel && window.db) {
      _peerChannel = window.db.channel('byob_ternary')
        .on('broadcast', { event: 'trit' }, ({ payload }) => {
          if (payload?.deviceId && payload.deviceId !== myId()) {
            _peerTrits[payload.deviceId] = { trit: payload.trit, ts: Date.now() };
          }
        })
        .subscribe();
    }
  }

  function stop() {
    _running = false;
    if (_bloomTimer) { clearInterval(_bloomTimer); _bloomTimer = null; }
    const now = _ctx?.currentTime ?? 0;
    if (_sourceGain && _ctx) _sourceGain.gain.setTargetAtTime(0, now, 0.3);
    setTimeout(() => {
      try { _source?.stop(); } catch (e) {}
      try { _lfoOsc?.stop(); } catch (e) {}
      _source = _lfoOsc = _sourceGain = _lfoGain = null;
      _currentTrit = null;
    }, 1200);
    updateBadge(null);
  }

  function toggle() { _running ? stop() : start(); }

  // ── Badge ─────────────────────────────────────────────────────
  function updateBadge(trit) {
    const btn = document.getElementById('orchid-btn');
    if (!btn) return;
    if (!_running || trit === null) {
      btn.classList.remove('active');
      const r = btn.querySelector('.orchid-role');
      if (r) r.remove();
      return;
    }
    btn.classList.add('active');
    let role = btn.querySelector('.orchid-role');
    if (!role) {
      role = document.createElement('span');
      role.className = 'orchid-role';
      role.style.cssText = 'font-size:7px;letter-spacing:1px;display:block;margin-top:1px;';
      btn.appendChild(role);
    }
    const bloom = _bloomConsecP > 0 ? ` ${_bloomConsecP}/${BLOOM_NEEDED}` : '';
    role.textContent = ROLE_NAME[trit] + bloom;
    role.style.color = ROLE_COLOR[trit] ?? '#fff';

    // Mirror into layer badge
    const sub = document.getElementById('ter-badge-sub');
    if (sub) sub.textContent = ROLE_NAME[trit] ?? '';
  }

  // ── Prefetch samples without AudioContext (no user gesture needed) ─
  (async () => {
    for (const [trit, url] of Object.entries(SAMPLE_URLS)) {
      try {
        const res = await fetch(url);
        _rawAB[trit] = await res.arrayBuffer();
        console.log('[orchid] prefetched', ROLE_NAME[trit]);
      } catch (e) {
        console.warn('[orchid] prefetch failed:', url);
      }
    }
  })();

  window._terOrchid = { start, stop, toggle, ROLE_NAME, ROLE_COLOR };
  console.log('[orchid] Iowa tape warp machine — sepal · petal · lip · bloom@45s');
})();
