/**
 * ternary/pad.js  —  Drone pad layer
 *
 * Designed to sit under the ternary arp and produce a Nils Frahm-style
 * sustained texture: slow attack swell, detuned oscillator stack,
 * felt-piano notch, long reverb, and a glacially-paced filter LFO.
 *
 * Signal chain:
 *   [4 oscs per chord tone: sine×2 + triangle + sawtooth whisper]
 *   → WaveShaper (tanh tape saturation)
 *   → ADSR envelope (attack 1.2s, release 3s)
 *   → _padBus
 *   → felt notch (900Hz −4dB — mutes piano body thump)
 *   → LP filter (brightness + slow LFO sweep)
 *   → [dry] + [convolver IR 4s → wet return]
 *   → _padMaster → destination
 *
 * Shares window._arpAudioCtx if arp.js initialized first;
 * otherwise creates its own.
 *
 * Wire-up (arp-jam.html or listener.html):
 *   window._terPad.start()
 *   window._terPad.setChord([0,3,7,10], 60)   // intervals + root MIDI
 *   window._terPad.setMix(0.5)
 *   window._terPad.setBrightness(0.4)          // 0=dark, 1=bright
 *   window._terPad.setEvolution(0.25)          // 0=glacial, 1=breathing fast
 *   window._terPad.setOctave(-1)               // octave shift from arp root
 */

