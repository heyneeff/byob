// BYOB relay — self-hosted replacement for the Supabase slice BYOB uses.
// One process = database (zones/tracks rows, JSON-persisted), realtime
// broadcast channels, postgres_changes-style row events, server_now clock
// authority, and audio storage with Range support.
//
// Run:  node bridge/relay.mjs          (port 3100)
// Expose to phones:  cloudflared tunnel --url http://localhost:3100
// Clients talk to it via ../byob-shim.js (drop-in supabase-js impersonator).
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, createReadStream, unlinkSync, readdirSync } from 'fs';
import { dirname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT       = Number(process.env.RELAY_PORT || 3100);
const DATA_FILE  = join(__dirname, 'relay-data.json');
const MEDIA_DIR  = join(__dirname, 'media');
mkdirSync(MEDIA_DIR, { recursive: true });

// ---------- table store ----------
const db = { zones: [], tracks: [], sampler_presets: [], events: [], event_interest: [], friendships: [], profiles: [] };
if (existsSync(DATA_FILE)) {
  try { Object.assign(db, JSON.parse(readFileSync(DATA_FILE, 'utf8'))); }
  catch (e) { console.error('relay-data.json unreadable, starting fresh:', e.message); }
}
let _saveTimer = null;
function persist() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try { writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('persist:', e.message); }
  }, 500);
}

function matches(row, filters) {
  return (filters || []).every(f => {
    const v = row[f.col];
    switch (f.type) {
      case 'eq':  return v === f.val || String(v) === String(f.val);
      case 'neq': return String(v) !== String(f.val);
      case 'in':  return (f.val || []).some(x => String(x) === String(v));
      case 'gte': return v >= f.val;
      case 'lte': return v <= f.val;
      case 'gt':  return v > f.val;
      case 'lt':  return v < f.val;
      default:    return true;
    }
  });
}

// One active zone per host: whenever a zone row becomes active, deactivate
// every OTHER zone with the same host_id. Single choke point — covers
// artist.html, bridge.mjs, and any future writer.
function enforceOneActiveZone(activeRow) {
  if (!activeRow || activeRow.active !== true) return;
  for (const z of db.zones) {
    if (z.id !== activeRow.id && z.host_id === activeRow.host_id && z.active) {
      const old = { ...z };
      z.active = false;
      emitPg('zones', 'UPDATE', z, old);
    }
  }
}

function runQuery(q) {
  const table = db[q.table];
  if (!table) return { data: null, error: { message: `unknown table ${q.table}` } };
  let data = null;

  if (q.verb === 'select') {
    let rows = table.filter(r => matches(r, q.filters));
    if (q.order) rows = rows.slice().sort((a, b) => {
      const { col, ascending } = q.order;
      const av = a[col], bv = b[col];
      if (av === bv) return 0;
      if (av == null) return 1;              // nullsLast
      if (bv == null) return -1;
      return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
    });
    if (q.limit != null) rows = rows.slice(0, q.limit);
    data = rows;
  } else if (q.verb === 'insert') {
    const inserted = (Array.isArray(q.payload) ? q.payload : [q.payload]).map(p => {
      const row = { id: randomUUID(), created_at: new Date().toISOString(), ...p };
      table.push(row);
      emitPg(q.table, 'INSERT', row, null);
      if (q.table === 'zones') enforceOneActiveZone(row);
      return row;
    });
    persist();
    data = inserted;
  } else if (q.verb === 'update') {
    const updated = [];
    for (const row of table) if (matches(row, q.filters)) {
      const old = { ...row };
      Object.assign(row, q.payload);
      updated.push(row);
      emitPg(q.table, 'UPDATE', row, old);
    }
    if (q.table === 'zones') updated.forEach(enforceOneActiveZone);
    persist();
    data = updated;
  } else if (q.verb === 'upsert') {
    const key = q.onConflict || 'id';
    data = (Array.isArray(q.payload) ? q.payload : [q.payload]).map(p => {
      let row = table.find(r => p[key] != null && String(r[key]) === String(p[key]));
      if (row) { const old = { ...row }; Object.assign(row, p, { updated_at: new Date().toISOString() }); emitPg(q.table, 'UPDATE', row, old); }
      else { row = { id: randomUUID(), created_at: new Date().toISOString(), ...p }; table.push(row); emitPg(q.table, 'INSERT', row, null); }
      if (q.table === 'zones') enforceOneActiveZone(row);
      return row;
    });
    persist();
  } else if (q.verb === 'delete') {
    const keep = [], gone = [];
    for (const row of table) (matches(row, q.filters) ? gone : keep).push(row);
    db[q.table] = keep;
    gone.forEach(r => emitPg(q.table, 'DELETE', null, r));
    persist();
    data = gone;
  } else {
    return { data: null, error: { message: `unknown verb ${q.verb}` } };
  }

  if (q.single) {
    if (data.length === 0) return q.single === 'maybe'
      ? { data: null, error: null }
      : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    return { data: data[0], error: null };
  }
  return { data, error: null };
}

