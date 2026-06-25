/**
 * ternary/pad.js  —  Drone pad layer
 *
 * Nils Frahm-style sustained texture: slow attack swell, detuned sine stack,
 * felt-piano notch, long reverb, glacially-paced filter LFO.
 *
 * Signal chain:
 *   [2 oscs per chord tone: sine (fundamental) + sine (slight detune)]
 *   → WaveShaper (gentle tanh saturation)
 *   → ADSR envelope (attack 1.2s, release 3s)
 *   → _padBus (mix gain)
 *   → felt notch (900Hz −4dB)
 *   → LP filter (brightness + slow LFO sweep)
 *   → [dry 30%] + [convolver IR 4s → wet 70%]
 *   → _padMaster → destination
 *
 * Shares window._arpAudioCtx with arp.js — whichever module starts first
 * creates the context and the other reuses it. This prevents dual-context
 * suspension on mobile browsers.
 */

(function () {
  'use strict';

  // ── Shared AudioContext ───────────────────────────────────────────────────────
  let _ctx = null;

  function ctx() {
    if (_ctx) return _ctx;
    _ctx = window._arpAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    // Share back so arp.js picks it up if it initializes after us
    if (!window._arpAudioCtx) window._arpAudioCtx = _ctx;
    return _ctx;
  }

  // ── State ─────────────────────────────────────────────────────────────────────
  let _running     = false;
  let _intervals   = [0, 4, 7];
  let _root        = 60;
  let _octaveShift = -1;
  let _mix         = 0.45;
  let _brightness  = 0.35;
  let _evolution   = 0.25;
  let _voices      = [];

  // ── Graph nodes ───────────────────────────────────────────────────────────────
  let _padBus      = null;
  let _feltNotch   = null;
  let _lpFilter    = null;
  let _filterLfo   = null;
  let _filterDepth = null;
  let _padDry      = null;
  let _convolver   = null;
  let _padWet      = null;
  let _padMaster   = null;
  let _satCache    = null;

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function midiToHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  function satCurve() {
    if (_satCache) return _satCache;
    const n = 512, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      c[i] = Math.tanh(x * 1.2) / Math.tanh(1.2);
    }
    return (_satCache = c);
  }

  function createReverbIR() {
    const sr  = ctx().sampleRate;
    const dur = 4.0;
    const len = Math.floor(sr * dur);
    const buf = ctx().createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const pre = Math.floor(sr * 0.018);
      // Early reflections
      const erDelays = [0.013, 0.023, 0.037, 0.055, 0.079];
      const erGains  = [0.55,  0.44,  0.36,  0.28,  0.20 ];
      erDelays.forEach((dly, i) => {
        const idx = Math.floor(dly * sr) + pre;
        if (idx < len) d[idx] += erGains[i] * (c === 0 ? 1 : -0.8);
      });
      // Diffuse tail
      for (let i = pre; i < len; i++) {
        const env = Math.pow(1 - (i - pre) / (len - pre), 1.2);
        d[i] += (Math.random() * 2 - 1) * env * 0.7;
      }
    }
    return buf;
  }

  // ── Piano inharmonicity (Railsback stretch) ───────────────────────────────────
  function inharmonicCents(midi) { return (midi - 60) * 0.22; }

  // ── Graph init ────────────────────────────────────────────────────────────────
  function initGraph() {
    if (_padBus) return;
    const c = ctx();

    _padBus = c.createGain();
    _padBus.gain.value = _mix;

    _feltNotch = c.createBiquadFilter();
    _feltNotch.type = 'notch';
    _feltNotch.frequency.value = 900;
    _feltNotch.Q.value = 2.5;

    _lpFilter = c.createBiquadFilter();
    _lpFilter.type = 'lowpass';
    _lpFilter.Q.value = 0.5;
    _lpFilter.frequency.value = brightnessToHz(_brightness);

    _filterLfo = c.createOscillator();
    _filterLfo.type = 'sine';
    _filterLfo.frequency.value = evolutionToFilterRate(_evolution);
    _filterDepth = c.createGain();
    _filterDepth.gain.value = filterLfoDepth(_brightness);
    _filterLfo.connect(_filterDepth);
    _filterDepth.connect(_lpFilter.frequency);
    _filterLfo.start();

    _convolver = c.createConvolver();
    _convolver.buffer = createReverbIR();
    _padDry = c.createGain(); _padDry.gain.value = 0.30;
    _padWet = c.createGain(); _padWet.gain.value = 0.70;

    _padMaster = c.createGain();
    _padMaster.gain.value = 0.36;

    _padBus.connect(_feltNotch);
    _feltNotch.connect(_lpFilter);
    _lpFilter.connect(_padDry);
    _lpFilter.connect(_convolver);
    _padDry.connect(_padMaster);
    _convolver.connect(_padWet);
    _padWet.connect(_padMaster);
    _padMaster.connect(c.destination);
  }

  // ── Frequency helpers ─────────────────────────────────────────────────────────
  function brightnessToHz(b)       { return 180 * Math.pow(38.9, b); }
  function filterLfoDepth(b)       { return 280 + Math.sin(b * Math.PI) * 820; }
  function evolutionToFilterRate(e){ return 0.025 * Math.pow(18, e); }

  // ── Voice management ──────────────────────────────────────────────────────────
  function spawnVoice(midi) {
    const c   = ctx();
    const hz  = midiToHz(midi + inharmonicCents(midi) / 100);
    const t   = c.currentTime;

    const shaper = c.createWaveShaper();
    shaper.curve = satCurve();
    shaper.oversample = '2x';

    const env = c.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1.0, t + 1.2);
    shaper.connect(env);
    env.connect(_padBus);

    // 2-oscillator stack: fundamental + detuned copy for natural beating
    const osc1 = c.createOscillator(); osc1.type = 'sine';
    const osc2 = c.createOscillator(); osc2.type = 'sine';
    const g1   = c.createGain(); g1.gain.value = 0.60;
    const g2   = c.createGain(); g2.gain.value = 0.40;

    osc1.frequency.value = hz;
    osc2.frequency.value = hz;
    osc1.detune.value    =  0;
    osc2.detune.value    = +11; // ~11 cents beating

    osc1.connect(g1); g1.connect(shaper);
    osc2.connect(g2); g2.connect(shaper);
    osc1.start(t); osc2.start(t);

    return { nodes: [osc1, osc2], env, midi };
  }

  function releaseVoice({ nodes, env }) {
    const t = ctx().currentTime;
    env.gain.cancelScheduledValues(t);
    env.gain.setValueAtTime(env.gain.value, t);
    env.gain.linearRampToValueAtTime(0, t + 3.0);
    setTimeout(() => nodes.forEach(n => { try { n.stop(); } catch (e) {} }), 4200);
  }

  function refreshVoices() {
    const c   = ctx();
    const now = c.currentTime;
    const old = _voices;
    _voices   = [];

    old.forEach(v => {
      v.env.gain.cancelScheduledValues(now);
      v.env.gain.setValueAtTime(v.env.gain.value, now);
      v.env.gain.linearRampToValueAtTime(0, now + 1.2);
      setTimeout(() => v.nodes.forEach(n => { try { n.stop(); } catch (e) {} }), 1800);
    });

    _intervals.forEach(iv => {
      const midi = _root + iv + _octaveShift * 12;
      _voices.push(spawnVoice(midi));
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  function start() {
    if (_running) return;
    initGraph();
    if (ctx().state === 'suspended') ctx().resume();
    _running = true;
    refreshVoices();
    console.log('[pad] start — root', _root, 'intervals', _intervals);
  }

  function stop() {
    if (!_running) return;
    _running = false;
    _voices.forEach(releaseVoice);
    _voices = [];
    console.log('[pad] stop');
  }

  function setChord(intervals, rootMidi) {
    const changed = JSON.stringify(intervals) !== JSON.stringify(_intervals) || rootMidi !== _root;
    _intervals = intervals.slice();
    _root      = rootMidi;
    if (_running && changed) refreshVoices();
  }

  function setMix(v) {
    _mix = Math.max(0, Math.min(1, v));
    if (_padBus) _padBus.gain.setTargetAtTime(_mix, ctx().currentTime, 0.08);
  }

  function setBrightness(v) {
    _brightness = Math.max(0, Math.min(1, v));
    if (_lpFilter) {
      _lpFilter.frequency.setTargetAtTime(brightnessToHz(_brightness), ctx().currentTime, 0.25);
      if (_filterDepth) _filterDepth.gain.setTargetAtTime(filterLfoDepth(_brightness), ctx().currentTime, 0.25);
    }
  }

  function setEvolution(v) {
    _evolution = Math.max(0, Math.min(1, v));
    if (_filterLfo) _filterLfo.frequency.setTargetAtTime(evolutionToFilterRate(_evolution), ctx().currentTime, 0.4);
  }

  function setOctave(shift) {
    _octaveShift = shift;
    if (_running) refreshVoices();
  }

  function isRunning() { return _running; }

  // Resume on visibility restore
  document.addEventListener('visibilitychange', () => {
    if (_ctx?.state === 'suspended') _ctx.resume();
  });

  window._terPad = {
    start, stop,
    setChord, setMix, setBrightness, setEvolution, setOctave,
    isRunning,
  };

  console.log('[pad] loaded — 2-osc drone · shared AudioContext · felt notch · 4s reverb');
})();
