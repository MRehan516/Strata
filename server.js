/* Backend for the versioned ledger app.
   REST API under /api, live updates via SSE, SQLite (JSON fallback),
   workspace-level password auth (scrypt hashes + HMAC session tokens). */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const KINDS = ['spec', 'decision', 'prototype', 'release'];
const VERDICTS = ['approved', 'rejected'];
const KEY_TTL_MS = 30 * 864e5; // 30 days

/* ---------- server secret (persisted so tokens survive restarts) ---------- */
const SECRET_FILE = path.join(DATA_DIR, '.secret');
let SECRET;
try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); }
catch { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, SECRET); }

/* ---------- password hashing (scrypt, per-workspace random salt) ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const makePw = pw => {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + hashPw(pw, salt);
};
const checkPw = (pw, stored) => {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(hashPw(pw, salt), 'hex'), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/* ---------- session tokens: HMAC-signed "wsid.expiry.sig" ---------- */
const signKey = (ws, exp) => {
  const payload = `${ws}.${exp}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 32);
  return `${payload}.${sig}`;
};
const verifyKey = (ws, key) => {
  if (!key) return false;
  const [w, exp, sig] = String(key).split('.');
  if (w !== ws || !exp || !sig || Date.now() > Number(exp)) return false;
  const expect = crypto.createHmac('sha256', SECRET).update(`${w}.${exp}`).digest('hex').slice(0, 32);
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch { return false; }
};
const keyOf = req => req.get('x-lamina-key') || req.query.key || '';
const authorized = (req, ws) => !ws.pass_hash || verifyKey(ws.id, keyOf(req));
const LOCKED = { error: 'workspace is locked — enter its password', locked: true };

/* ---------- storage layer: SQLite, with automatic JSON fallback ---------- */
let db;
try {
  const { default: Database } = await import('better-sqlite3');
  const conn = new Database(path.join(DATA_DIR, 'strata.db'));
  conn.pragma('journal_mode = WAL');
  conn.exec(`
    CREATE TABLE IF NOT EXISTS workspaces(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS layers(
      ws_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, summary TEXT DEFAULT '', author TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', note TEXT DEFAULT '',
      reviewed_by TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (ws_id, id));
    CREATE TABLE IF NOT EXISTS activity(
      ws_id TEXT NOT NULL, ts INTEGER NOT NULL, actor TEXT NOT NULL,
      action TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_layers_ws ON layers(ws_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_ws ON activity(ws_id, ts);
  `);
  try { conn.exec('ALTER TABLE workspaces ADD COLUMN pass_hash TEXT'); } catch {}
  db = {
    mode: 'sqlite',
    createWorkspace: ws => conn.prepare('INSERT INTO workspaces(id,name,created_at,pass_hash) VALUES (?,?,?,?)')
      .run(ws.id, ws.name, ws.created_at, ws.pass_hash || null),
    getWorkspace: id => conn.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) || null,
    listLayers: ws => conn.prepare('SELECT * FROM layers WHERE ws_id = ? ORDER BY created_at ASC, id ASC').all(ws),
    insertLayer: l => conn.prepare('INSERT INTO layers(ws_id,id,kind,title,summary,author,status,note,reviewed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(l.ws_id, l.id, l.kind, l.title, l.summary, l.author, l.status, l.note, l.reviewed_by, l.created_at),
    setLayerStatus: (ws, id, status, note, reviewer) =>
      conn.prepare('UPDATE layers SET status=?, note=?, reviewed_by=? WHERE ws_id=? AND id=?').run(status, note, reviewer, ws, id),
    addActivity: a => conn.prepare('INSERT INTO activity(ws_id,ts,actor,action,detail) VALUES (?,?,?,?,?)').run(a.ws_id, a.ts, a.actor, a.action, a.detail),
    listActivity: (ws, limit) => conn.prepare('SELECT ts,actor,action,detail FROM activity WHERE ws_id=? ORDER BY ts DESC LIMIT ?').all(ws, limit)
  };
  console.log('[db] SQLite online →', path.join(DATA_DIR, 'strata.db'));
} catch (err) {
  console.warn('[db] better-sqlite3 unavailable — falling back to JSON file store.', err.message);
  const file = path.join(DATA_DIR, 'strata.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = { workspaces: {} }; }
  const save = () => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(data)); fs.renameSync(t, file); };
  db = {
    mode: 'json',
    createWorkspace: ws => { data.workspaces[ws.id] = { id: ws.id, name: ws.name, created_at: ws.created_at, pass_hash: ws.pass_hash || null, layers: [], activity: [] }; save(); },
    getWorkspace: id => data.workspaces[id] || null,
    listLayers: ws => data.workspaces[ws]?.layers ?? [],
    insertLayer: l => { data.workspaces[l.ws_id].layers.push({ ...l, reviewed_by: l.reviewed_by }); save(); },
    setLayerStatus: (ws, id, status, note, reviewer) => {
      const l = data.workspaces[ws]?.layers.find(x => x.id === id);
      if (l) { l.status = status; l.note = note; l.reviewed_by = reviewer; save(); }
    },
    addActivity: a => { const w = data.workspaces[a.ws_id]; w.activity.unshift({ ts: a.ts, actor: a.actor, action: a.action, detail: a.detail }); w.activity = w.activity.slice(0, 200); save(); },
    listActivity: (ws, limit) => (data.workspaces[ws]?.activity ?? []).slice(0, limit)
  };
}

const shape = l => ({
  id: l.id, kind: l.kind, title: l.title, summary: l.summary || '',
  author: l.author, status: l.status, note: l.note || '',
  reviewedBy: l.reviewed_by || l.reviewedBy || null, createdAt: l.created_at
});
const genId = () => {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < 6; i++) s += A[crypto.randomInt(A.length)];
  return s;
};

/* ---------- live connections (SSE) ---------- */
const clients = new Map();
function broadcast(wsId, event, payload) {
  const set = clients.get(wsId); if (!set) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) { try { res.write(msg); } catch {} }
}

/* ---------- seed demo workspace (open — judges test without login) ---------- */
if (!db.getWorkspace('DEMO01')) {
  const t = Date.now(), D = 864e5, H = 36e5;
  db.createWorkspace({ id: 'DEMO01', name: 'Demo — Checkout Revamp', created_at: t, pass_hash: null });
  [
    { id:'L-1', kind:'spec',      title:'Checkout spec v1',              summary:'Baseline three-step checkout flow.',                at:t-9*D },
    { id:'L-2', kind:'spec',      title:'Checkout spec v2 — guest flow', summary:'Adds guest checkout; removes forced account step.', at:t-7*D },
    { id:'L-3', kind:'decision',  title:'Adopt address autocomplete',    summary:'Autocomplete from step 2 to cut abandonment.',      at:t-6*D, status:'approved', note:'Ship with v2.', by:'Mara' },
    { id:'L-4', kind:'prototype', title:'Prototype — one-page checkout', summary:'Single-page variant for usability test round 2.',   at:t-4*D },
    { id:'L-5', kind:'decision',  title:'Drop coupon field from step 1', summary:'Move coupons to payment step; declutter entry.',    at:t-3*D, status:'rejected', note:'Revisit after A/B.', by:'Sam' },
    { id:'L-6', kind:'prototype', title:'Prototype — payment-first layout', summary:'Payment-first ordering per test findings.',       at:t-1*D },
    { id:'L-7', kind:'release',   title:'Release 0.1 — internal dogfood', summary:'First internal build; support team only.',         at:t-2*H }
  ].forEach(r => db.insertLayer({
    ws_id:'DEMO01', id:r.id, kind:r.kind, title:r.title, summary:r.summary,
    author:'You', status:r.status || 'open', note:r.note || '',
    reviewed_by:r.by || null, created_at:r.at
  }));
  db.addActivity({ ws_id:'DEMO01', ts:t-6*D, actor:'human', action:'layer.signed', detail:'L-3 → approved by Mara' });
  db.addActivity({ ws_id:'DEMO01', ts:t-9*D, actor:'human', action:'layer.added',  detail:'L-1 · Checkout spec v1' });
  console.log('[seed] demo workspace DEMO01 ready');
}

/* ---------- app ---------- */
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, db: db.mode, time: Date.now() }));

app.post('/api/workspaces', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const password = String(req.body?.password || '');
  if (name.length < 3) return res.status(400).json({ error: 'name must be at least 3 characters' });
  if (password && password.length < 4) return res.status(400).json({ error: 'password must be at least 4 characters (or leave it empty)' });
  let id = genId(); while (db.getWorkspace(id)) id = genId();
  db.createWorkspace({ id, name, created_at: Date.now(), pass_hash: password ? makePw(password) : null });
  res.json({ id, name, locked: !!password });
});

/* unlock: verify password, return a signed key (null for open workspaces) */
app.post('/api/workspaces/:id/unlock', (req, res) => {
  const id = String(req.params.id).toUpperCase();
  const ws = db.getWorkspace(id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  if (!ws.pass_hash) return res.json({ ok: true, key: null });
  if (!checkPw(String(req.body?.password || ''), ws.pass_hash))
    return res.status(401).json({ error: 'wrong password' });
  res.json({ ok: true, key: signKey(ws.id, Date.now() + KEY_TTL_MS) });
});

app.get('/api/workspaces/:id', (req, res) => {
  const id = String(req.params.id).toUpperCase();
  const ws = db.getWorkspace(id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  if (!authorized(req, ws)) return res.status(401).json(LOCKED);
  res.json({ id: ws.id, name: ws.name, createdAt: ws.created_at, locked: !!ws.pass_hash,
    layers: db.listLayers(id).map(shape), activity: db.listActivity(id, 40) });
});

app.post('/api/workspaces/:id/layers', (req, res) => {
  const id = String(req.params.id).toUpperCase();
  const ws = db.getWorkspace(id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  if (!authorized(req, ws)) return res.status(401).json(LOCKED);
  const title = String(req.body?.title || '').trim().slice(0, 140);
  const kind = String(req.body?.kind || '');
  const summary = String(req.body?.summary || '').trim().slice(0, 300);
  const actor = req.body?.actor === 'agent' ? 'agent' : 'human';
  if (title.length < 3) return res.status(400).json({ error: 'title must be at least 3 characters' });
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${KINDS.join(', ')}` });
  const layer = {
    ws_id: id, id: 'L-' + (db.listLayers(id).length + 1), kind, title, summary,
    author: actor === 'agent' ? 'Agent (WebMCP)' : 'You',
    status: 'open', note: '', reviewed_by: null, created_at: Date.now()
  };
  db.insertLayer(layer);
  db.addActivity({ ws_id: id, ts: Date.now(), actor, action: 'layer.added', detail: `${layer.id} · ${title}` });
  broadcast(id, 'layer.added', shape(layer));
  res.json(shape(layer));
});

