/**
 * ternary/layer.js
 *
 * Ternary sync layer for BYOB listener.html.
 *
 * HOW TO WIRE IT IN (two lines, non-destructive):
 *
 *   1. In listener.html <head>:
 *      <script src="ternary/layer.js"></script>
 *
 *   2. Inside fastDriftCorrect(), right after computeLagMs():
 *      const lagMs = computeLagMs();
 *      window._terLayer?.tick(lagMs);   // ← add this line
 *      // ... rest of fastDriftCorrect unchanged ...
 *
 * That's it. No other changes to listener.html.
 * The layer reads drift, computes a trit, broadcasts it.
 * It never touches audio, playbackRate, or currentTime.
 *
 * What it does:
 *   - Converts lagMs → trit (N/Z/P)
 *   - Broadcasts trit on byob_debug channel (so overlay.html can read it)
 *   - Shows a small badge on the listener UI (optional, unobtrusive)
 *   - Collects trit history for export
 */

(function() {
  'use strict';

  // ── TRIT PRIMITIVES ──────────────────────────────────────────────────────
  const N = -1, Z = 0, P = 1;

  // Ternary uses 50ms snap threshold (vs BYOB's 150ms) — intervenes earlier
  const TER_SNAP_MS  = 50;
  const TER_MICRO_MS = 10;

  function driftToTrit(lagMs) {
    const abs = Math.abs(lagMs);
    if (abs >= TER_SNAP_MS)  return N; // diverging — needs snap
    if (abs >= TER_MICRO_MS) return Z; // negotiating — micro-correcting
    return P;                           // converged
  }

  const TRIT_NAME  = { [-1]: 'N', [0]: 'Z', [1]: 'P' };
  const TRIT_LABEL = { [-1]: 'DIVERGING', [0]: 'NEGOTIATING', [1]: 'CONVERGED' };
  const TRIT_COLOR = { [-1]: '#40c4f0', [0]: '#607080', [1]: '#f04880' };

  // ── STATE ─────────────────────────────────────────────────────────────────
  let _trit = Z;
  let _history = []; // [{ts, lagMs, trit}]
  let _channel = null;
  let _badge = null;
  let _tickCount = 0;
  let _snapCount = 0;

  // ── INIT ──────────────────────────────────────────────────────────────────
  function init() {
    // Wait for Supabase to be available (listener.html loads it first)
    if (!window.db) {
      setTimeout(init, 500);
      return;
    }
    _channel = window.db.channel('byob_debug');
    _channel.subscribe();

    createBadge();
    window._terLayer = { tick, history: () => _history, exportCSV };
    console.log('[ternary/layer] ready — TER_SNAP_MS=' + TER_SNAP_MS);
  }

  // ── TICK — called from fastDriftCorrect() ────────────────────────────────
  function tick(lagMs) {
    if (typeof lagMs !== 'number' || isNaN(lagMs)) return;

    _tickCount++;
    _trit = driftToTrit(lagMs);

    if (_trit === N) {
      // Diverging — snap to expected position using BYOB's own correction path.
      // cancelDriftCorrection clears any in-flight state first (BYOB invariant).
      // Only fires if the hooks are available (listener.html is wired up).
      if (typeof window._terCorrect === 'function' && typeof window._terExpectedNow === 'function') {
        const target = window._terExpectedNow();
        if (target != null) {
          window._terCorrect(target);
          _snapCount++;
          console.log('[ternary] snap', Math.round(lagMs) + 'ms → ' + target.toFixed(3) + 's');
        }
      } else {
        _snapCount++; // shadow count when hooks not yet available
      }
    }

    const row = { ts: Date.now(), lagMs: Math.round(lagMs), trit: TRIT_NAME[_trit] };
    _history.push(row);
    if (_history.length > 500) _history.shift();

    updateBadge(lagMs);
    broadcast(lagMs);
  }

  // ── BROADCAST — sends trit to byob_debug so overlay.html can read it ─────
  function broadcast(lagMs) {
    if (!_channel) return;
    try {
      _channel.send({
        type: 'broadcast',
        event: 'hud_data',   // use hud_data so debug.html + overlay both see it
        payload: {
          deviceId:        'ter_' + (window.listenerId || 'unknown').slice(0, 6),
          build:           'listener+ternary',
          driftMs:         Math.round(lagMs),
          terTrit:         TRIT_NAME[_trit],
          terTritLabel:    TRIT_LABEL[_trit],
          terSnapMs:       TER_SNAP_MS,
          terSnapCount:    _snapCount,
          terTickCount:    _tickCount,
          playbackRate:    window._audio?.playbackRate ?? 1,
          driftState:      window._driftState ?? 'unknown',
          currentTime:     window._audio?.currentTime ?? null,
          zone:            window.activeZone?.name ?? 'unknown',
        },
      });
    } catch (e) {
      // channel not ready yet — no-op
    }
  }

  // ── BADGE — small unobtrusive trit indicator on the listener UI ───────────
  function createBadge() {
    const el = document.createElement('div');
    el.id = 'ter-trit-badge';
    el.style.cssText = [
      'position:fixed',
      'bottom:12px',
      'right:12px',
      'width:40px',
      'height:40px',
      'border-radius:50%',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'font-family:monospace',
      'font-size:16px',
      'font-weight:bold',
      'opacity:0.7',
      'pointer-events:none',
      'z-index:9999',
      'border:2px solid currentColor',
      'transition:color 0.3s,background 0.3s',
      'background:#050312',
      'color:#607080',
    ].join(';');
    el.textContent = 'Z';
    document.body.appendChild(el);
    _badge = el;
  }

  function updateBadge(lagMs) {
    if (!_badge) return;
    const col = TRIT_COLOR[_trit];
    _badge.textContent = TRIT_NAME[_trit];
    _badge.style.color = col;
    _badge.style.borderColor = col;
    _badge.style.background = _trit === P ? '#001810' :
                               _trit === N ? '#001828' : '#050312';
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────
  function exportCSV() {
    if (!_history.length) return;
    const rows = ['ts,lagMs,trit', ..._history.map(r => `${r.ts},${r.lagMs},${r.trit}`)];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ternary-layer-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