// ---------- realtime ----------
const subsByChannel = new Map();   // channel -> Set<ws>
const tableSubs     = new Map();   // ws -> [{table, filters}]

function emitPg(table, event, newRow, oldRow) {
  const msg = JSON.stringify({ op: 'pg', table, event, new: newRow, old: oldRow });
  for (const [ws, subs] of tableSubs) {
    if (ws.readyState !== 1) continue;
    for (const s of subs) {
      if (s.table !== table) continue;
      const target = newRow || oldRow;
      if (s.filters && s.filters.length && !matches(target, s.filters)) continue;
      ws.send(msg);
      break;
    }
  }
}

const server = createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/storage\/([a-z0-9_-]+)\/(.+)$/i);

  if (url.pathname === '/health') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, now: new Date().toISOString(), zones: db.zones.length, tracks: db.tracks.length }));
  }

  if (m) {
    const filePath = normalize(join(MEDIA_DIR, m[1], m[2]));
    if (!filePath.startsWith(MEDIA_DIR)) { res.writeHead(403, cors); return res.end(); }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!existsSync(filePath)) { res.writeHead(404, cors); return res.end(); }
      const size = statSync(filePath).size;
      const type = /\.mp3$/i.test(filePath) ? 'audio/mpeg' : /\.m4a$/i.test(filePath) ? 'audio/mp4'
                 : /\.wav$/i.test(filePath) ? 'audio/wav' : /\.ogg$/i.test(filePath) ? 'audio/ogg'
                 : 'application/octet-stream';
      const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
      // Range support matters: iOS Safari audio seeking requires 206 responses.
      if (range && (range[1] || range[2])) {
        const start = range[1] ? parseInt(range[1]) : Math.max(0, size - parseInt(range[2]));
        const end   = range[1] && range[2] ? Math.min(parseInt(range[2]), size - 1) : size - 1;
        res.writeHead(206, { ...cors, 'Content-Type': type, 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
          'Cache-Control': 'public, max-age=86400' });
        if (req.method === 'HEAD') return res.end();
        return createReadStream(filePath, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...cors, 'Content-Type': type, 'Content-Length': size,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' });
      if (req.method === 'HEAD') return res.end();
      return createReadStream(filePath).pipe(res);
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      mkdirSync(dirname(filePath), { recursive: true });
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        writeFileSync(filePath, Buffer.concat(chunks));
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { path: `${m[1]}/${m[2]}` }, error: null }));
        console.log(`[storage] uploaded ${m[1]}/${m[2]} (${Buffer.concat(chunks).length} bytes)`);
      });
      return;
    }

    if (req.method === 'DELETE') {
      try { unlinkSync(filePath); } catch {}
      res.writeHead(200, cors); return res.end('{}');
    }
  }

  res.writeHead(404, cors); res.end();
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  ws.channels = new Set();
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const reply = obj => ws.readyState === 1 && ws.send(JSON.stringify({ id: msg.id, ...obj }));

    switch (msg.op) {
      case 'query': reply(runQuery(msg)); break;
      case 'rpc':
        if (msg.fn === 'server_now') reply({ data: new Date().toISOString(), error: null });
        else reply({ data: null, error: { message: `unknown rpc ${msg.fn}` } });
        break;
      case 'sub': {
        if (!subsByChannel.has(msg.channel)) subsByChannel.set(msg.channel, new Set());
        subsByChannel.get(msg.channel).add(ws);
        ws.channels.add(msg.channel);
        reply({ data: 'SUBSCRIBED' });
        break;
      }
      case 'unsub': {
        subsByChannel.get(msg.channel)?.delete(ws);
        ws.channels.delete(msg.channel);
        break;
      }
      case 'bcast': {
        const peers = subsByChannel.get(msg.channel);
        if (peers) {
          const out = JSON.stringify({ op: 'bcast', channel: msg.channel, event: msg.event, payload: msg.payload });
          for (const peer of peers) if (peer !== ws && peer.readyState === 1) peer.send(out);
        }
        break;
      }
      case 'subtable': {
        if (!tableSubs.has(ws)) tableSubs.set(ws, []);
        tableSubs.get(ws).push({ table: msg.table, filters: msg.filters || [] });
        reply({ data: 'SUBSCRIBED' });
        break;
      }
    }
  });
  ws.on('close', () => {
    for (const ch of ws.channels) subsByChannel.get(ch)?.delete(ws);
    tableSubs.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  BYOB RELAY — self-hosted backend    ║');
  console.log(`║  http+ws → http://localhost:${PORT}     ║`);
  console.log(`║  zones: ${String(db.zones.length).padEnd(3)} tracks: ${String(db.tracks.length).padEnd(3)}            ║`);
  console.log('║  tunnel: cloudflared tunnel          ║');
  console.log(`║          --url http://localhost:${PORT} ║`);
  console.log('╚══════════════════════════════════════╝');
});