app.post('/api/workspaces/:id/signoffs', (req, res) => {
  const id = String(req.params.id).toUpperCase();
  const ws = db.getWorkspace(id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  if (!authorized(req, ws)) return res.status(401).json(LOCKED);
  const target = String(req.body?.id || '').trim();
  const reviewer = String(req.body?.reviewer || '').trim().slice(0, 60);
  const verdict = String(req.body?.verdict || '');
  const note = String(req.body?.note || '').trim().slice(0, 200);
  const actor = req.body?.actor === 'agent' ? 'agent' : 'human';
  const layer = db.listLayers(id).find(l => l.id.toLowerCase() === target.toLowerCase());
  if (!layer) return res.status(404).json({ error: `no layer found for "${target}"` });
  if (!reviewer) return res.status(400).json({ error: 'reviewer name is required — sign-offs are attributed to a human' });
  if (!VERDICTS.includes(verdict)) return res.status(400).json({ error: 'verdict must be approved or rejected' });
  db.setLayerStatus(id, layer.id, verdict, note, reviewer);
  db.addActivity({ ws_id: id, ts: Date.now(), actor, action: 'layer.signed', detail: `${layer.id} → ${verdict} by ${reviewer}` });
  broadcast(id, 'layer.signed', { id: layer.id, status: verdict, reviewer, note, actor });
  res.json({ id: layer.id, status: verdict, reviewer, note });
});

app.get('/api/workspaces/:id/export.json', (req, res) => {
  const id = String(req.params.id).toUpperCase();
  const ws = db.getWorkspace(id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  if (!authorized(req, ws)) return res.status(401).json(LOCKED);
  res.set('Content-Disposition', `attachment; filename="${id}-ledger.json"`);
  res.json({ exportedAt: new Date().toISOString(), workspace: { id: ws.id, name: ws.name },
    layers: db.listLayers(id).map(shape), activity: db.listActivity(id, 200) });
});

app.get('/api/workspaces/:id/export.csv', (req, res) => {
  const id = String(req.params.id).toUpperCase();
  const ws = db.getWorkspace(id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  if (!authorized(req, ws)) return res.status(401).json(LOCKED);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['id','kind','title','status','author','reviewedBy','createdAt','summary'].join(',')];
  for (const l of db.listLayers(id).map(shape)) {
    rows.push([l.id, l.kind, l.title, l.status, l.author, l.reviewedBy || '',
      new Date(l.createdAt).toISOString(), l.summary].map(esc).join(','));
  }
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="${id}-layers.csv"`);
  res.send(rows.join('\n'));
});

app.get('/api/workspaces/:id/stream', (req, res) => {
  const id = String(req.params.id).toUpperCase();
  const ws = db.getWorkspace(id);
  if (!ws) return res.status(404).end();
  if (!authorized(req, ws)) return res.status(401).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write(`event: hello\ndata: {"ok":true}\n\n`);
  let set = clients.get(id); if (!set) { set = new Set(); clients.set(id, set); }
  set.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); set.delete(res); if (!set.size) clients.delete(id); });
});

app.get('/w/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use('/api', (req, res) => res.status(404).json({ error: 'unknown API route' }));

app.listen(PORT, () => console.log(`[app] running → http://localhost:${PORT}`));
