// byob-shim.js — drop-in impersonation of the supabase-js slice BYOB uses,
// backed by bridge/relay.mjs over one WebSocket. No quotas, no cloud.
//
// Browser: <script src="byob-shim.js"></script> (replaces the jsdelivr
//          supabase-js tag; code keeps calling supabase.createClient()).
// Node:    import './byob-shim.js'; const { createClient } = globalThis.supabase;
//          (Node >= 22: global WebSocket + fetch, no deps.)
//
// Server URL resolution (browser): ?server= query param (persisted) >
// localStorage.byob_server > URL passed to createClient. Phones joining
// through a Cloudflare tunnel get ?server=https://xxx.trycloudflare.com
// appended to the listener link by artist.html.
(function () {
  'use strict';
  const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

  // Relay discovery, in precedence order:
  //   1. ?server= query param (explicit override, persisted)
  //   2. /relay.json on this page's own origin — start.command publishes the
  //      current tunnel URL there, so phones just open the site and the
  //      geofence does the rest (no QR, no params)
  //   3. last-known relay from localStorage (offline/cached fallback)
  //   4. the URL passed to createClient (localhost default)
  // Node: BYOB_SERVER env var > arg.
  async function resolveServer(urlArg) {
    let u = urlArg || 'http://localhost:3100';
    if (IS_BROWSER) {
      try {
        const p = new URLSearchParams(location.search).get('server');
        if (p) u = p;
        else if (location.protocol.startsWith('http') &&
                 !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
          try {
            const r = await fetch('/relay.json?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(3000) });
            if (r.ok) { const j = await r.json(); if (j && j.relay) u = j.relay; }
          } catch (e) {}
          if (u === (urlArg || 'http://localhost:3100')) u = store.get('byob_server') || u;
        }
        store.set('byob_server', u);
      } catch (e) {}
    } else if (typeof process !== 'undefined' && process.env && process.env.BYOB_SERVER) {
      u = process.env.BYOB_SERVER;
    }
    return u.replace(/\/+$/, '');
  }

  // ---------- persistent fake auth (no accounts; one stable local identity) ----------
  const mem = {};
  const store = {
    get(k) { try { return IS_BROWSER ? localStorage.getItem(k) : mem[k]; } catch (e) { return mem[k]; } },
    set(k, v) { try { if (IS_BROWSER) localStorage.setItem(k, v); } catch (e) {} mem[k] = v; },
    del(k) { try { if (IS_BROWSER) localStorage.removeItem(k); } catch (e) {} delete mem[k]; },
  };
  function uuid() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
        });
  }
  function localUser() {
    let raw = store.get('byob_local_user');
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
    const u = { id: uuid(), email: null, is_anonymous: true, user_metadata: {}, created_at: new Date().toISOString() };
    store.set('byob_local_user', JSON.stringify(u));
    return u;
  }

  function createClient(urlArg /*, key */) {
    let httpUrl = (urlArg || 'http://localhost:3100').replace(/\/+$/, '');
    let wsUrl = httpUrl.replace(/^http/, 'ws');
    const ready = resolveServer(urlArg).then(u => {
      httpUrl = u;
      wsUrl = u.replace(/^http/, 'ws');
    });

    // ---------- storage-URL healing ----------
    // Stored rows carry absolute /storage/ URLs captured at upload time, but
    // Cloudflare quick tunnels rotate on every restart — so a stored host can
    // be dead while the relay itself is reachable. Rewrite any stale storage
    // URL (old tunnel or localhost) to THIS client's resolved relay origin.
    // httpUrl is final before onmessage can fire (connect() awaits `ready`).
    const STORAGE_URL_RE = /^https?:\/\/(?:[^\/]*\.trycloudflare\.com|localhost:3100|127\.0\.0\.1:3100)(\/storage\/.+)$/;
    function normalizeUrls(v) {
      if (typeof v === 'string') {
        const m = v.match(STORAGE_URL_RE);
        return m ? httpUrl + m[1] : v;
      }
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = normalizeUrls(v[i]); return v; }
      if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = normalizeUrls(v[k]); return v; }
      return v;
    }

    // ---------- one WebSocket, auto-reconnect, resubscribe ----------
    let ws = null, wsOpen = false, nextId = 1;
    let wsFailures = 0;

    // A quick tunnel can die while this page lives; the published
    // /relay.json on this origin is the recovery channel. After every 6
    // consecutive failed reconnects (~10s+), re-fetch it — if it names a
    // different relay, adopt it IN PLACE (httpUrl/wsUrl are read dynamically
    // by connect() and normalizeUrls(), so no reload is needed). This
    // deliberately outranks a stale ?server= override: a dead explicit URL
    // is worse than any published fallback.
    async function reResolveServer() {
      if (!IS_BROWSER || !location.protocol.startsWith('http') ||
          /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
      try {
        const r = await fetch('/relay.json?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (!r.ok) return;
        const j = await r.json();
        const fresh = j && j.relay && String(j.relay).replace(/\/+$/, '');
        if (fresh && fresh !== httpUrl) {
          console.log('[byob-shim] relay moved — adopting', fresh, '(was', httpUrl + ')');
          httpUrl = fresh;
          wsUrl = fresh.replace(/^http/, 'ws');
          store.set('byob_server', fresh);
        }
      } catch (e) {}
    }
    const pending = new Map();      // id -> resolve
    const sendQueue = [];
    const channelSubs = new Map();  // channelName -> Set<handlerFns for bcast>
    const tableSubHandlers = [];    // {table, filters, cb}
    const resubs = [];              // raw sub msgs to replay on reconnect

    function wsSend(obj) {
      const raw = JSON.stringify(obj);
      if (wsOpen) ws.send(raw); else sendQueue.push(raw);
    }
    function request(obj) {
      return new Promise(resolve => {
        const id = nextId++;
        pending.set(id, resolve);
        wsSend({ id, ...obj });
      });
    }
    async function connect() {
      await ready;   // relay discovery must finish before the socket opens
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        wsOpen = true;
        wsFailures = 0;
        for (const raw of resubs) ws.send(raw);
        while (sendQueue.length) ws.send(sendQueue.shift());
      };
      ws.onmessage = ev => {
        let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        normalizeUrls(msg);  // heal stale tunnel-host storage URLs in rows, bcast payloads, pg events
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
        if (msg.op === 'bcast') {
          const hs = channelSubs.get(msg.channel);
          if (hs) for (const h of hs) {
            if (h.event === msg.event || h.event === '*') {
              try { h.cb({ event: msg.event, payload: msg.payload, type: 'broadcast' }); } catch (e) { console.error('bcast handler:', e); }
            }
          }
        } else if (msg.op === 'pg') {
          for (const h of tableSubHandlers) {
            if (h.table !== msg.table) continue;
            if (h.event !== '*' && h.event !== msg.event) continue;
            const target = msg.new || msg.old;
            if (h.filters.length && !h.filters.every(f => String(target && target[f.col]) === String(f.val))) continue;
            try { h.cb({ new: msg.new, old: msg.old, eventType: msg.event, table: msg.table, schema: 'public' }); } catch (e) { console.error('pg handler:', e); }
          }
        }
      };
      ws.onclose = () => {
        wsOpen = false;
        wsFailures++;
        for (const [, resolve] of pending) resolve({ data: null, error: { message: 'relay connection lost' } });
        pending.clear();
        if (wsFailures % 6 === 0) reResolveServer();
        // mild backoff, capped — a dead hostname shouldn't be hammered at 1Hz
        setTimeout(connect, Math.min(5000, 1000 + wsFailures * 300) + Math.random() * 1000);
      };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
    }
    connect();

    // ---------- query builder ----------
    function builder(table) {
      const q = { op: 'query', table, verb: 'select', filters: [] };
      const api = {
        select(cols) { if (q.verb === 'select') q.cols = cols; else q.returning = true; return api; },
        insert(payload) { q.verb = 'insert'; q.payload = payload; return api; },
        update(payload) { q.verb = 'update'; q.payload = payload; return api; },
        upsert(payload, opts) { q.verb = 'upsert'; q.payload = payload; q.onConflict = opts && opts.onConflict; return api; },
        delete() { q.verb = 'delete'; return api; },
        eq(col, val)  { q.filters.push({ type: 'eq', col, val }); return api; },
        neq(col, val) { q.filters.push({ type: 'neq', col, val }); return api; },
        in(col, val)  { q.filters.push({ type: 'in', col, val }); return api; },
        gte(col, val) { q.filters.push({ type: 'gte', col, val }); return api; },
        lte(col, val) { q.filters.push({ type: 'lte', col, val }); return api; },
        order(col, opts) { q.order = { col, ascending: !opts || opts.ascending !== false }; return api; },
        limit(n) { q.limit = n; return api; },
        single()      { q.single = 'single'; return api; },
        maybeSingle() { q.single = 'maybe';  return api; },
        then(res, rej) { return request(q).then(r => ({ data: r.data, error: r.error || null })).then(res, rej); },
      };
      return api;
    }

    // ---------- channels ----------
    function makeChannel(name) {
      const handlers = { bcast: [], pg: [] };
      let subscribed = false;
      const ch = {
        topic: name,
        on(type, filter, cb) {
          if (type === 'broadcast') handlers.bcast.push({ event: (filter && filter.event) || '*', cb });
          else if (type === 'postgres_changes') {
            const filters = [];
            if (filter && filter.filter) {
              const fm = String(filter.filter).match(/^([a-z_]+)=eq\.(.+)$/i);
              if (fm) filters.push({ col: fm[1], val: fm[2] });
            }
            handlers.pg.push({ table: filter && filter.table, event: (filter && filter.event) || '*', filters, cb });
          }
          return ch;
        },
        subscribe(cb) {
          if (subscribed) { cb && cb('SUBSCRIBED'); return ch; }
          subscribed = true;
          if (handlers.bcast.length || true) {  // always join: send() targets peers on this channel
            let hs = channelSubs.get(name);
            if (!hs) { hs = new Set(); channelSubs.set(name, hs); }
            handlers.bcast.forEach(h => hs.add(h));
            const raw = JSON.stringify({ op: 'sub', channel: name });
            resubs.push(raw);
            wsSend({ op: 'sub', channel: name });
          }
          for (const h of handlers.pg) {
            tableSubHandlers.push(h);
            const msg = { op: 'subtable', table: h.table, filters: h.filters };
            resubs.push(JSON.stringify(msg));
            wsSend(msg);
          }
          cb && setTimeout(() => cb('SUBSCRIBED'), 0);
          return ch;
        },
        async send({ event, payload }) {
          wsSend({ op: 'bcast', channel: name, event, payload });
          return 'ok';
        },
        unsubscribe() {
          subscribed = false;
          wsSend({ op: 'unsub', channel: name });
          const hs = channelSubs.get(name);
          if (hs) handlers.bcast.forEach(h => hs.delete(h));
          for (const h of handlers.pg) {
            const i = tableSubHandlers.indexOf(h);
            if (i >= 0) tableSubHandlers.splice(i, 1);
          }
          return Promise.resolve('ok');
        },
      };
      return ch;
    }

    // ---------- auth stub (single local identity, everything succeeds) ----------
    const auth = {
      async getSession() { const user = localUser(); return { data: { session: { user, access_token: 'local' } }, error: null }; },
      async getUser() { return { data: { user: localUser() }, error: null }; },
      async signInAnonymously() { const user = localUser(); return { data: { user, session: { user } }, error: null }; },
      async signUp({ email }) { const u = localUser(); u.email = email || u.email; u.is_anonymous = false; store.set('byob_local_user', JSON.stringify(u)); return { data: { user: u, session: { user: u } }, error: null }; },
      async signInWithPassword({ email }) { const u = localUser(); u.email = email || u.email; u.is_anonymous = false; store.set('byob_local_user', JSON.stringify(u)); return { data: { user: u, session: { user: u } }, error: null }; },
      async signOut() { store.del('byob_local_user'); return { error: null }; },
      async updateUser(attrs) {
        const u = localUser();
        if (attrs && attrs.data) u.user_metadata = { ...u.user_metadata, ...attrs.data };
        if (attrs && attrs.email) u.email = attrs.email;
        store.set('byob_local_user', JSON.stringify(u));
        return { data: { user: u }, error: null };
      },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    };

    // ---------- storage ----------
    function storageBucket(bucket) {
      return {
        async upload(path, file, opts) {
          try {
            await ready;
            const r = await fetch(`${httpUrl}/storage/${bucket}/${path}`, {
              method: 'POST', body: file,
              headers: { 'Content-Type': (file && file.type) || 'application/octet-stream' },
            });
            if (!r.ok) return { data: null, error: { message: `upload failed: ${r.status}` } };
            return { data: { path: `${bucket}/${path}` }, error: null };
          } catch (e) { return { data: null, error: { message: e.message } }; }
        },
        // Absolute current-origin URL is intentional: pages aren't served from
        // the relay, so relative /storage/ paths would resolve wrong. Stale
        // hosts in stored rows are healed at read time by normalizeUrls().
        getPublicUrl(path) { return { data: { publicUrl: `${httpUrl}/storage/${bucket}/${path}` } }; },
        async remove(paths) {
          await ready;
          for (const p of [].concat(paths)) { try { await fetch(`${httpUrl}/storage/${bucket}/${p}`, { method: 'DELETE' }); } catch (e) {} }
          return { data: [], error: null };
        },
        async list() { return { data: [], error: null }; },
      };
    }

    return {
      from: builder,
      rpc(fn, args) {
        const p = { single: () => request({ op: 'rpc', fn, args }).then(r => ({ data: r.data, error: r.error || null })) };
        p.then = (res, rej) => request({ op: 'rpc', fn, args }).then(r => ({ data: r.data, error: r.error || null })).then(res, rej);
        return p;
      },
      channel: makeChannel,
      removeChannel(ch) { return ch && ch.unsubscribe(); },
      auth,
      storage: { from: storageBucket },
      _byob: { get httpUrl() { return httpUrl; }, get wsUrl() { return wsUrl; }, ready },
    };
  }

  const api = { createClient };
  if (IS_BROWSER) window.supabase = api;
  if (typeof globalThis !== 'undefined') globalThis.supabase = api;
})();
