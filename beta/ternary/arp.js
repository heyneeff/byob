/**
 * ternary/arp.js — Phase 6: FM + 4-pole filter + 3-band EQ
 *
 * Voice chain (per note):
 *   modOsc → modDepth → osc1.frequency  [FM at audio rate]
 *   osc1 + sub → f1 → f2  [24 dB/oct ladder LP, filter envelope]
 *   → ampEnv → _voiceBus
 *
 * Master chain:
 *   _voiceBus → Juno chorus → 3-band EQ → warmth shelf
 *   → reverb (async plate IR) → limiter → master → destination
 *
 * Shared AudioContext: uses window._arpAudioCtx if already created by pad.js.
 */

(function () {
  'use strict';

  // ── Balanced ternary VM ───────────────────────────────────────────────────────
  const N = -1, Z = 0, P = 1;
  const tshift  = a         => a === P ? N : a + 1;
  const tcons   = (...vs)   => { const s = vs.reduce((a,v)=>a+v,0); return s>0?P:s<0?N:Z; };
  const tcmp    = (a, b)    => a < b ? N : a > b ? P : Z;
  const branch3 = (t,n,z,p) => t === N ? n() : t === Z ? z() : p();

  // ── Arp styles ────────────────────────────────────────────────────────────────
  const ARP_STYLES = {
    UP:       { seq: [P,Z,N, P,Z,N, Z,P,N], rests: [1,1,1, 1,1,1, 1,1,1] },
    DOWN:     { seq: [N,Z,P, N,Z,P, Z,N,P], rests: [1,1,1, 1,1,1, 1,1,1] },
    BOUNCE:   { seq: [P,N,Z, P,N,Z, N,P,Z], rests: [1,1,1, 1,1,1, 1,1,1] },
    FOLD:     { seq: [P,Z,N, N,Z,P, Z,P,N], rests: [1,1,1, 1,1,1, 1,1,1] },
    SKIP:     { seq: [P,N,P, Z,N,Z, N,P,Z], rests: [1,0,1, 1,0,1, 1,0,1] },
    PULSE:    { seq: [P,P,N, P,P,Z, P,N,Z], rests: [1,1,1, 1,0,1, 1,1,0] },
    CLAVE:    { seq: [P,N,Z, P,N,Z, P,Z,N], rests: [1,1,0, 1,0,1, 1,0,1] },
    EUCLID:   { seq: [P,Z,N, P,Z,N, Z,P,N], rests: [1,0,1, 1,0,1, 0,1,0] },
    STUTTER:  { seq: [P,P,Z, N,N,Z, P,N,P], rests: [1,0,1, 1,0,1, 1,1,0] },
    OFFBEAT:  { seq: [P,Z,N, Z,P,N, P,Z,N], rests: [0,1,1, 1,0,1, 1,1,0] },
    PENDULUM: { seq: [N,Z,P, Z,N,Z, P,N,Z], rests: [1,1,1, 1,1,1, 1,1,1] },
    CONVERGE: { seq: [N,P,Z, N,P,Z, Z,N,P], rests: [1,1,1, 1,1,1, 1,1,1] },
    LOCK:     { seq: [P,Z,P, N,Z,N, P,N,Z], rests: [1,1,0, 1,1,0, 1,0,1] },
    GHOST:    { seq: [P,Z,N, P,Z,N, Z,P,N], rests: [1,0,0, 0,1,0, 0,0,1] },
    SPIRAL:   { seq: [N,Z,P, N,Z,P, P,N,Z], rests: [1,1,1, 1,0,1, 1,1,1] },
  };

  let _styleForms = null;
  let _styleKey   = 'UP';

  function recomputeForms() {
    const seq = ARP_STYLES[_styleKey].seq;
    _styleForms = [seq, seq.map(tshift), seq.map(t => tshift(tshift(t)))];
  }
  recomputeForms();

  function currentForms() { return _styleForms; }
  function currentRests() { return ARP_STYLES[_styleKey].rests; }

  // ── Trigram system ────────────────────────────────────────────────────────────
  const TRIT_DEGREE = { [P]: 0, [Z]: 4, [N]: 7 };

  const TRIGRAM_CHORDS = {
    'NNN': [0,4,7,11], 'NNP': [0,4,7,9],  'NPN': [0,4,7,10], 'NPP': [0,3,6,10],
    'PNN': [0,5,7,12], 'PNP': [0,3,7,10], 'PPN': [0,3,6,9],  'PPP': [0,4,7],
  };
  const TRIGRAM_NAMES = {
    'NNN':'☰ Heaven','NNP':'☱ Lake','NPN':'☲ Fire','NPP':'☳ Thunder',
    'PNN':'☴ Wind',  'PNP':'☵ Water','PPN':'☶ Mountain','PPP':'☷ Earth',
  };

  const ACCENT = [1.0,0.70,0.48, 1.0,0.70,0.48, 1.0,0.70,0.48];

  // ── Synth parameters ──────────────────────────────────────────────────────────
  // Amp envelope
  let _envA = 0.007, _envD = 0.055, _envS = 0.58, _envR = 0.09, _envGate = 0.82;

  // Oscillator
  let _oscType  = 'sawtooth';
  let _subLevel = 0.15;

  // Filter (2× BiquadFilter LP in series = 24 dB/oct ladder)
  let _fltCutoff = 2400;   // Hz
  let _fltRes    = 0.5;    // Q per stage (0–4); higher = more resonance
  let _fltEnvAmt = 0.6;    // 0–1: how far filter opens on each note
  let _fltA      = 0.01;   // filter attack s
  let _fltD      = 0.25;   // filter decay time constant s

  // FM
  let _fmRatio = 1.0;   // modulator freq = carrier × ratio
  let _fmDepth = 0;     // Hz — modulation depth on carrier frequency

  // EQ
  let _eqLow = 0, _eqMid = 0, _eqHigh = 0;  // dB

  // ── Core state ────────────────────────────────────────────────────────────────
  let _root = 60, _bpm = 120, _running = false, _prevMidi = 60;
  let _step = 0, _form = 0, _nextNoteMs = 0, _schedTimer = null;
  let _trigramSeq = [Z,Z,Z], _forcedTrigram = null, _peerTrits = {};

  // ── Audio nodes ───────────────────────────────────────────────────────────────
  let _audioCtx = null, _voiceBus = null, _master = null, _reverbSend = null;
  let _eqLowNode = null, _eqMidNode = null, _eqHighNode = null;
  let _voices = [], _voiceIdx = 0;

  // ── Clock helpers ─────────────────────────────────────────────────────────────
  function syncedNow() { return typeof window.syncedNow === 'function' ? window.syncedNow() : Date.now(); }
  function getBpm()    { const w = window._masterBPM; return (w && w > 40 && w < 300) ? w : _bpm; }
  function stepMs()    { return (60 / getBpm() / 3) * 1000; }

  // ── Room state ────────────────────────────────────────────────────────────────
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

  function trigramKey()     { return _forcedTrigram ?? _trigramSeq.map(t => t >= 0 ? 'P' : 'N').join(''); }
  function chordIntervals() { return TRIGRAM_CHORDS[trigramKey()] ?? [0,4,7]; }

  // ── Pitch ─────────────────────────────────────────────────────────────────────
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

  // ── Plate IR — deferred so it doesn't block audio startup ────────────────────
  function buildPlateIR(durS) {
    return new Promise(resolve => setTimeout(() => {
      const sr  = _audioCtx.sampleRate;
      const len = Math.floor(sr * durS);
      const buf = _audioCtx.createBuffer(2, len, sr);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        [0.011,0.019,0.029,0.041,0.058,0.073].forEach((dly, i) => {
          const idx = Math.floor(dly * sr);
          if (idx < len) d[idx] += [0.60,0.50,0.42,0.35,0.28,0.22][i] * (c === 0 ? 1 : -0.85);
        });
        for (let i = Math.floor(0.08 * sr); i < len; i++) {
          d[i] += (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.8) * 0.35;
        }
      }
      resolve(buf);
    }, 0));
  }

  // ── Voice pool ────────────────────────────────────────────────────────────────
  const NUM_VOICES = 6;

  function buildVoice() {
    const c = _audioCtx;
    const v = {};

    // Carrier osc
    v.osc1 = c.createOscillator(); v.osc1.type = _oscType;

    // FM modulator → carrier frequency
    v.modOsc   = c.createOscillator(); v.modOsc.type = 'sine';
    v.modDepth = c.createGain();       v.modDepth.gain.value = _fmDepth;
    v.modOsc.connect(v.modDepth);
    v.modDepth.connect(v.osc1.frequency);

    // Sub (one octave below)
    v.sub     = c.createOscillator(); v.sub.type = 'sine';
    v.subGain = c.createGain();       v.subGain.gain.value = _subLevel;

    // Osc1 mix gain
    v.osc1Gain = c.createGain(); v.osc1Gain.gain.value = 0.8;

    // 4-pole ladder: 2 BiquadFilter LP in series = 24 dB/oct
    v.f1 = c.createBiquadFilter(); v.f1.type = 'lowpass'; v.f1.frequency.value = _fltCutoff; v.f1.Q.value = _fltRes;
    v.f2 = c.createBiquadFilter(); v.f2.type = 'lowpass'; v.f2.frequency.value = _fltCutoff; v.f2.Q.value = _fltRes;

    // Amp envelope
    v.ampEnv = c.createGain(); v.ampEnv.gain.value = 0;

    // Routing
    v.osc1.connect(v.osc1Gain);
    v.sub.connect(v.subGain);
    v.osc1Gain.connect(v.f1);
    v.subGain.connect(v.f1);
    v.f1.connect(v.f2);
    v.f2.connect(v.ampEnv);
    v.ampEnv.connect(_voiceBus);

    // Lazy start — oscillators begin on first note to save CPU at init
    v.started     = false;
    v.noteEndTime = 0;
    return v;
  }

  function startVoice(v) {
    if (!v.started) { v.osc1.start(); v.modOsc.start(); v.sub.start(); v.started = true; }
  }

  // ── Audio graph ───────────────────────────────────────────────────────────────
  function initAudio() {
    if (_audioCtx) return;
    _audioCtx = window._arpAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    window._arpAudioCtx = _audioCtx;

    _voiceBus = _audioCtx.createGain(); _voiceBus.gain.value = 0.6;

    // Juno-style stereo chorus
    const chorusWet = _audioCtx.createGain(); chorusWet.gain.value = 0.35;
    const chorusDry = _audioCtx.createGain(); chorusDry.gain.value = 0.65;
    const delL = _audioCtx.createDelay(0.05); delL.delayTime.value = 0.012;
    const delR = _audioCtx.createDelay(0.05); delR.delayTime.value = 0.014;
    const panL = _audioCtx.createStereoPanner(); panL.pan.value = -0.65;
    const panR = _audioCtx.createStereoPanner(); panR.pan.value = +0.65;
    const lfoL = _audioCtx.createOscillator(); lfoL.frequency.value = 0.43;
    const lfoR = _audioCtx.createOscillator(); lfoR.frequency.value = 0.49;
    const depL = _audioCtx.createGain(); depL.gain.value = 0.005;
    const depR = _audioCtx.createGain(); depR.gain.value = 0.005;
    lfoL.connect(depL); depL.connect(delL.delayTime);
    lfoR.connect(depR); depR.connect(delR.delayTime);
    lfoL.start(); lfoR.start();
    _voiceBus.connect(chorusDry);
    _voiceBus.connect(delL); delL.connect(panL); panL.connect(chorusWet);
    _voiceBus.connect(delR); delR.connect(panR); panR.connect(chorusWet);

    // 3-band EQ
    _eqLowNode  = _audioCtx.createBiquadFilter();
    _eqLowNode.type  = 'lowshelf';  _eqLowNode.frequency.value  = 200;  _eqLowNode.gain.value  = _eqLow;
    _eqMidNode  = _audioCtx.createBiquadFilter();
    _eqMidNode.type  = 'peaking';   _eqMidNode.frequency.value  = 1000; _eqMidNode.gain.value  = _eqMid; _eqMidNode.Q.value = 1.0;
    _eqHighNode = _audioCtx.createBiquadFilter();
    _eqHighNode.type = 'highshelf'; _eqHighNode.frequency.value = 6000; _eqHighNode.gain.value = _eqHigh;

    // Warmth low-shelf
    const warmth = _audioCtx.createBiquadFilter();
    warmth.type = 'lowshelf'; warmth.frequency.value = 200; warmth.gain.value = 3.0;

    // Reverb — convolver wired immediately, IR loaded async
    _reverbSend = _audioCtx.createGain(); _reverbSend.gain.value = 0.28;
    const reverbReturn = _audioCtx.createGain(); reverbReturn.gain.value = 0.85;
    const conv = _audioCtx.createConvolver();
    buildPlateIR(2.8).then(buf => { conv.buffer = buf; });

    // Limiter
    const limiter = _audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -12; limiter.ratio.value = 4;
    limiter.attack.value = 0.003; limiter.release.value = 0.18; limiter.knee.value = 6;

    _master = _audioCtx.createGain(); _master.gain.value = 0.45;

    // Wire: voiceBus → chorus → EQ → warmth → limiter ← reverb return
    chorusDry.connect(_eqLowNode);
    chorusWet.connect(_eqLowNode);
    _eqLowNode.connect(_eqMidNode);
    _eqMidNode.connect(_eqHighNode);
    _eqHighNode.connect(warmth);
    warmth.connect(limiter);
    warmth.connect(_reverbSend);
    _reverbSend.connect(conv); conv.connect(reverbReturn); reverbReturn.connect(limiter);
    limiter.connect(_master);
    _master.connect(_audioCtx.destination);

    _voices   = Array.from({ length: NUM_VOICES }, buildVoice);
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

    startVoice(v);

    // Micro-fade on steal to prevent clicks
    v.ampEnv.gain.cancelScheduledValues(t);
    v.ampEnv.gain.setValueAtTime(v.ampEnv.gain.value, t);
    if (startS > t + 0.005) v.ampEnv.gain.linearRampToValueAtTime(0, startS - 0.003);

    // Frequencies
    v.osc1.frequency.setValueAtTime(hz, startS);
    v.modOsc.frequency.setValueAtTime(hz * _fmRatio, startS);
    v.sub.frequency.setValueAtTime(hz / 2, startS);

    // FM depth
    v.modDepth.gain.cancelScheduledValues(startS);
    v.modDepth.gain.setValueAtTime(_fmDepth, startS);

    // Sub level by voice role
    const subLvl = branch3(voice, () => 0.28, () => _subLevel, () => 0.04);
    v.subGain.gain.setValueAtTime(subLvl * accent, startS);

    // Filter envelope: sweeps from closed → peak → settles at cutoff
    const fltBase = _fltCutoff * Math.max(0.05, 1 - _fltEnvAmt * 0.9);
    const fltPeak = Math.min(_fltCutoff * (1 + _fltEnvAmt * 5), 18000);
    v.f1.frequency.cancelScheduledValues(startS);
    v.f2.frequency.cancelScheduledValues(startS);
    v.f1.frequency.setValueAtTime(fltBase, startS);
    v.f2.frequency.setValueAtTime(fltBase, startS);
    v.f1.frequency.linearRampToValueAtTime(fltPeak, startS + _fltA);
    v.f2.frequency.linearRampToValueAtTime(fltPeak, startS + _fltA);
    v.f1.frequency.setTargetAtTime(_fltCutoff, startS + _fltA, _fltD);
    v.f2.frequency.setTargetAtTime(_fltCutoff, startS + _fltA, _fltD);

    // Amp envelope
    const tA = startS + effA;
    const tD = tA + _envD;
    const tR = Math.max(tD + 0.01, tEnd - _envR);
    v.ampEnv.gain.setValueAtTime(0, startS);
    v.ampEnv.gain.linearRampToValueAtTime(accent * 0.82, tA);
    v.ampEnv.gain.linearRampToValueAtTime(accent * effS * 0.70, tD);
    v.ampEnv.gain.setValueAtTime(accent * effS * 0.70, tR);
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

    // If scheduler was throttled (tab backgrounded), resync rather than bursting
    if (wallNow - _nextNoteMs > sMs * 3) _nextNoteMs = wallNow;

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
    if (opts.root  != null) _root     = opts.root;
    if (opts.bpm   != null) _bpm      = opts.bpm;
    if (opts.style != null) { _styleKey = opts.style; recomputeForms(); }
    initAudio();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    const phase = phaseState();
    _step = phase.step; _form = phase.form;
    _nextNoteMs = alignedStart();
    _running = true;
    schedule();
    _badge(true);
  }

  function stop() {
    _running = false;
    clearTimeout(_schedTimer); _schedTimer = null;
    _badge(false);
  }

  function toggle(opts) { _running ? stop() : start(opts); }

  function setRoot(midi)   { _root = midi; }
  function setBpm(bpm)     { _bpm = bpm; }
  function setStyle(key)   { if (key in ARP_STYLES) { _styleKey = key; recomputeForms(); } }
  function setTrigram(key) { _forcedTrigram = (key in TRIGRAM_CHORDS) ? key : null; }
  function clearTrigram()  { _forcedTrigram = null; }

  function setReverbMix(v) {
    if (_reverbSend) _reverbSend.gain.setTargetAtTime(Math.max(0,Math.min(1,v)) * 0.5, _audioCtx.currentTime, 0.1);
  }

  function setEnvelope({ a, d, s, r, gate } = {}) {
    if (a    != null) _envA    = Math.max(0.001, a);
    if (d    != null) _envD    = Math.max(0.001, d);
    if (s    != null) _envS    = Math.max(0, Math.min(1, s));
    if (r    != null) _envR    = Math.max(0.001, r);
    if (gate != null) _envGate = Math.max(0.05, Math.min(2.0, gate));
  }

  function setOscType(type) {
    if (!['sawtooth','square','sine','triangle'].includes(type)) return;
    _oscType = type;
    _voices.forEach(v => { if (v.started) v.osc1.type = type; });
  }

  function setSubLevel(level) {
    _subLevel = Math.max(0, Math.min(1, level));
    const t = _audioCtx?.currentTime ?? 0;
    _voices.forEach(v => v.subGain.gain.setTargetAtTime(_subLevel, t, 0.05));
  }

  function setFilter({ cutoff, res, envAmt, fltA, fltD } = {}) {
    if (cutoff != null) {
      _fltCutoff = Math.max(80, Math.min(18000, cutoff));
      const t = _audioCtx?.currentTime ?? 0;
      _voices.forEach(v => {
        if (v.started && t >= v.noteEndTime) {
          v.f1.frequency.setTargetAtTime(_fltCutoff, t, 0.05);
          v.f2.frequency.setTargetAtTime(_fltCutoff, t, 0.05);
        }
      });
    }
    if (res != null) {
      _fltRes = Math.max(0.01, Math.min(4, res));
      const t = _audioCtx?.currentTime ?? 0;
      _voices.forEach(v => {
        v.f1.Q.setTargetAtTime(_fltRes, t, 0.05);
        v.f2.Q.setTargetAtTime(_fltRes, t, 0.05);
      });
    }
    if (envAmt != null) _fltEnvAmt = Math.max(0, Math.min(1, envAmt));
    if (fltA   != null) _fltA = Math.max(0.001, fltA);
    if (fltD   != null) _fltD = Math.max(0.01,  fltD);
  }

  function setFm({ ratio, depth } = {}) {
    if (ratio != null) _fmRatio = Math.max(0.1, ratio);
    if (depth != null) {
      _fmDepth = Math.max(0, depth);
      const t = _audioCtx?.currentTime ?? 0;
      _voices.forEach(v => v.modDepth.gain.setTargetAtTime(_fmDepth, t, 0.05));
    }
  }

  function setEq({ low, mid, high } = {}) {
    if (low  != null) { _eqLow  = low;  if (_eqLowNode)  _eqLowNode.gain.value  = low;  }
    if (mid  != null) { _eqMid  = mid;  if (_eqMidNode)  _eqMidNode.gain.value  = mid;  }
    if (high != null) { _eqHigh = high; if (_eqHighNode) _eqHighNode.gain.value  = high; }
  }

  function isRunning()     { return _running; }
  function getTrigramKey() { return trigramKey(); }

  function receivePeer(deviceId, trit, ts) {
    _peerTrits[deviceId] = { trit, ts: ts ?? Date.now() };
  }

  function _badge(on) {
    const el = document.getElementById('ter-badge-sub');
    if (el) el.textContent = on ? 'ARP' : '';
  }

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
    setOscType, setSubLevel,
    setFilter, setFm, setEq,
    isRunning, receivePeer,
    getPhase: phaseState,
    getTrigramKey,
    chordIntervals,
    TRIGRAM_CHORDS, TRIGRAM_NAMES, ARP_STYLES,
  };

  console.log('[ternary/arp] Phase 6 — FM + 4-pole filter + 3-band EQ · lazy voice init · scheduler resync');
})();
