# ORCHID — Telepathic Instruments

*Seeded Jun 19 2026 · BYOB ternary session*

---

## The Concept

An orchid has a specific biological structure: sepals, petals, lip, column.
Each part does a distinct role. Together they are one flower. Separately they are meaningless.

ORCHID is a collective instrument where each phone in the BYOB room plays a
different **part** — determined not by assignment but by **sync quality**.
The instrument plays *itself* through the convergence of the room.

---

## How Parts Are Assigned (ternary native)

The trit state of each device at any moment is its role:

| Trit | Sync state | Voice role | Sound character |
|------|-----------|------------|-----------------|
| **N** | Diverging (>50ms drift) | **Sepal** — foundation | Bass register, sub frequencies, slow pedal tones |
| **Z** | Settling (10–50ms) | **Petal** — color layer | Pad drones, inner harmony, the wash |
| **P** | Converged (<10ms) | **Lip** — melodic attractor | Arp melody, upper octave, most articulated |

No assignment is ever made. Devices *earn* their voice by converging.
A phone that just walked in (N-trit, drifting) plays bass.
A phone that's been locked in all night (P-trit) carries the melody.

The sync engine IS the conductor.

---

## The Bloom Mechanic

When `tcons()` of the whole room = **PPP** (all devices converged) for 3
consecutive consensus readings (~45 seconds of full lock):

1. The bass (sepal) recedes — no longer needed as anchor
2. The harmony (petals) dissolves from sustained drone into upper extensions
3. The melody (lip) climbs to its highest register
4. After 4 bars of full bloom: graceful resolution, then silence

This is the moment the room **becomes the instrument completely**.
Nobody is playing it consciously. They just walked inside a geofence.

The audience doesn't know they're the orchestra.

---

## Architecture — 4 Phases

### Phase 1 — Role Assignment (build this first)
- `branch3(ownTrit())` → sepal / petal / lip voice register
- Visual badge on listener.html: shows current role
- P-voice plays 2 octaves above root, N-voice plays 1 octave below
- Status in ternary overlay: `SEPAL · PETAL · LIP` with count of each

### Phase 2 — Bloom Detection
- layer.js counts consecutive PPP consensus readings
- After 3 consecutive (threshold: ~45s at 5s tick): fires `bloom` event
- `bloom` event: exported on `window._terLayer.onBloom`
- Bloom sequence: 4-bar progression → silence
- `_calSeq = [P,P,P]` (the trigram for ☷ Earth) = bloom state

### Phase 3 — Visual (ternary/overlay.html)
- Each peer device = one petal on the orchid SVG
- Petal is closed/grey when N (diverging)
- Petal is half-open/colored when Z (settling)
- Petal is fully open/glowing when P (converged)
- All petals open = the bloom
- Petals animate based on real-time peer trit broadcasts on `byob_ternary`

### Phase 4 — Generative (no one plays — it plays itself)
- The arp's chord is driven entirely by room consensus trigram
- The pad's harmony follows
- No human input required — the instrument is the room's sync state
- A "session" is: phones enter, converge, bloom, resolve, fall silent

---

## The Ternary Math at the Core

```javascript
// The I Ching connection is exact, not metaphor:
// 3 consecutive consensus readings → trigram → harmony color
// tcons([N, N, N]) = ☰ Heaven (diverging room) → Major 7, tension/celestial
// tcons([P, P, P]) = ☷ Earth  (converged room)  → Major, stable/grounded

const bloom = calSeq.every(t => t === P);  // [P,P,P] = ☷ = the bloom condition

// Phase assignment:
branch3(ownTrit(),
  () => 'sepal',   // N: foundation
  () => 'petal',   // Z: harmony
  () => 'lip',     // P: melody
);
```

---

## Why "Orchid"

Orchids are:
- The most complex flower — multiple specialized parts working as one
- Known for mimicry: some orchids mimic other species to attract pollinators
- They require *specific conditions* to bloom — they won't force it
- Rare and beautiful precisely because the conditions are rarely met

ORCHID instruments mimic the room's convergence state.
They require the whole group to be in sync before they bloom.
That rarity is the point.

---

## Build Order

1. `listener.html` — expose `window._ownRole` (sepal/petal/lip) from trit state
2. `ternary/layer.js` — add bloom detection, `window._terLayer.onBloom` hook
3. `ternary/arp.js` — wire voice register to `window._ownRole` instead of `ownTrit()` directly
4. `ternary/overlay.html` — orchid petal SVG visualization
5. `ternary/orchid.js` — the bloom sequence (generative 4-bar phrase + silence)

---

*Oracle context: 55.1.4 → 15 (Abundance → Modesty) on the whole BYOB instrument.*
*The cauldron holds everything. The room becomes the sound.*