(function () {
  'use strict';

  // ── Audio context (shared with arp.js if available) ──────────────────────────
  let _ctx        = null;

  function ctx() {
    if (_ctx) return _ctx;
    _ctx = window._arpAudioCtx
      || new (window.AudioContext || window.webkitAudioContext)();
    return _ctx;
  }

  // ── State ─────────────────────────────────────────────────────────────────────
  let _running     = false;
  let _intervals   = [0, 4, 7];
  let _root        = 60;
  let _octaveShift = -1;   // pad sits one octave below arp by default
  let _mix         = 0.45;
  let _brightness  = 0.35; // 0=dark, 1=bright
  let _evolution   = 0.25; // LFO rate control
  let _voices      = [];   // { nodes: OscillatorNode[], env: GainNode }

  // ── Audio graph nodes ─────────────────────────────────────────────────────────
  let _padBus      = null;
  let _feltNotch   = null;
  let _lpFilter    = null;
  let _filterLfo   = null;
  let _filterDepth = null;
  let _vibratoLfo  = null;
  let _vibratoDepth = null;
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
      c[i] = Math.tanh(x * 1.4) / Math.tanh(1.4);  // tape-style, gentler than arp
    }
    return (_satCache = c);
  }

  function createReverbIR() {
    // 4-second IR — longer than arp's, more spacious
    const sr  = ctx().sampleRate;
    const dur = 4.0;
    const len = Math.floor(sr * dur);
    const buf = ctx().createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      // Pre-delay 18ms (gives the dry signal space to breathe)
      const pre = Math.floor(sr * 0.018);
      for (let i = pre; i < len; i++) {
        const env = Math.pow(1 - (i - pre) / (len - pre), 1.1);
        d[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buf;
  }

  // ── Audio graph init ──────────────────────────────────────────────────────────

  function initGraph() {
    if (_padBus) return;  // already built
    const c = ctx();

    _padBus = c.createGain();
    _padBus.gain.value = _mix;

    // Felt-piano notch — muffles the 900Hz body resonance
    _feltNotch = c.createBiquadFilter();
    _feltNotch.type = 'notch';
    _feltNotch.frequency.value = 900;
    _feltNotch.Q.value = 2.5;

    // Main LP filter
    _lpFilter = c.createBiquadFilter();
    _lpFilter.type = 'lowpass';
    _lpFilter.Q.value = 0.55;
    _lpFilter.frequency.value = brightnessToHz(_brightness);

    // Filter LFO — slow sweep adds life without obvious wobble
    _filterLfo = c.createOscillator();
    _filterLfo.type = 'sine';
    _filterLfo.frequency.value = evolutionToFilterRate(_evolution);
    _filterDepth = c.createGain();
    _filterDepth.gain.value = filterLfoDepth(_brightness);
    _filterLfo.connect(_filterDepth);
    _filterDepth.connect(_lpFilter.frequency);
    _filterLfo.start();

    // Reverb
    _convolver = c.createConvolver();
    _convolver.buffer = createReverbIR();
    _padDry = c.createGain(); _padDry.gain.value = 0.25;   // mostly wet
    _padWet = c.createGain(); _padWet.gain.value = 0.75;

    _padMaster = c.createGain();
    _padMaster.gain.value = 0.52;

    // Wire
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

  function brightnessToHz(b) {
    // 0 → 180Hz (dark, subterranean), 1 → 7000Hz (bright, airy)
    return 180 * Math.pow(38.9, b);
  }

  function filterLfoDepth(b) {
    // Deeper sweep range in the mid brightness zone
    return 300 + Math.sin(b * Math.PI) * 900;
  }

  function evolutionToFilterRate(e) {
    // 0 → 0.025Hz (glacial — one sweep per 40s)
    // 1 → 0.45Hz  (breathing — one sweep per 2.2s)
    return 0.025 * Math.pow(18, e);
  }

  // ── Voice management ──────────────────────────────────────────────────────────

  // Piano inharmonicity: upper harmonics stretch slightly sharp.
  // Real piano stretch is ~+20 cents at C7 vs C4 (Railsback curve).
  function inharmonicCents(midi) {
    return (midi - 60) * 0.22;
  }

  function spawnVoice(midi) {
    const c      = ctx();
    const hz     = midiToHz(midi + inharmonicCents(midi) / 100);
    const t      = c.currentTime;

    const shaper = c.createWaveShaper();
    shaper.curve = satCurve();
    shaper.oversample = '2x';

    const env = c.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1.0, t + 1.2);   // 1.2s attack swell
    shaper.connect(env);
    env.connect(_padBus);

    // 4-oscillator stack — each adds a layer of harmonic character
    const stack = [
      { type: 'sine',     detune:   0,  gain: 0.52 },  // fundamental
      { type: 'sine',     detune: +12,  gain: 0.30 },  // unison shimmer
      { type: 'triangle', detune:  -9,  gain: 0.18 },  // soft harmonics
      { type: 'sawtooth', detune: +17,  gain: 0.05 },  // whisper of edge
    ];

    const nodes = stack.map(({ type, detune, gain }) => {
      const osc = c.createOscillator();
      const g   = c.createGain();
      osc.type            = type;
      osc.frequency.value = hz;
      osc.detune.value    = detune;
      g.gain.value        = gain;
      osc.connect(g);
      g.connect(shaper);
      osc.start(t);
      return osc;
    });

    return { nodes, env, midi };
  }

  function releaseVoice({ nodes, env }) {
    const t = ctx().currentTime;
    env.gain.cancelScheduledValues(t);
    env.gain.setValueAtTime(env.gain.value, t);
    env.gain.linearRampToValueAtTime(0, t + 3.0);  // 3s release — long tail
    setTimeout(() => nodes.forEach(n => { try { n.stop(); } catch (e) {} }), 4200);
  }

  function refreshVoices() {
    const c   = ctx();
    const now = c.currentTime;
    const oldVoices = _voices;
    _voices = [];

    // Fade old voices out
    oldVoices.forEach(v => {
      v.env.gain.cancelScheduledValues(now);
      v.env.gain.setValueAtTime(v.env.gain.value, now);
      v.env.gain.linearRampToValueAtTime(0, now + 1.5);  // crossfade 1.5s
      setTimeout(() => v.nodes.forEach(n => { try { n.stop(); } catch (e) {} }), 2000);
    });

    // Spawn new voices
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
    const changed = JSON.stringify(intervals) !== JSON.stringify(_intervals)
                 || rootMidi !== _root;
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

  window._terPad = {
    start, stop,
    setChord, setMix, setBrightness, setEvolution, setOctave,
    isRunning,
  };

  console.log('[pad] loaded — drone pad · 4-osc stack · felt notch · slow LFO · 4s reverb');
})();
