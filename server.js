const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app        = express();
const PORT       = process.env.PORT || 3000;
const DATA_DIR   = path.join(__dirname, 'data');
const IMG_DIR    = path.join(DATA_DIR, 'images');
const PUBLIC_DIR = path.join(__dirname, 'public');

[DATA_DIR, IMG_DIR, PUBLIC_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.use(express.json({ limit: '20mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(IMG_DIR));

// ── SSE bağlantı havuzu: { userId: [res, res, ...] } ──────
const sseClients = {};

function sseNotify(userId, event, data) {
  (sseClients[userId] || []).forEach(res => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

// ── Dosya yardımcıları ─────────────────────────────────────
const dataFile       = n  => path.join(DATA_DIR, n);
function readJSON(n, fb)  { try { return JSON.parse(fs.readFileSync(dataFile(n),'utf8')); } catch { return fb; } }
function writeJSON(n, d)  { fs.writeFileSync(dataFile(n), JSON.stringify(d,null,2),'utf8'); }
function msgFile(a, b)    { const [x,y]=[a,b].sort(); return `msgs_${x}_${y}.json`; }

// registered.json: { "1234": "password20chars", ... }
const getReg   = ()       => readJSON('registered.json', {});
const saveReg  = obj      => writeJSON('registered.json', obj);
const getChats = id       => readJSON(`chats_${id}.json`, []);
const saveChats= (id,l)   => writeJSON(`chats_${id}.json`, l);
const getMsgs  = (a,b)    => readJSON(msgFile(a,b), []);
const saveMsgs = (a,b,m)  => writeJSON(msgFile(a,b), m);

function msgHash(msgs) {
  const last = msgs[msgs.length-1];
  return `${msgs.length}_${msgs.filter(m=>m.read).length}_${last?.ts||0}`;
}

// ── Kayıt ──────────────────────────────────────────────────
// Yeni kayıt: şifre oluştur
app.post('/api/register', (req, res) => {
  const { id } = req.body;
  if (!id || !/^\d{4}$/.test(id))
    return res.status(400).json({ error: 'Geçersiz numara' });
  const reg = getReg();
  if (reg[id])
    return res.status(409).json({ error: `${id} numarası zaten kullanımda` });
  const password = crypto.randomBytes(15).toString('base64url').slice(0,20);
  reg[id] = password;
  saveReg(reg);
  res.json({ ok: true, password });
});

// Mevcut kullanıcı doğrulama (sayfa yenilemede)
app.post('/api/verify', (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) return res.status(400).json({ error: 'Eksik parametre' });
  const reg = getReg();
  if (reg[id] !== password)
    return res.status(401).json({ error: 'Geçersiz kimlik bilgileri' });
  res.json({ ok: true });
});

// Çıkış
app.delete('/api/register/:id', (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  const reg = getReg();
  if (reg[id] && reg[id] !== password)
    return res.status(401).json({ error: 'Yetkisiz' });
  delete reg[id];
  saveReg(reg);
  res.json({ ok: true });
});

// ── SSE ────────────────────────────────────────────────────
app.get('/api/events/:id', (req, res) => {
  const { id } = req.params;
  const { password } = req.query;
  const reg = getReg();
  if (reg[id] !== password) {
    res.status(401).end();
    return;
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Heartbeat (bağlantı canlı tutsun)
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 20000);

  if (!sseClients[id]) sseClients[id] = [];
  sseClients[id].push(res);

  req.on('close', () => {
    clearInterval(hb);
    sseClients[id] = (sseClients[id] || []).filter(r => r !== res);
  });
});

// ── Sohbet listesi ─────────────────────────────────────────
app.get('/api/chats/:id', (req, res) => res.json(getChats(req.params.id)));

app.post('/api/chats/:id', (req, res) => {
  const { id } = req.params;
  const { otherId } = req.body;
  if (!otherId) return res.status(400).json({ error: 'otherId gerekli' });
  const list = getChats(id);
  if (!list.includes(otherId)) { list.unshift(otherId); saveChats(id, list); }
  res.json({ ok: true });
});

app.delete('/api/chats/:id/:otherId', (req, res) => {
  const { id, otherId } = req.params;
  saveChats(id, getChats(id).filter(x => x !== otherId));
  res.json({ ok: true });
});

// ── Mesajlar ───────────────────────────────────────────────
app.get('/api/messages/:a/:b', (req, res) => {
  const msgs = getMsgs(req.params.a, req.params.b);
  res.json({ msgs, hash: msgHash(msgs) });
});

app.post('/api/messages/:a/:b', (req, res) => {
  const { a, b } = req.params;
  const { from, text, type, imageUrl } = req.body;
  if (!from) return res.status(400).json({ error: 'from gerekli' });

  const msgs = getMsgs(a, b);
  const msg  = { from, ts: Date.now(), read: false,
    ...(type==='image' ? { type:'image', imageUrl } : { type:'text', text:(text||'').trim() })
  };
  msgs.push(msg);
  saveMsgs(a, b, msgs);

  // Alıcının listesine ekle
  const receiver = from===a ? b : a;
  const rcvList  = getChats(receiver);
  if (!rcvList.includes(from)) { rcvList.unshift(from); saveChats(receiver, rcvList); }

  // SSE ile her iki tarafa bildir
  const payload = { msgs, hash: msgHash(msgs) };
  sseNotify(a, 'messages', payload);
  sseNotify(b, 'messages', payload);
  // Chat listesi güncellemesi de gönder
  sseNotify(receiver, 'chats', { updated: from });

  res.json(msg);
});

app.patch('/api/messages/:a/:b/read', (req, res) => {
  const { a, b } = req.params;
  const { reader } = req.body;
  const msgs = getMsgs(a, b);
  let changed = false;
  msgs.forEach(m => { if (m.from!==reader && !m.read) { m.read=true; changed=true; } });
  if (changed) {
    saveMsgs(a, b, msgs);
    const payload = { msgs, hash: msgHash(msgs) };
    sseNotify(a, 'messages', payload);
    sseNotify(b, 'messages', payload);
  }
  res.json({ ok: true });
});

app.delete('/api/messages/:a/:b', (req, res) => {
  saveMsgs(req.params.a, req.params.b, []);
  const payload = { msgs: [], hash: '0_0_0' };
  sseNotify(req.params.a, 'messages', payload);
  sseNotify(req.params.b, 'messages', payload);
  res.json({ ok: true });
});

// ── Görsel Yükleme ─────────────────────────────────────────
app.post('/api/upload', (req, res) => {
  const { data, mime } = req.body;
  if (!data || !mime) return res.status(400).json({ error: 'data ve mime gerekli' });
  const ext  = (mime.split('/')[1]||'jpg').replace('jpeg','jpg');
  const name = crypto.randomBytes(12).toString('hex')+'.'+ext;
  fs.writeFileSync(path.join(IMG_DIR, name), Buffer.from(data,'base64'));
  res.json({ url: `/uploads/${name}` });
});

app.listen(PORT, () => {
  console.log(`\n🐥  ChickChat → http://localhost:${PORT}`);
  console.log(`    Veriler: ${DATA_DIR}\n`);
});
