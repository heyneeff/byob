#!/usr/bin/env node
// watchdog.mjs — keeps the BYOB backend alive for a whole show.
//
// Owns two things and never dies with either of them:
//   1. relay.mjs   — health-checked every 15s, respawned (detached) if down
//   2. cloudflared — the *published tunnel URL* is probed end-to-end every
//      60s (a quick tunnel can die while its process lives — observed twice
//      live, 2026-07-13/14); after 2 consecutive failures the tunnel is
//      killed, a fresh one is started, and the new URL is republished to
//      ../relay.json + pushed to Pages so phones can re-resolve
//      (byob-shim.js re-fetches /relay.json after sustained WS failure).
//
// Everything is spawned detached with its own log file — nothing shares a
// killable process group with a terminal. Logs: bridge/watchdog.log,
// bridge/relay.log, bridge/tunnel.log.
//
// Usage: node watchdog.mjs   (start.command runs this instead of managing
// relay/tunnel inline)

import { spawn, execSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(DIR, '..');
const RELAY_HEALTH = 'http://localhost:3100/health';
const RELAY_JSON = join(REPO, 'relay.json');
const WD_LOG = join(DIR, 'watchdog.log');

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { appendFileSync(WD_LOG, line + '\n'); } catch (e) {}
};

async function probe(url, timeoutMs = 5000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch (e) { return false; }
}

function spawnDetached(cmd, args, logFile) {
  const fd = openSync(logFile, 'a');
  const child = spawn(cmd, args, { cwd: DIR, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  return child.pid;
}

// ── relay supervision ────────────────────────────────────────────────────────
let relayRestarts = 0;
async function ensureRelay() {
  if (await probe(RELAY_HEALTH, 3000)) return;
  relayRestarts++;
  log(`relay DOWN — respawning (restart #${relayRestarts})`);
  spawnDetached('node', ['relay.mjs'], join(DIR, 'relay.log'));
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await probe(RELAY_HEALTH, 2000)) { log('relay back up'); return; }
  }
  log('relay did NOT come back within 10s — will retry next cycle');
}

// ── tunnel supervision ───────────────────────────────────────────────────────
let tunnelFails = 0;
let rotating = false;

function publishedTunnelUrl() {
  try { return JSON.parse(readFileSync(RELAY_JSON, 'utf8')).relay || null; }
  catch (e) { return null; }
}

function killCloudflared() {
  try { execSync('pkill -f "cloudflared tunnel" 2>/dev/null'); } catch (e) {}
}

async function rotateTunnel() {
  if (rotating) return;
  rotating = true;
  try {
    log('tunnel rotation: killing old cloudflared, starting fresh');
    killCloudflared();
    await new Promise(r => setTimeout(r, 1000));
    const tunnelLog = join(DIR, 'tunnel.log');
    try { writeFileSync(tunnelLog, ''); } catch (e) {}
    spawnDetached('cloudflared', ['tunnel', '--url', 'http://localhost:3100'], tunnelLog);

    let url = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      const m = readFileSync(tunnelLog, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { url = m[0]; break; }
    }
    if (!url) { log('tunnel rotation FAILED — no URL in cloudflared output after 30s'); return; }

    // verify end-to-end before publishing (fresh tunnels take a moment to route)
    let live = false;
    for (let i = 0; i < 20 && !live; i++) {
      await new Promise(r => setTimeout(r, 1000));
      live = await probe(url + '/health', 4000);
    }
    if (!live) { log(`tunnel rotation: ${url} allocated but not routing yet — publishing anyway (phones retry)`); }

    writeFileSync(RELAY_JSON, JSON.stringify({ relay: url, ts: new Date().toISOString() }) + '\n');
    try {
      execSync(`git -C "${REPO}" add relay.json && git -C "${REPO}" commit -q -m "relay: publish tunnel URL (watchdog rotation)" && git -C "${REPO}" push -q origin main`, { stdio: 'pipe' });
      log(`tunnel rotated → ${url} (published to Pages; phones re-resolve within ~1-2min of deploy)`);
    } catch (e) {
      log(`tunnel rotated → ${url} but PUBLISH PUSH FAILED: ${e.message} — phones on the old URL cannot recover until relay.json is pushed`);
    }
    tunnelFails = 0;
  } finally {
    rotating = false;
  }
}

async function checkTunnel() {
  const url = publishedTunnelUrl();
  if (!url) { log('no published tunnel URL in relay.json — rotating to create one'); await rotateTunnel(); return; }
  if (await probe(url + '/health', 6000)) { tunnelFails = 0; return; }
  tunnelFails++;
  log(`tunnel probe FAILED (${tunnelFails}/2): ${url}`);
  if (tunnelFails >= 2) await rotateTunnel();
}

// ── main loop ────────────────────────────────────────────────────────────────
log('watchdog up — relay every 15s, tunnel end-to-end every 60s');
await ensureRelay();
await checkTunnel();
setInterval(ensureRelay, 15_000);
setInterval(checkTunnel, 60_000);
process.on('uncaughtException', e => log('watchdog uncaughtException:', e.stack || e.message));
process.on('unhandledRejection', e => log('watchdog unhandledRejection:', e && (e.stack || e.message || e)));
