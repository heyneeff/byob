# Back to Perfect Sync — recovery plan (2026-07-15 late, LAN window)

## Where we are (measured, not vibes)

- **3 phones ARE synced**: 24–40ms of each other for the last ~15 min
  (`mstwn2`, `404em4`, `m8uljq`/`z7m1xs` band). That's inside the DnB budget
  (16th @ 170 BPM ≈ 88ms; "one system" ≤ ~30ms).
- **The chaos is two specific things, not the room:**
  1. **New phone lagging** (`m01p9h` → `jmqxhx` → likely `ljan8q` after
     reloads): fresh identity, `deviceLatencyMs=0`, true output latency
     ~250ms → textbook snap-loop (snap lands 250ms off, re-measures, snaps
     again, 8–29 snaps/window). Every reload wipes its progress and restarts
     the lesson.
  2. **Reload ghosts**: every page reload mints a new telemetry identity that
     free-runs (±5–47s off) until it loads the current reference. Sounds like
     a phone "playing something else" — because it is, briefly (or minutes,
     if it wedges).
- Whole-room common-mode offset vs the nominal row clock is the anchor lane —
  phones chase the DJ deck's live position by design. Inaudible BETWEEN phones
  while small. **BUT it is stepping up ~+80ms per launch (60 → 140 → 225ms),
  and at ~225ms the settled trio went into lockstep snap-thrash (15
  snaps/window each)** — two authorities (row clock vs anchor) now fight over
  currentTime: snap to one, get re-measured against the other, snap again.
  This is tonight's actual "chaotic as heck" sound (each snap = audible
  mute+ramp). → New structural item 0 below; ops workaround: stop launching.
- Kill-broadcast landmine (found tonight): the deck's armed stop nulls
  track+reference; an accidental fire desyncs everything and the page can't
  restore the zone after reload. Recovered server-side this time.

## Tonight — get the room clean (ops only, ~15 min)

1. **Freeze the deck.** No launches, no reloads, no tab switches for 5
   minutes. Auto-cal + snap-cal need uninterrupted N-state (30s runs, 60s
   between corrections) to teach the new phone its ~250ms floor. Every
   interruption restarts the clock.
2. **The lagging phone: do NOT reload it.** Reload = new identity = cal wiped
   = start over. Leave it playing, screen on, and let snap-cal learn from its
   own snap evidence. Expect 2–3 corrections (~3–5 min) before it locks.
3. After the quiet stretch, **one deliberate launch** (different track) to
   collect any off-reference stragglers (`ljan8q` at −14.5s) onto the fresh
   reference. Then hands off again.
4. **Ear-check + mark.** When it sounds like one system, say "SYNCED" style
   marker (HUD) + export CSV — that's the recovered-room evidence, tagged
   against `baseline-sync-jul15`.
5. If the new phone is STILL looping after two quiet cycles: same-URL
   relaunch (the dev-build wedge cure) once, and if that fails, note it
   honestly as a greenhorn-cal gap and move on — one device must not hold
   the room hostage.

## Structural fixes queued (dev branch, in campaign order)

| # | Fix | Why (tonight's evidence) | Gate |
|---|---|---|---|
| 1 | **Greenhorn fast-cal**: seed `deviceLatencyMs` from the FIRST snap's landing error (snap-cal already measures seekIntended vs seekMeasured) instead of waiting for consecutive-N windows | new phone snap-looped for 20+ min across 3 identities | **cast** (cal logic) |
| 2 | **Kill-broadcast guard**: stop path keeps `playback_started_at` recoverable (park it in a `last_reference` field or require zone re-arm instead of nulling) so an accidental kill can be undone from the deck | tonight's row-null desynced the whole room; UI couldn't restore | **cast** (launch path) |
| 3 | **Launch re-broadcast** (artist/relay path, not bridge): re-emit launch state for ~30s post-launch so waking/reloading tabs re-arm in seconds | reload ghosts free-ran ±5–47s until next poll | **cast** (already planned, step 4) |
| 4 | **Prefetch next track** | launches still cold-fetch room-wide | **cast** (step 5) |
| 5 | Identity stability across reloads (telemetry id + cal continuity) — investigate why fresh sessions keep starting at lat=0 on the same physical phone | 18 identities in one 9-min CSV | design first |

Steps 1–2 are new tonight (evidence-driven); 3–4 were already in the campaign
plan; merge dev→main stays gated on this LAN window passing its checklist
(`~/.claude/plans/hey-claude-please-familiarize-sparkling-liskov.md`).

## The bar (unchanged)

M2: 20 consecutive launches, all devices <50ms of reference within 3s.
Tonight's sub-goal: the recovered stable room — every playing device within
~30ms of each other, no snap-loops, no ghosts — certified by ear + CSV.
