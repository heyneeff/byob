/**
 * ternary/arp.js  —  Phase 5: Ternary + Octonary Arpeggiator
 *
 * Signal chain:
 *   osc×2 (detuned warm saw) + sub (bass only)
 *   → VCF (LP biquad, swept per note) → ADSR envelope
 *   → _voiceBus
 *   → Juno chorus (2 delay lines, L/R LFOs at 0.43 / 0.49 Hz)
 *   → tape saturation (tanh WaveShaper)
 *   → low-shelf warmth (+2dB at 180Hz)
 *   → reverb send (plate IR) + dry
 *   → DynamicsCompressor (soft knee, -12dB threshold)
 *   → master gain → destination
 *
 * Shared AudioContext: uses window._arpAudioCtx if already created by pad.js,
 * otherwise creates it and exposes it for pad.js to reuse.
 */

(function () {
  'use strict';

  // ── Balanced ternary VM primitives ───────────────────────────────────────────
  const N = -1, Z = 0, P = 1;
  const tshift  = a        => a === P ? N : a + 1;
  const tcons   = (...vs)  => { const s = vs.reduce((a,v)=>a+v,0); return s>0?P:s<0?N:Z; };
  const tcmp    = (a, b)   => a < b ? N : a > b ? P : Z;
  const branch3 = (t,n,z,p)=> t === N ? n() : t === Z ? z() : p();

  // ── Arp styles ────────────────────────────────────────────────────────────────
  const ARP_STYLES = {
    UP:       { seq: [P,Z,N, P,Z,N, Z,P,N], rests: [1,1,1, 1,1,1, 1,1,1], name: 'Up' },
    DOWN:     { seq: [N,Z,P, N,Z,P, Z,N,P], rests: [1,1,1, 1,1,1, 1,1,1], name: 'Down' },
    BOUNCE:   { seq: [P,N,Z, P,N,Z, N,P,Z], rests: [1,1,1, 1,1,1, 1,1,1], name: 'Bounce' },
    FOLD:     { seq: [P,Z,N, N,Z,P, Z,P,N], rests: [1,1,1, 1,1,1, 1,1,1], name: 'Fold' },
    SKIP:     { seq: [P,N,P, Z,N,Z, N,P,Z], rests: [1,0,1, 1,0,1, 1,0,1], name: 'Skip' },
    PULSE:    { seq: [P,P,N, P,P,Z, P,N,Z], rests: [1,1,1, 1,0,1, 1,1,0], name: 'Pulse' },
    CLAVE:    { seq: [P,N,Z, P,N,Z, P,Z,N], rests: [1,1,0, 1,0,1, 1,0,1], name: 'Clave' },
    EUCLID:   { seq: [P,Z,N, P,Z,N, Z,P,N], rests: [1,0,1, 1,0,1, 0,1,0], name: 'Euclid' },
    STUTTER:  { seq: [P,P,Z, N,N,Z, P,N,P], rests: [1,0,1, 1,0,1, 1,1,0], name: 'Stutter' },
    OFFBEAT:  { seq: [P,Z,N, Z,P,N, P,Z,N], rests: [0,1,1, 1,0,1, 1,1,0], name: 'Offbeat' },
    PENDULUM: { seq: [N,Z,P, Z,N,Z, P,N,Z], rests: [1,1,1, 1,1,1, 1,1,1], name: 'Pendulum' },
    CONVERGE: { seq: [N,P,Z, N,P,Z, Z,N,P], rests: [1,1,1, 1,1,1, 1,1,1], name: 'Converge' },
    LOCK:     { seq: [P,Z,P, N,Z,N, P,N,Z], rests: [1,1,0, 1,1,0, 1,0,1], name: 'Lock' },
    GHOST:    { seq: [P,Z,N, P,Z,N, Z,P,N], rests: [1,0,0, 0,1,0, 0,0,1], name: 'Ghost' },
    SPIRAL:   { seq: [N,Z,P, N,Z,P, P,N,Z], rests: [1,1,1, 1,0,1, 1,1,1], name: 'Spiral' },
  };

  let _styleForms = null;
  let _styleKey   = 'UP';

  function recomputeForms() {
    const seq = ARP_STYLES[_styleKey].seq;
    _styleForms = [
      seq,
      seq.map(tshift),
      seq.map(t => tshift(tshift(t))),
    ];
  }
  recomputeForms();

  function currentForms() { return _styleForms; }
  function currentRests() { return ARP_STYLES[_styleKey].rests; }

  // ── Trit → scale degree ───────────────────────────────────────────────────────
  const TRIT_DEGREE = { [P]: 0, [Z]: 4, [N]: 7 };

  // ── 8 trigram chord colors ────────────────────────────────────────────────────
  const TRIGRAM_CHORDS = {
    'NNN': [0, 4, 7, 11],
    'NNP': [0, 4, 7, 9],
    'NPN': [0, 4, 7, 10],
    'NPP': [0, 3, 6, 10],
    'PNN': [0, 5, 7, 12],
    'PNP': [0, 3, 7, 10],
    'PPN': [0, 3, 6, 9],
    'PPP': [0, 4, 7],
  };
  const TRIGRAM_NAMES = {
    'NNN': '☰ Heaven', 'NNP': '☱ Lake',     'NPN': '☲ Fire',     'NPP': '☳ Thunder',
    'PNN': '☴ Wind',   'PNP': '☵ Water',    'PPN': '☶ Mountain', 'PPP': '☷ Earth',
  };

  const ACCENT = [1.0, 0.70, 0.48,  1.0, 0.70, 0.48,  1.0, 0.70, 0.48];

  // ── Envelope state ────────────────────────────────────────────────────────────
  let _envA    = 0.007;
  let _envD    = 0.055;
  let _envS    = 0.58;
  let _envR    = 0.09;
  let _envGate = 0.82;

  // ── Core state ────────────────────────────────────────────────────────────────
  let _root    = 60;
  let _bpm     = 120;
  let _running = false;
  let _prevMidi = 60;

  let _step       = 0;
  let _form       = 0;
  let _nextNoteMs = 0;
  let _schedTimer = null;

  let _trigramSeq    = [Z, Z, Z];
  let _forcedTrigram = null;
  let _peerTrits     = {};

  // ── Audio nodes ───────────────────────────────────────────────────────────────
  let _audioCtx    = null;
  let _voiceBus    = null;
  let _master      = null;
  let _reverbSend  = null;
  let _voices      = [];
  let _voiceIdx    = 0;
  let _satCurveCache = null;

  // ── Clock helpers ─────────────────────────────────────────────────────────────
  function syncedNow() { return typeof window.syncedNow === 'function' ? window.syncedNow() : Date.now(); }
  function getBpm()    { const w = window._masterBPM; return (w && w > 40 && w < 300) ? w : _bpm; }
  function stepMs()    { return (60 / getBpm() / 3) * 1000; }

  // ── Device / room state ───────────────────────────────────────────────────────
  function ownTrit() {
    const h = window._terLayer?.history?.();
    if (!h?.length) return Z;
    const t = h[h.length - 1]?.trit;
    return t === 'P' ? P : t === 'N' ? N : Z;
  }

  function roomConsensus() {
    const now  = Date.now();
    const live = Object.values(_peerTrits).filter(p => now - p.ts < 20000).map(p => p.trit);
    return live.length ? tcons(ownTrit(), ...live) : ownTrit();
  }

  function updateTrigram() {
    if (_forcedTrigram) return;
    _trigramSeq = [_trigramSeq[1], _trigramSeq[2], roomConsensus()];
  }

  function trigramKey()    { return _forcedTrigram ?? _trigramSeq.map(t => t >= 0 ? 'P' : 'N').join(''); }
  function chordIntervals(){ return TRIGRAM_CHORDS[trigramKey()] ?? [0, 4, 7]; }

  // ── Note pitch ────────────────────────────────────────────────────────────────
  function midiToHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  function stepToMidi(step, form, voice) {
    const trit     = currentForms()[form][step];
    const degree   = TRIT_DEGREE[trit];
    const ivs      = chordIntervals();
    const ivIdx    = Math.round(degree / 12 * ivs.length);
    const interval = ivs[ivIdx % ivs.length] ?? degree;
    const oct      = voice === P ? 12 : voice === N ? -12 : 0;
    return _root + interval + oct;
  }

  // ── Phase-lock scheduling ─────────────────────────────────────────────────────
  function phaseState() {
    const ref = window._terGetZone?.()?.playback_started_at;
    if (!ref) return { step: 0, form: 0 };
    const refMs      = new Date(ref).getTime();
    const sMs        = stepMs();
    const totalSteps = Math.max(0, Math.floor((syncedNow() - refMs) / sMs));
    const cycleStep  = totalSteps % 27;
    return { step: cycleStep % 9, form: Math.floor(cycleStep / 9) % 3 };
  }

  function alignedStart() {
    const ref = window._terGetZone?.()?.playback_started_at;
    const sMs = stepMs();
    if (!ref) { const now = syncedNow(); return now + (sMs - (now % sMs)); }
    const refMs = new Date(ref).getTime();
    return refMs + Math.ceil((syncedNow() - refMs) / sMs) * sMs;
  }

  // ── Audio helpers ─────────────────────────────────────────────────────────────
  function satCurve() {
    if (_satCurveCache) return _satCurveCache;
    const n = 512, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      c[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    return (_satCurveCache = c);
  }

  function createPlateIR(durS) {
    const sr  = _audioCtx.sampleRate;
    const len = Math.floor(sr * durS);
    const buf = _audioCtx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const erDelays = [0.011, 0.019, 0.029, 0.041, 0.058, 0.073];
      const erGains  = [0.60,  0.50,  0.42,  0.35,  0.28,  0.22 ];
      erDelays.forEach((dly, i) => {
        const idx = Math.floor(dly * sr);
        if (idx < len) d[idx] += erGains[i] * (c === 0 ? 1 : -0.85);
      });
      for (let i = Math.floor(0.08 * sr); i < len; i++) {
        const env = Math.pow(1 - i / len, 1.8);
        d[i] += (Math.random() * 2 - 1) * env * 0.35;
      }
    }
    return buf;
  }

  let _warmWave = null;
  function getWarmWave() {
    if (_warmWave) return _warmWave;
    const n    = 32;
    const real = new Float32Array(n + 1);
    const imag = new Float32Array(n + 1);
    for (let i = 1; i <= n; i++) {
      imag[i] = (2 / (Math.PI * i)) * Math.exp(-i * 0.18);
    }
    _warmWave = _audioCtx.createPeriodicWave(real, imag, { disableNormalization: false });
    return _warmWave;
  }

  // ── Voice pool ────────────────────────────────────────────────────────────────
  const NUM_VOICES = 6;

  function buildVoice() {
    const ctx  = _audioCtx;
    const wave = getWarmWave();
    const v    = {};

    v.osc1 = ctx.createOscillator(); v.osc1.setPeriodicWave(wave);
    v.osc2 = ctx.createOscillator(); v.osc2.setPeriodicWave(wave);
    v.osc1.detune.value = +8;
    v.osc2.detune.value = -8;

    v.sub = ctx.createOscillator(); v.sub.type = 'sine';

    v.g1 = ctx.createGain(); v.g1.gain.value = 0.44;
    v.g2 = ctx.createGain(); v.g2.gain.value = 0.44;
    v.gs = ctx.createGain(); v.gs.gain.value = 0.18;

    v.vcf = ctx.createBiquadFilter();
    v.vcf.type = 'lowpass'; v.vcf.frequency.value = 2200; v.vcf.Q.value = 0.6;

    v.ampEnv = ctx.createGain(); v.ampEnv.gain.value = 0;

    v.osc1.connect(v.g1); v.g1.connect(v.vcf);
    v.osc2.connect(v.g2); v.g2.connect(v.vcf);
    v.sub.connect(v.gs);  v.gs.connect(v.vcf);
    v.vcf.connect(v.ampEnv);
    v.ampEnv.connect(_voiceBus);

    v.osc1.start(); v.osc2.start(); v.sub.start();
    v.noteEndTime = 0;
    return v;
  }

  // ── Audio graph ───────────────────────────────────────────────────────────────
  function initAudio() {
    if (_audioCtx) return;
    // Reuse shared context if pad.js already created one, otherwise create and share
    _audioCtx = window._arpAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    window._arpAudioCtx = _audioCtx;

    _voiceBus = _audioCtx.createGain(); _voiceBus.gain.value = 0.55;

    // ── Juno-style stereo chorus ──────────────────────────────────────────────
    // Two delay lines panned L/R, each modulated by a slow LFO.
    // Different LFO rates (0.43 vs 0.49 Hz) create natural stereo beating.
    const chorusWet  = _audioCtx.createGain(); chorusWet.gain.value  = 0.45;
    const chorusDry  = _audioCtx.createGain(); chorusDry.gain.value  = 0.55;
    const delL = _audioCtx.createDelay(0.05); delL.delayTime.value = 0.012;
    const delR = _audioCtx.createDelay(0.05); delR.delayTime.value = 0.014;
    const panL = _audioCtx.createStereoPanner(); panL.pan.value = -0.65;
    const panR = _audioCtx.createStereoPanner(); panR.pan.value = +0.65;
    const lfoL = _audioCtx.createOscillator(); lfoL.frequency.value = 0.43;
    const lfoR = _audioCtx.createOscillator(); lfoR.frequency.value = 0.49;
    const depL = _audioCtx.createGain(); depL.gain.value = 0.006;
    const depR = _audioCtx.createGain(); depR.gain.value = 0.006;
    lfoL.connect(depL); depL.connect(delL.delayTime);
    lfoR.connect(depR); depR.connect(delR.delayTime);
    lfoL.start(); lfoR.start();
    _voiceBus.connect(chorusDry);
    _voiceBus.connect(delL); delL.connect(panL); panL.connect(chorusWet);
    _voiceBus.connect(delR); delR.connect(panR); panR.connect(chorusWet);

    // ── Tape saturation ───────────────────────────────────────────────────────
    const sat = _audioCtx.createWaveShaper();
    sat.oversample = '4x';
    const sc = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = (i * 2) / 255 - 1; sc[i] = Math.tanh(x * 1.8) / Math.tanh(1.8); }
    sat.curve = sc;

    // ── Warmth shelf ──────────────────────────────────────────────────────────
    const warmth = _audioCtx.createBiquadFilter();
    warmth.type = 'lowshelf'; warmth.frequency.value = 180; warmth.gain.value = 2.0;

    // ── Reverb (plate IR) ─────────────────────────────────────────────────────
    _reverbSend = _audioCtx.createGain(); _reverbSend.gain.value = 0.28;
    const reverbReturn = _audioCtx.createGain(); reverbReturn.gain.value = 0.85;
    const conv = _audioCtx.createConvolver(); conv.buffer = createPlateIR(2.8);

    // ── Limiter — soft knee, headroom for pad summing at destination ──────────
    const limiter = _audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -12; limiter.ratio.value = 4;
    limiter.attack.value = 0.003; limiter.release.value = 0.18; limiter.knee.value = 6;

    _master = _audioCtx.createGain(); _master.gain.value = 0.42;

    // Wire
    chorusDry.connect(sat); chorusWet.connect(sat);
    sat.connect(warmth);
    warmth.connect(limiter);
    warmth.connect(_reverbSend); _reverbSend.connect(conv); conv.connect(reverbReturn); reverbReturn.connect(limiter);
    limiter.connect(_master);
    _master.connect(_audioCtx.destination);

    _voices = Array.from({ length: NUM_VOICES }, buildVoice);
    _voiceIdx = 0;
  }

  // ── Note playback ─────────────────────────────────────────────────────────────
  function playNote(midi, startS, stepDurS, accent, voice) {
    if (!_audioCtx || !_voices.length) return;

    const hz  = midiToHz(midi);
    const dur = stepDurS * _envGate;
    const t   = _audioCtx.currentTime;

    const pitchDir   = tcmp(midi, _prevMidi);
    const attackMod  = branch3(pitchDir, () => 1.3, () => 1.0, () => 0.70);
    const sustainMod = branch3(pitchDir, () => 1.1, () => 1.0, () => 0.88);
    _prevMidi = midi;

    const effA = _envA * attackMod;
    const effS = Math.min(_envS * sustainMod, 1);
    const tEnd = startS + dur;

    const v = _voices[_voiceIdx % NUM_VOICES];
    _voiceIdx++;
    v.noteEndTime = tEnd;

    // Micro-fade current voice before steal to prevent clicks
    v.ampEnv.gain.cancelScheduledValues(t);
    v.ampEnv.gain.setValueAtTime(v.ampEnv.gain.value, t);
    if (startS > t + 0.004) {
      v.ampEnv.gain.linearRampToValueAtTime(0, startS - 0.002);
    }

    v.osc1.frequency.setValueAtTime(hz, startS);
    v.osc2.frequency.setValueAtTime(hz, startS);
    v.sub.frequency.setValueAtTime(hz / 2, startS);

    const vcfStart     = branch3(voice, () =>  700, () => 1100, () => 1500);
    const vcfPeak      = branch3(voice, () => 1600, () => 2400, () => 3200);
    const vcfSweepTime = effA * 1.6;
    v.vcf.frequency.cancelScheduledValues(startS);
    v.vcf.frequency.setValueAtTime(vcfStart, startS);
    v.vcf.frequency.linearRampToValueAtTime(vcfPeak, startS + vcfSweepTime);
    v.vcf.frequency.setTargetAtTime(vcfPeak * 0.78, startS + vcfSweepTime, 0.4);

    const subLevel = branch3(voice, () => 0.28, () => 0.12, () => 0.04);
    v.gs.gain.setValueAtTime(subLevel * accent, startS);

    const tA = startS + effA;
    const tD = tA + _envD;
    const tR = Math.max(tD + 0.01, tEnd - _envR);
    v.ampEnv.gain.setValueAtTime(0, startS);
    v.ampEnv.gain.linearRampToValueAtTime(accent * 0.78, tA);
    v.ampEnv.gain.linearRampToValueAtTime(accent * effS * 0.68, tD);
    v.ampEnv.gain.setValueAtTime(accent * effS * 0.68, tR);
    v.ampEnv.gain.linearRampToValueAtTime(0, tEnd);
  }

  // ── Lookahead scheduler ───────────────────────────────────────────────────────
  const LOOKAHEAD_MS = 150;
  const TICK_MS      = 50;

  function schedule() {
    if (!_running || !_audioCtx) return;
    const wallNow  = syncedNow();
    const audioNow = _audioCtx.currentTime;
    const sMs      = stepMs();
    const rests    = currentRests();

    while (_nextNoteMs < wallNow + LOOKAHEAD_MS) {
      const audioStartS = audioNow + (_nextNoteMs - wallNow) / 1000;
      if (audioStartS > audioNow + 0.001 && rests[_step]) {
        const voice = ownTrit();
        const midi  = stepToMidi(_step, _form, voice);
        playNote(midi, audioStartS, sMs / 1000, ACCENT[_step], voice);
        window._terArpOnStep?.({ step: _step, form: _form, trigram: trigramKey(), midi });
      }

      if (_step === 0) updateTrigram();

      _nextNoteMs += sMs;
      if (++_step >= 9) { _step = 0; _form = (_form + 1) % 3; }
    }

    _schedTimer = setTimeout(schedule, TICK_MS);
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  function start(opts = {}) {
    if (_running) return;
    if (opts.root   != null) _root     = opts.root;
    if (opts.bpm    != null) _bpm      = opts.bpm;
    if (opts.style  != null) { _styleKey = opts.style; recomputeForms(); }

    initAudio();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();

    const phase = phaseState();
    _step       = phase.step;
    _form       = phase.form;
    _nextNoteMs = alignedStart();
    _running    = true;
    schedule();
    _badge(true);
    console.log('[ternary/arp] start —', _styleKey, 'root', _root, 'bpm', getBpm().toFixed(1), trigramKey());
  }

  function stop() {
    _running = false;
    clearTimeout(_schedTimer); _schedTimer = null;
    _badge(false);
  }

  function toggle(opts) { _running ? stop() : start(opts); }

  function setRoot(midi)      { _root = midi; }
  function setBpm(bpm)        { _bpm = bpm; }
  function setStyle(key)      { if (key in ARP_STYLES) { _styleKey = key; recomputeForms(); } }
  function setTrigram(key)    { _forcedTrigram = (key in TRIGRAM_CHORDS) ? key : null; }
  function clearTrigram()     { _forcedTrigram = null; }
  function setReverbMix(v)    {
    if (_reverbSend) _reverbSend.gain.setTargetAtTime(Math.max(0, Math.min(1, v)) * 0.5, _audioCtx.currentTime, 0.1);
  }
  function setEnvelope({ a, d, s, r, gate } = {}) {
    if (a    != null) _envA    = Math.max(0.001, a);
    if (d    != null) _envD    = Math.max(0.001, d);
    if (s    != null) _envS    = Math.max(0, Math.min(1, s));
    if (r    != null) _envR    = Math.max(0.001, r);
    if (gate != null) _envGate = Math.max(0.05, Math.min(2.0, gate));
  }

  function isRunning()    { return _running; }
  function getTrigramKey(){ return trigramKey(); }

  function receivePeer(deviceId, trit, ts) {
    _peerTrits[deviceId] = { trit, ts: ts ?? Date.now() };
  }

  function _badge(on) {
    const el = document.getElementById('ter-badge-sub');
    if (el) el.textContent = on ? 'ARP' : '';
  }

  // Resume on visibility restore (mobile AudioContext suspension)
  document.addEventListener('visibilitychange', () => {
    if (_audioCtx?.state === 'suspended') _audioCtx.resume();
  });

  setInterval(() => {
    const w = window._masterBPM;
    if (w && w > 40 && Math.abs(w - _bpm) > 1) _bpm = w;
  }, 2000);

  window._terArpReceivePeer = receivePeer;

  window._terArp = {
    start, stop, toggle,
    setRoot, setBpm, setStyle, setTrigram, clearTrigram,
    setReverbMix, setEnvelope,
    isRunning, receivePeer,
    getPhase: phaseState,
    getTrigramKey,
    chordIntervals,
    TRIGRAM_CHORDS, TRIGRAM_NAMES, ARP_STYLES,
  };

  console.log('[ternary/arp] loaded — 15 styles · 8 trigram chords · shared AudioContext · chorus fixed');
})();
