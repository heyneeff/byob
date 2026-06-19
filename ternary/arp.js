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
  let _audioCtx     = null;
  let _voiceBus     = null;
  // Haas
  let _haasDelay    = null;
  let _haasL        = null;
  let _haasR        = null;
  // Distance
  let _distGain     = null;
  let _airFilter    = null;
  // Proximity EQ (3-band driven by distance)
  let _proxShelf    = null;   // low shelf — sub warmth/loss
  let _roomPeak     = null;   // low-mid peak — room buildup at distance
  let _presCut      = null;   // presence peak — forward close, dull far
  // Reverb
  let _dryGain      = null;
  let _reverbSend   = null;
  let _convolver    = null;
  let _reverbReturn = null;
  // Master bus
  let _comp         = null;
  let _airShelf     = null;
  let _tremoloLfo   = null;
  let _tremoloDepth = null;
  let _tremoloGain  = null;
  let _master       = null;
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
    const n = 512;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = 3 * x / (1 + 2 * Math.abs(x)); }
    return (_satCurveCache = c);
  }

  function createReverbIR(durS, decay) {
    const sr  = _audioCtx.sampleRate;
    const len = Math.floor(sr * durS);
    const buf = _audioCtx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  // ── Audio graph ───────────────────────────────────────────────────────────────

  function initAudio() {
    if (_audioCtx) return;
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    window._arpAudioCtx = _audioCtx;  // shared with pad.js

    _voiceBus = _audioCtx.createGain();
    _voiceBus.gain.value = 1;

    // Haas stereo spread — 8ms delay below echo threshold, panned L/R
    _haasDelay = _audioCtx.createDelay(0.02);
    _haasDelay.delayTime.value = 0.008;
    _haasL = _audioCtx.createStereoPanner(); _haasL.pan.value = -0.5;
    _haasR = _audioCtx.createStereoPanner(); _haasR.pan.value = +0.5;
    _voiceBus.connect(_haasL);
    _voiceBus.connect(_haasDelay); _haasDelay.connect(_haasR);

    // Distance volume
    _distGain = _audioCtx.createGain(); _distGain.gain.value = 1;
    _haasL.connect(_distGain); _haasR.connect(_distGain);

    // Air absorption LP
    _airFilter = _audioCtx.createBiquadFilter();
    _airFilter.type = 'lowpass'; _airFilter.frequency.value = 14000; _airFilter.Q.value = 0.5;

    // ── Proximity EQ — 3-band parametric driven by distance ──────────────────
    // Sub shelf: warm proximity bass close, sub-loss far
    _proxShelf = _audioCtx.createBiquadFilter();
    _proxShelf.type = 'lowshelf'; _proxShelf.frequency.value = 160; _proxShelf.gain.value = 3;

    // Room buildup: early reflections colour the 300-500Hz band at distance
    _roomPeak = _audioCtx.createBiquadFilter();
    _roomPeak.type = 'peaking'; _roomPeak.frequency.value = 370;
    _roomPeak.Q.value = 0.85; _roomPeak.gain.value = 0;

    // Presence: forward and intimate close, dull and withdrawn far
    _presCut = _audioCtx.createBiquadFilter();
    _presCut.type = 'peaking'; _presCut.frequency.value = 3200;
    _presCut.Q.value = 1.1; _presCut.gain.value = 3.5;

    // Reverb
    _dryGain     = _audioCtx.createGain(); _dryGain.gain.value = 1;
    _reverbSend  = _audioCtx.createGain(); _reverbSend.gain.value = 0;
    _convolver   = _audioCtx.createConvolver(); _convolver.buffer = createReverbIR(2.4, 1.6);
    _reverbReturn = _audioCtx.createGain(); _reverbReturn.gain.value = 0.52;

    // Master bus
    _comp = _audioCtx.createDynamicsCompressor();
    _comp.threshold.value = -20; _comp.ratio.value = 4;
    _comp.attack.value = 0.004; _comp.release.value = 0.18; _comp.knee.value = 8;

    _airShelf = _audioCtx.createBiquadFilter();
    _airShelf.type = 'highshelf'; _airShelf.frequency.value = 9000; _airShelf.gain.value = 2;

    // Tremolo — BPM-synced sine LFO on master amplitude
    _tremoloLfo   = _audioCtx.createOscillator();
    _tremoloLfo.type = 'sine'; _tremoloLfo.frequency.value = getBpm() / 120;
    _tremoloDepth = _audioCtx.createGain(); _tremoloDepth.gain.value = 0.10;
    _tremoloGain  = _audioCtx.createGain(); _tremoloGain.gain.value = 0.90;
    _tremoloLfo.connect(_tremoloDepth); _tremoloDepth.connect(_tremoloGain.gain);
    _tremoloLfo.start();

    _master = _audioCtx.createGain(); _master.gain.value = 0.42;

    // Wire:
    // voiceBus → haasL ↘
    //          → haasDelay→haasR ↗ → distGain → airFilter
    //   → proxShelf → roomPeak → presCut → dryGain ↘
    //                                    → reverbSend→convolver→reverbReturn ↗ → comp
    //   → airShelf → tremoloGain → master → destination
    _distGain.connect(_airFilter);
    _airFilter.connect(_proxShelf);
    _proxShelf.connect(_roomPeak);
    _roomPeak.connect(_presCut);
    _presCut.connect(_dryGain);
    _presCut.connect(_reverbSend);
    _dryGain.connect(_comp);
    _reverbSend.connect(_convolver); _convolver.connect(_reverbReturn); _reverbReturn.connect(_comp);
    _comp.connect(_airShelf);
    _airShelf.connect(_tremoloGain);
    _tremoloGain.connect(_master);
    _master.connect(_audioCtx.destination);
  }

  // ── Distance / proximity EQ update ───────────────────────────────────────────

  function updateSpace() {
    if (!_audioCtx) return;
    const distM  = window._zoneDistM ?? 0;
    const t      = _audioCtx.currentTime;
    const close  = Math.max(0, 1 - distM / 100);  // 1 at 0m, 0 at 100m+
    const far    = Math.min(distM / 150, 1);       // 0 at 0m, 1 at 150m+

    // Volume
    _distGain.gain.setTargetAtTime(Math.max(0.05, 1 / Math.pow(1 + distM / 45, 1.3)), t, 0.1);

    // Air LP
    _airFilter.frequency.setTargetAtTime(Math.max(500, 14000 * Math.pow(0.5, distM / 65)), t, 0.15);

    // Proximity EQ
    _proxShelf.gain.setTargetAtTime(close * 3 - far * 5,   t, 0.2);   // bass: +3 close, −5 far
    _roomPeak.gain.setTargetAtTime(far * 4.5,              t, 0.2);   // 370Hz: 0 close, +4.5 far
    _presCut.gain.setTargetAtTime(close * 3.5 - far * 5.5, t, 0.2);  // presence: +3.5 close, −5.5 far

    // Reverb wet
    const wet = Math.min(distM / 140, 0.78);
    _reverbSend.gain.setTargetAtTime(wet, t, 0.15);
    _dryGain.gain.setTargetAtTime(1 - wet * 0.25, t, 0.15);

    // Haas width — narrows at distance (reverb does the spreading instead)
    const w = Math.max(0.18, 0.5 - distM / 450);
    _haasL?.pan.setTargetAtTime(-w, t, 0.2); _haasR?.pan.setTargetAtTime(+w, t, 0.2);

    // Tremolo rate
    if (_tremoloLfo) _tremoloLfo.frequency.setTargetAtTime(getBpm() / 120, t, 0.3);
  }

  // ── Note synthesis ────────────────────────────────────────────────────────────
  // branch3() drives oscillator type — each trit voice has a distinct timbre.
  // tcmp()    drives phrasing — ascending lines get crisper attacks,
  //           descending lines get longer sustain.

  function playNote(midi, startS, stepDurS, accent, voice) {
    if (!_audioCtx) return;
    const hz  = midiToHz(midi);
    const dur = stepDurS * _envGate;

    // tcmp() — pitch direction shapes phrasing (ascending=crisp, descending=legato)
    const pitchDir   = tcmp(midi, _prevMidi);
    const attackMod  = branch3(pitchDir, () => 1.35, () => 1.0, () => 0.65);
    const sustainMod = branch3(pitchDir, () => 1.15, () => 1.0, () => 0.85);
    _prevMidi = midi;

    const effAttack  = _envA * attackMod;
    const effSustain = Math.min(_envS * sustainMod, 1);

    // branch3(voice) — N/Z/P get distinct oscillator timbres
    const oscType = branch3(voice,
      () => 'sine',      // N bass: sine — pure, sub-heavy
      () => 'triangle',  // Z mid:  triangle — warm, moderate harmonics
      () => 'sawtooth',  // P lead: sawtooth → shaped → bright, cuts through
    );

    const osc1 = _audioCtx.createOscillator();
    const osc2 = _audioCtx.createOscillator();
    osc1.type = osc2.type = oscType;
    osc1.frequency.value = hz; osc2.frequency.value = hz;
    osc1.detune.value = +7;    osc2.detune.value = -7;

    // Pitch glide on downbeats (accents ≥1.0) — brings the attack alive
    if (accent >= 1.0) {
      osc1.detune.setValueAtTime(+24, startS);
      osc1.detune.linearRampToValueAtTime(+7, startS + effAttack);
      osc2.detune.setValueAtTime(-24, startS);
      osc2.detune.linearRampToValueAtTime(-7, startS + effAttack);
    }

    // Sub oscillator — bass voice (N) only, adds physical weight
    if (voice === N) {
      const sub    = _audioCtx.createOscillator();
      const subEnv = _audioCtx.createGain();
      sub.type = 'sine';
      sub.frequency.value = hz / 2;
      subEnv.gain.setValueAtTime(0, startS);
      subEnv.gain.linearRampToValueAtTime(0.25 * accent, startS + effAttack * 1.8);
      subEnv.gain.setValueAtTime(0.25 * accent * effSustain, startS + effAttack * 1.8 + _envD);
      subEnv.gain.linearRampToValueAtTime(0, startS + dur);
      sub.connect(subEnv); subEnv.connect(_voiceBus);
      sub.start(startS); sub.stop(startS + dur + 0.05);
    }

    // Soft saturation (sawtooth especially benefits — tames harshness)
    const shaper = _audioCtx.createWaveShaper();
    shaper.curve = satCurve(); shaper.oversample = '2x';

    // Voice HP — branch3 for cutoff
    const hp = _audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = branch3(voice, () => 28, () => 60, () => 380);
    hp.Q.value = 0.65;

    // Presence — brighter on P-voice and accented downbeats
    const pres = _audioCtx.createBiquadFilter();
    pres.type = 'peaking'; pres.frequency.value = 2500; pres.Q.value = 1.4;
    pres.gain.value = branch3(voice, () => 0.5, () => 1.5, () => 3.5) * (accent >= 1.0 ? 1.4 : 1.0);

    // ADSR
    const env  = _audioCtx.createGain();
    const t0   = startS;
    const tA   = t0 + effAttack;
    const tD   = tA + _envD;
    const tR   = t0 + dur - _envR;
    const tEnd = t0 + dur;

    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(accent, tA);
    env.gain.linearRampToValueAtTime(accent * effSustain, tD);
    env.gain.setValueAtTime(accent * effSustain, Math.max(tD, tR));
    env.gain.linearRampToValueAtTime(0, tEnd);

    osc1.connect(shaper); osc2.connect(shaper);
    shaper.connect(hp); hp.connect(pres); pres.connect(env);
    env.connect(_voiceBus);

    osc1.start(t0); osc1.stop(tEnd + 0.05);
    osc2.start(t0); osc2.stop(tEnd + 0.05);
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
        updateSpace();
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
  function setBpm(bpm)        {
    _bpm = bpm;
    if (_tremoloLfo && _audioCtx)
      _tremoloLfo.frequency.setTargetAtTime(bpm / 120, _audioCtx.currentTime, 0.1);
  }
  function setStyle(key)      { if (key in ARP_STYLES) { _styleKey = key; recomputeForms(); } }
  function setTrigram(key)    { _forcedTrigram = (key in TRIGRAM_CHORDS) ? key : null; }
  function clearTrigram()     { _forcedTrigram = null; }
  function setHaasWidth(w)    {
    if (!_audioCtx) return;
    const t = _audioCtx.currentTime;
    _haasL?.pan.setTargetAtTime(-w, t, 0.05);
    _haasR?.pan.setTargetAtTime(+w, t, 0.05);
  }
  function setTremoloDepth(d) { if (_tremoloDepth) _tremoloDepth.gain.value = Math.max(0, Math.min(0.45, d)); }
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
