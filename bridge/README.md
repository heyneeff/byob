# BYOB Bridge — Launch Guide

Turn Ableton Live into a live spatial instrument played through 1000 Bluetooth speakers.

---

## What this is

The bridge is a Node.js process that runs on the performance laptop. It:

- Reads tempo + beat position from **Ableton Link** → anchors all phones to Ableton's transport
- Captures Ableton audio tracks via **Blackhole** (free virtual audio driver) → publishes each stem as a separate live stream via **Livekit** (free SFU — handles the 1000-phone fanout, not your laptop)
- Serves a **spatial controller UI** at `localhost:3000` — radar showing all phones on a GPS map, cluster/ring/sweep/scatter/movement controls, slot volumes and FX, rally point
- Pushes all sync commands to phones via **Supabase realtime**

Phones run `listener.html` unchanged. They subscribe to their assigned stem track from Livekit and the BYOB sync engine handles Bluetooth latency calibration per device.

---

## One-time setup

### 1. Install Node.js

```bash
brew install node
```

### 2. Install bridge dependencies

```bash
cd ~/byob/bridge
npm install
```

### 3. Install Blackhole (free virtual audio driver)

Download **Blackhole 64ch** from https://existential.audio/blackhole/

This lets your Mac send audio to the bridge without a cable.

### 4. Set up macOS Multi-Output Device (so you still hear Ableton)

Open **Audio MIDI Setup** (search Spotlight):

1. Click **+** → **Create Multi-Output Device**
2. Check both your normal interface AND **Blackhole 64ch**
3. In Ableton → Preferences → Audio → Output Device → set to **Multi-Output Device**

Now Ableton audio goes to your speakers/headphones AND to the bridge simultaneously.

### 5. Route Ableton tracks to Blackhole

In each Ableton track you want to broadcast as a stem:
- Set the track's **Audio To** output to **Blackhole 64ch**
- Assign channel pairs: Track 1 → ch 1/2, Track 2 → ch 3/4, Track 3 → ch 5/6, etc.

### 6. Set up Livekit (free)

1. Create account at https://livekit.io
2. Create a project → copy **URL**, **API Key**, **Secret**
3. In `byob/bridge/`, copy `.env.example` to `.env` and fill in:

```
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_KEY=your-api-key
LIVEKIT_SECRET=your-api-secret
```

---

## Every show: launch sequence

### Step 1 — Zone setup (one time per venue, use artist.html)

Open `artist.html`, log in, create a zone with the GPS geofence for the venue. This is the only thing `artist.html` is needed for now.

### Step 2 — Start the bridge

```bash
cd ~/byob/bridge
node bridge.mjs
```

You should see:
```
╔═══════════════════════════════════════╗
║  BYOB Link Bridge                     ║
║  UI → http://localhost:3000           ║
╚═══════════════════════════════════════╝

[clock] offset +XXms
[link] Ableton Link enabled
[ready] Open http://localhost:3000
```

### Step 3 — Open the spatial controller

Open **http://localhost:3000** in Chrome next to Ableton.

### Step 4 — Enable Ableton Link

In Ableton → top bar → click **Link** (turns blue). The BPM display in the bridge UI will update to match Ableton's tempo.

### Step 5 — Connect to your zone

In the spatial controller, click **↻** next to the zone picker to load your active zones. Select your zone. The radar will start showing phones as people arrive.

### Step 6 — Go live

In the **Live Stems** section:
1. Click **↻ Scan** to detect your Blackhole device (it auto-selects if found)
2. Set stem count to match how many Ableton tracks you're broadcasting
3. Click **🔴 GO LIVE** — stems start streaming to Livekit

### Step 7 — Anchor to Ableton transport

Hit **Play** in Ableton, then immediately click **▶ PLAY** in the bridge UI. This locks all phones to Ableton's beat position. From this point they are phase-locked to your transport.

### Step 8 — Perform

Use the spatial controls to move stems around the crowd in real time:

| Mode | What it does |
|------|-------------|
| **Single** | All phones play the same stem (slot C) |
| **Cluster** | Groups phones by GPS proximity, each group gets a different stem |
| **Ring** | Concentric rings by distance from center, inner ring gets bass etc. |
| **Sweep** | A rotating beam sweeps through the crowd assigning stems in sequence |
| **Scatter** | Staggers start times to create a wave/echo effect |
| **Movement** | Auto-cycles stems across phones on an interval (wave/pulse/orbit/swing) |

Use **Slot Volumes** to mix stems across the crowd. Use **🌊** (pulse FX) to add beat-locked tremolo to any slot.

### Step 9 — If phones drift

Click **⚡ RE-SYNC** to snap all phones back to the correct position instantly.

---

## Stem → slot mapping

Stems map to slots by Blackhole channel order:

```
Blackhole ch 1/2  →  slot C   (center — plays to all unassigned phones)
Blackhole ch 3/4  →  slot 1
Blackhole ch 5/6  →  slot 2
Blackhole ch 7/8  →  slot 3
...up to slot 11 (12 total)
```

Design your Ableton set with this in mind — what goes in slot C is what everyone hears when no spatial mode is active.

---

## Files

| File | Role |
|------|------|
| `bridge.mjs` | Main process — Link, WebSocket server, Supabase, spatial commands |
| `stems.mjs` | Blackhole capture + Livekit publishing |
| `ui/index.html` | Spatial controller UI |
| `package.json` | Dependencies |
| `.env` | Your Livekit credentials (never commit) |
| `.env.example` | Template for `.env` |

---

## Git

The `bridge/` folder lives inside the `byob` repo at `github.com/heyneeff/byob`. Commit and push like any other file — `node_modules/` and `.env` are gitignored automatically.

```bash
cd ~/byob
git add bridge/
git commit -m "add Ableton Link bridge + spatial controller"
git push
```
