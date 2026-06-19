/**
 * ternary/arp.js  —  Phase 5: Ternary + Octonary Arpeggiator
 *
 * Signal chain:
 *   osc×2 (detuned triangle) + sub (bass only)
 *   → WaveShaper soft-clip → voice HP → presence EQ → ADSR (with pitch glide)
 *   → _voiceBus
 *   → Haas spread (8ms L/R delay)
 *   → distance gain (inverse power)
 *   → air LP (HF absorption)
 *   → proximity EQ (3-band: sub shelf · room peak · presence cut)
 *   → dry + reverb send (ConvolverNode synthetic IR)
 *   → DynamicsCompressor → HF shelf → tremolo (BPM LFO) → master → destination
 */

(function () {
  'use strict';

  // ── Balanced ternary VM primitives ───────────────────────────────────────────
  // These are the same primitives as /home/lewis/ternary/ — same math, musical context.
  const N = -1, Z = 0, P = 1;
  const tshift  = a        => a === P ? N : a + 1;                         // rotate P→N→Z→P
  const tcons   = (...vs)  => { const s = vs.reduce((a,v)=>a+v,0); return s>0?P:s<0?N:Z; };
  const tcmp    = (a, b)   => a < b ? N : a > b ? P : Z;                   // compare → trit
  const branch3 = (t,n,z,p)=> t === N ? n() : t === Z ? z() : p();         // 3-way dispatch

  // ── Arp styles ────────────────────────────────────────────────────────────────
  // Each style is a 9-trit melodic sequence. tshift() still produces 3 forms
  // (27-step total cycle) from each pattern — style × form = 18 variations.
  // rests[] — 1=play, 0=silent (step still advances time).
  // P=root(0st), Z=third(4st), N=fifth(7st) within whichever trigram chord.
  const ARP_STYLES = {
    UP:       { seq: [P,Z,N, P,Z,N, Z,P,N], rests: [1,1,1, 1,1,1, 1,1,1], name: 'Up' },
    DOWN:     { seq: [N,Z,P, N,Z,P, Z,N,P], rests: [1,1,1, 1,1,1, 1,1,1], name: 'Down' },
    BOUNCE:   { seq: [P,N,Z, P,N,Z, N,P,Z], rests: [1,1,1, 1,1,1, 1,1,1], name: 'Bounce' },
    FOLD:     { seq: [P,Z,N, N,Z,P, Z,P,N], rests: [1,1,1, 1,1,1, 1,1,1], name: 'Fold' },
    SKIP:     { seq: [P,N,P, Z,N,Z, N,P,Z], rests: [1,0,1, 1,0,1, 1,0,1], name: 'Skip' },
    PULSE:    { seq: [P,P,N, P,P,Z, P,N,Z], rests: [1,1,1, 1,0,1, 1,1,0], name: 'Pulse' },
  };

  // Three tshift() forms computed per style
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

  function currentForms()  { return _styleForms; }
  function currentRests()  { return ARP_STYLES[_styleKey].rests; }

  // ── Trit → scale degree (semitones above chord root) ─────────────────────────
  const TRIT_DEGREE = { [P]: 0, [Z]: 4, [N]: 7 };

  // ── 8 trigram chord colors ────────────────────────────────────────────────────
  const TRIGRAM_CHORDS = {
    'NNN': [0, 4, 7, 11],   // ☰ Heaven   — Major 7
    'NNP': [0, 4, 7, 9],    // ☱ Lake     — Major 6
    'NPN': [0, 4, 7, 10],   // ☲ Fire     — Dominant 7
    'NPP': [0, 3, 6, 10],   // ☳ Thunder  — Half-dim
    'PNN': [0, 5, 7, 12],   // ☴ Wind     — Sus4 add9
    'PNP': [0, 3, 7, 10],   // ☵ Water    — Minor 7
    'PPN': [0, 3, 6, 9],    // ☶ Mountain — Dim7
    'PPP': [0, 4, 7],       // ☷ Earth    — Major
  };
  const TRIGRAM_NAMES = {
    'NNN': '☰ Heaven', 'NNP': '☱ Lake',     'NPN': '☲ Fire',     'NPP': '☳ Thunder',
    'PNN': '☴ Wind',   'PNP': '☵ Water',    'PPN': '☶ Mountain', 'PPP': '☷ Earth',
  };

  // 3×3 accent grid — ternary rhythm within ternary rhythm
  const ACCENT = [1.0, 0.70, 0.48,  1.0, 0.70, 0.48,  1.0, 0.70, 0.48];

  // ── Envelope state (all in seconds, sustain 0–1) ──────────────────────────────
  let _envA    = 0.007;  // attack
  let _envD    = 0.055;  // decay
  let _envS    = 0.58;   // sustain level
  let _envR    = 0.09;   // release
  let _envGate = 0.82;   // note length as fraction of step duration

  // ── Core state ────────────────────────────────────────────────────────────────
  let _root    = 60;
  let _bpm     = 120;
  let _running = false;
  let _prevMidi = 60;  // for tcmp() pitch-direction phrasing

  // Sequencer
  let _step       = 0;
  let _form       = 0;
  let _nextNoteMs = 0;
  let _schedTimer = null;

  // Trigram
  let _trigramSeq    = [Z, Z, Z];
  let _forcedTrigram = null;
  let _peerTrits     = {};

  // ── Audio nodes ───────────────────────────────────────────────────────────────
  let _audioCtx    = null;
  let _voiceBus    = null;
  let _master      = null;
  let _voices      = [];      // pre-built voice pool — no per-note node creation
  let _voiceIdx    = 0;       // round-robin voice stealing
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

  // ── Note pitch calculation ────────────────────────────────────────────────────

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
      c[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);  // tanh — warmer than Padé
    }
    return (_satCurveCache = c);
  }

  // ── Reverb IR with early reflections ─────────────────────────────────────────
  function createPlateIR(durS) {
    const sr  = _audioCtx.sampleRate;
    const len = Math.floor(sr * durS);
    const buf = _audioCtx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      // Early reflections: 6 discrete echoes in first 80ms
      const erDelays = [0.011, 0.019, 0.029, 0.041, 0.058, 0.073];
      const erGains  = [0.60,  0.50,  0.42,  0.35,  0.28,  0.22 ];
      erDelays.forEach((dly, i) => {
        const idx = Math.floor(dly * sr);
        if (idx < len) d[idx] += erGains[i] * (c === 0 ? 1 : -0.85);
      });
      // Diffuse tail — exponential decay with slight randomness
      for (let i = Math.floor(0.08 * sr); i < len; i++) {
        const env = Math.pow(1 - i / len, 1.8);
        d[i] += (Math.random() * 2 - 1) * env * 0.35;
      }
    }
    return buf;
  }

  // ── Voice pool — 6 pre-built voices, stolen round-robin ──────────────────────
  // Each voice: osc1(saw) + osc2(saw, detuned) + osc3(square, sub character)
  //   → vcf (24dB LP, 2×biquad) → ampEnv → voiceBus
  // No nodes created during playback. Zero crashes.
  const NUM_VOICES = 6;

  function buildVoice() {
    const ctx = _audioCtx;
    const v = {};

    // Three oscillators per voice: 2 detuned saws + 1 square
    v.osc1 = ctx.createOscillator(); v.osc1.type = 'sawtooth';
    v.osc2 = ctx.createOscillator(); v.osc2.type = 'sawtooth';
    v.osc3 = ctx.createOscillator(); v.osc3.type = 'square';

    // Sub sine — one octave below, gives physical body
    v.sub  = ctx.createOscillator(); v.sub.type = 'sine';

    // Mix gains — osc2 slightly quieter, osc3 sub-character level, sub low
    v.g1 = ctx.createGain(); v.g1.gain.value = 0.50;
    v.g2 = ctx.createGain(); v.g2.gain.value = 0.45;
    v.g3 = ctx.createGain(); v.g3.gain.value = 0.18;
    v.gs = ctx.createGain(); v.gs.gain.value = 0.22;

    // VCF: two biquad LP in series = 24dB/oct Moog-style slope
    v.vcf1 = ctx.createBiquadFilter();
    v.vcf1.type = 'lowpass'; v.vcf1.frequency.value = 2200; v.vcf1.Q.value = 0.55;
    v.vcf2 = ctx.createBiquadFilter();
    v.vcf2.type = 'lowpass'; v.vcf2.frequency.value = 2200; v.vcf2.Q.value = 0.55;

    // Amplitude envelope
    v.ampEnv = ctx.createGain(); v.ampEnv.gain.value = 0;

    // Detune: osc1 sharp, osc2 flat, osc3 center — creates natural chorus beating
    v.osc1.detune.value = +11;
    v.osc2.detune.value = -11;
    v.osc3.detune.value = +3;

    // Wire: oscs → gains → vcf1 → vcf2 → ampEnv → voiceBus
    v.osc1.connect(v.g1); v.g1.connect(v.vcf1);
    v.osc2.connect(v.g2); v.g2.connect(v.vcf1);
    v.osc3.connect(v.g3); v.g3.connect(v.vcf1);
    v.sub.connect(v.gs);  v.gs.connect(v.vcf1);
    v.vcf1.connect(v.vcf2);
    v.vcf2.connect(v.ampEnv);
    v.ampEnv.connect(_voiceBus);

    // Start oscillators — they run forever, envelope controls amplitude
    v.osc1.start(); v.osc2.start(); v.osc3.start(); v.sub.start();

    v.noteEndTime = 0;
    return v;
  }

  // ── Audio graph ───────────────────────────────────────────────────────────────

  function initAudio() {
    if (_audioCtx) return;
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    window._arpAudioCtx = _audioCtx;

    _voiceBus = _audioCtx.createGain(); _voiceBus.gain.value = 0.8;

    // ── Juno-style stereo chorus ──────────────────────────────────────────────
    // Two delay lines, each modulated by a slow LFO, panned L and R.
    // Center delay 12ms, depth ±7ms, rate 0.45Hz — the butter.
    const chorusWet  = _audioCtx.createGain(); chorusWet.gain.value  = 0.5;
    const chorusDry  = _audioCtx.createGain(); chorusDry.gain.value  = 0.5;
    const delL = _audioCtx.createDelay(0.05); delL.delayTime.value = 0.012;
    const delR = _audioCtx.createDelay(0.05); delR.delayTime.value = 0.012;
    const panL = _audioCtx.createStereoPanner(); panL.pan.value = -0.7;
    const panR = _audioCtx.createStereoPanner(); panR.pan.value = +0.7;
    const lfoL = _audioCtx.createOscillator(); lfoL.frequency.value = 0.45;
    const lfoR = _audioCtx.createOscillator(); lfoR.frequency.value = 0.45;
    // Slight phase offset between L and R LFOs for width
    lfoR.detune.value = 180 * 100; // ~half cycle offset via detune trick
    const depL = _audioCtx.createGain(); depL.gain.value = 0.007;
    const depR = _audioCtx.createGain(); depR.gain.value = 0.007;
    lfoL.connect(depL); depL.connect(delL.delayTime);
    lfoR.connect(depR); depR.connect(delR.delayTime);
    lfoL.start(); lfoR.start();
    _voiceBus.connect(chorusDry);
    _voiceBus.connect(delL); delL.connect(panL); panL.connect(chorusWet);
    _voiceBus.connect(delR); delR.connect(panR); panR.connect(chorusWet);

    // ── Soft saturation (tape warmth) ─────────────────────────────────────────
    const sat = _audioCtx.createWaveShaper();
    sat.oversample = '4x';
    const sc = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = (i * 2) / 255 - 1; sc[i] = Math.tanh(x * 1.8) / Math.tanh(1.8); }
    sat.curve = sc;

    // ── Reverb (plate with early reflections, always 35% wet) ────────────────
    const reverbSend   = _audioCtx.createGain(); reverbSend.gain.value  = 0.35;
    const reverbReturn = _audioCtx.createGain(); reverbReturn.gain.value = 0.9;
    const conv = _audioCtx.createConvolver(); conv.buffer = createPlateIR(3.2);

    // ── Master bus: gentle limiter + warmth shelf ─────────────────────────────
    const warmth = _audioCtx.createBiquadFilter();
    warmth.type = 'lowshelf'; warmth.frequency.value = 200; warmth.gain.value = 2.5;

    const limiter = _audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.ratio.value = 12;
    limiter.attack.value = 0.002; limiter.release.value = 0.25; limiter.knee.value = 3;

    _master = _audioCtx.createGain(); _master.gain.value = 0.55;

    // Wire: voiceBus → chorus (dry+wet) → sat → warmth → reverb → limiter → master
    chorusDry.connect(sat); chorusWet.connect(sat);
    sat.connect(warmth);
    warmth.connect(limiter);
    warmth.connect(reverbSend); reverbSend.connect(conv); conv.connect(reverbReturn); reverbReturn.connect(limiter);
    limiter.connect(_master);
    _master.connect(_audioCtx.destination);

    // Build voice pool
    _voices = Array.from({ length: NUM_VOICES }, buildVoice);
    _voiceIdx = 0;
  }

  // ── Note playback via voice stealing ─────────────────────────────────────────
  // Steal the oldest voice (round-robin). Retune oscillators, sweep VCF,
  // trigger envelope. No new nodes. tcmp() drives phrasing as before.

  function playNote(midi, startS, stepDurS, accent, voice) {
    if (!_audioCtx || !_voices.length) return;

    const hz  = midiToHz(midi);
    const dur = stepDurS * _envGate;
    const t   = _audioCtx.currentTime;

    // tcmp() — ascending = crisper attack, descending = more sustain
    const pitchDir   = tcmp(midi, _prevMidi);
    const attackMod  = branch3(pitchDir, () => 1.3, () => 1.0, () => 0.70);
    const sustainMod = branch3(pitchDir, () => 1.1, () => 1.0, () => 0.88);
    _prevMidi = midi;

    const effA = _envA * attackMod;
    const effS = Math.min(_envS * sustainMod, 1);
    const tEnd = startS + dur;

    // Steal next voice
    const v = _voices[_voiceIdx % NUM_VOICES];
    _voiceIdx++;
    v.noteEndTime = tEnd;

    // Retune all oscillators to new pitch
    v.osc1.frequency.setValueAtTime(hz, startS);
    v.osc2.frequency.setValueAtTime(hz, startS);
    v.osc3.frequency.setValueAtTime(hz, startS);
    v.sub.frequency.setValueAtTime(hz / 2, startS);

    // VCF filter sweep — starts closed, sweeps open on attack (the butter)
    // N-voice: darker open (1200Hz→1800Hz), P-voice: brighter (1800Hz→3200Hz)
    const vcfStart = branch3(voice, () => 900,  () => 1400, () => 1800);
    const vcfPeak  = branch3(voice, () => 1800, () => 2600, () => 3800);
    const vcfSweepTime = effA * 1.4;
    v.vcf1.frequency.setValueAtTime(vcfStart, startS);
    v.vcf1.frequency.linearRampToValueAtTime(vcfPeak, startS + vcfSweepTime);
    v.vcf1.frequency.setTargetAtTime(vcfPeak * 0.85, startS + vcfSweepTime, 0.3);
    v.vcf2.frequency.setValueAtTime(vcfStart * 1.1, startS);
    v.vcf2.frequency.linearRampToValueAtTime(vcfPeak * 1.1, startS + vcfSweepTime);
    v.vcf2.frequency.setTargetAtTime(vcfPeak * 0.95, startS + vcfSweepTime, 0.3);

    // Sub level: louder for N (bass voice), near-silent for P (lead)
    const subLevel = branch3(voice, () => 0.30, () => 0.15, () => 0.05);
    v.gs.gain.setValueAtTime(subLevel * accent, startS);

    // ADSR on amplitude envelope
    const tA = startS + effA;
    const tD = tA + _envD;
    const tR = Math.max(tD + 0.01, tEnd - _envR);
    v.ampEnv.gain.cancelScheduledValues(t);
    v.ampEnv.gain.setValueAtTime(v.ampEnv.gain.value, startS);
    v.ampEnv.gain.linearRampToValueAtTime(accent * 0.85, tA);
    v.ampEnv.gain.linearRampToValueAtTime(accent * effS * 0.75, tD);
    v.ampEnv.gain.setValueAtTime(accent * effS * 0.75, tR);
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
      }

      if (_step === 0) {
        updateTrigram();
        window._terArpOnStep?.({ step: _step, form: _form, trigram: trigramKey() });
      }

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
  function setHaasWidth()     {}  // chorus handles stereo now
  function setTremoloDepth()  {}  // removed — chorus provides movement
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

  // BPM auto-sync from DJ broadcast
  setInterval(() => {
    const w = window._masterBPM;
    if (w && w > 40 && Math.abs(w - _bpm) > 1) _bpm = w;
  }, 2000);

  window._terArpReceivePeer = receivePeer;

  window._terArp = {
    start, stop, toggle,
    setRoot, setBpm, setStyle, setTrigram, clearTrigram,
    setHaasWidth, setTremoloDepth, setEnvelope,
    isRunning, receivePeer,
    getPhase: phaseState,
    getTrigramKey,
    chordIntervals,
    TRIGRAM_CHORDS, TRIGRAM_NAMES, ARP_STYLES,
  };

  console.log('[ternary/arp] loaded — 6 styles · 8 trigram chords · proximity EQ · envelope');
})();
