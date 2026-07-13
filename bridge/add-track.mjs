// Add a local audio file to the BYOB library (relay storage + tracks row).
// Usage: node add-track.mjs <audio-file> [title]
import { readFileSync } from 'fs';
import { basename } from 'path';
import '../byob-shim.js';
const { createClient } = globalThis.supabase;

const SERVER = process.env.BYOB_SERVER || 'http://localhost:3100';
const file = process.argv[2];
if (!file) { console.error('Usage: node add-track.mjs <audio-file> [title]'); process.exit(1); }
const title = process.argv[3] || basename(file).replace(/\.[^/.]+$/, '');

const ext = file.split('.').pop().toLowerCase();
const mime = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff' }[ext] || 'application/octet-stream';
const key = 'tracks/' + basename(file).replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '');

const body = readFileSync(file);
const up = await fetch(`${SERVER}/storage/boombox/${key}`, { method: 'POST', body, headers: { 'Content-Type': mime } });
if (!up.ok) { console.error('upload failed:', up.status); process.exit(1); }

// public_url must be reachable from PHONES — prefer the published tunnel.
let base = process.env.BYOB_PUBLIC_URL || null;
if (!base) {
  try {
    const r = await fetch('https://boombox.productions/relay.json', { cache: 'no-store' });
    base = (await r.json()).relay;
  } catch (e) {}
}
const publicUrl = `${base || SERVER}/storage/boombox/${key}`;

const db = createClient(SERVER);
await new Promise(r => setTimeout(r, 300));
const { data, error } = await db.from('tracks').insert({ title, file_path: key, public_url: publicUrl }).select().single();
if (error) { console.error('row insert failed:', error.message); process.exit(1); }
console.log(`✓ "${title}" added (${(body.length / 1e6).toFixed(1)}MB) → ${publicUrl}`);
process.exit(0);
