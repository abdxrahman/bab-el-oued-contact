#!/usr/bin/env node
// Bab El Oued Contact game server. No packages needed, only Node.js 18 or newer.
//   LAN:    node server.js            then friends on the same Wi-Fi open the address it prints
//   Online: deploy this folder to a host that runs Node (Render, Railway, Fly, a VPS), or run it
//           at home and open it to the internet with a tunnel (see README.txt)
// It serves the game, relays match traffic between players in the same lobby, and remembers
// the latest state of each player so newcomers see everyone straight away.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const MAX_PER_LOBBY = +process.env.MAX_PLAYERS || 12;
const MAX_LOBBIES = 200, MAX_MSG = 64 * 1024, MAX_MSGS_PER_SEC = 90;
const ROOT = __dirname, GAME = path.join(ROOT, 'index.html'), VENDOR = path.join(ROOT, 'vendor');

// ---------- the game page ----------
let page = '';
try { page = fs.readFileSync(GAME, 'utf8'); } catch (e) { console.error('index.html is missing next to server.js'); process.exit(1); }
const CDN = [...new Set([...page.matchAll(/<script src="(https:\/\/[^"]+)"/g)].map(m => m[1]))];
const vendorName = u => u.replace(/^https:\/\//, '').replace(/[^a-zA-Z0-9._-]+/g, '_');
// keep a local copy of three.js and its helpers, so the game still loads on a LAN with no internet
async function cacheVendor() {
  try { fs.mkdirSync(VENDOR, { recursive: true }); } catch (e) {}
  for (const u of CDN) {
    const f = path.join(VENDOR, vendorName(u));
    if (fs.existsSync(f) && fs.statSync(f).size > 1000) continue;
    try { const r = await fetch(u); if (!r.ok) throw new Error(r.status); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); console.log('  saved a local copy of', u.split('/').pop()); }
    catch (e) { console.log('  could not save', u.split('/').pop(), '(players will load it from the internet)'); }
  }
}
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out.sort((a, b) => (/^192\.168\./.test(b) - /^192\.168\./.test(a)) || (/^10\./.test(b) - /^10\./.test(a)));
}
const isLocalHost = h => /^(localhost|127\.|\[?::1)/.test(h || '');
function publicBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  if (isLocalHost(host)) { const ip = lanIPs()[0]; if (ip) return 'http://' + ip + ':' + PORT; }
  return proto + '://' + host;
}
function gamePage(req) {
  let s = page;
  for (const u of CDN) { const f = path.join(VENDOR, vendorName(u)); if (fs.existsSync(f)) s = s.split(u).join('/vendor/' + vendorName(u)); }
  const flags = '<script>window.BEO_LAN=1;window.BEO_PUBLIC=' + JSON.stringify(publicBase(req)) + ';</script>';
  const i = s.indexOf('<script');
  return i < 0 ? flags + s : s.slice(0, i) + flags + s.slice(i);
}
const TYPES = { '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.js': 'text/javascript', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
function serveFile(res, dir, rel) {
  const f = path.normalize(path.join(dir, rel));
  if (!f.startsWith(dir + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(f).pipe(res);
  });
}

// ---------- lobbies ----------
const lobbies = new Map(); // code -> Map(id -> player)
let nextId = 1;
const cleanCode = c => { c = String(c || '').toLowerCase(); return /^beo-[a-z0-9]{6}$/.test(c) ? c : 'beo-public'; };
const cleanName = t => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f-\u009f<>&"]/g, '').trim().slice(0, 16) || 'Soldier';
const TIMES = [0, 300, 600, 900, 1200, 1800], KILLS = [0, 10, 20, 30, 50, 100], BREAK_MS = 12000;
const cleanCfg = c => ({ time: c && TIMES.includes(+c.time) ? +c.time : 600, kills: c && KILLS.includes(+c.kills) ? +c.kills : 30 });
const cleanChat = t => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 120);
function newRound(lb, quiet) {
  lb.over = false; lb.endAt = lb.cfg.time ? Date.now() + lb.cfg.time * 1000 : 0; lb.round = (lb.round || 0) + 1;
  for (const p of lb.values()) { p.kills = 0; p.deaths = 0; }
  if (!quiet) broadcast(lb, { t: 'round', cfg: lb.cfg, left: lb.cfg.time, r: lb.round });
}
function rows(lb) { return [...lb.values()].map(p => ({ id: p.id, name: p.name, k: p.kills, d: p.deaths })).sort((a, b) => b.k - a.k || a.d - b.d); }
function endRound(lb) {
  if (lb.over) return; lb.over = true; lb.nextAt = Date.now() + BREAK_MS;
  const r = rows(lb); broadcast(lb, { t: 'end', w: r[0] ? r[0].name : '', wid: r[0] ? r[0].id : 0, rows: r, n: BREAK_MS / 1000 });
  console.log(`  round over in ${lb.code}${r[0] ? ', ' + r[0].name + ' wins' : ''}`);
}
function checkKills(lb) { if (!lb.over && lb.cfg.kills) for (const p of lb.values()) if (p.kills >= lb.cfg.kills) return endRound(lb); }
setInterval(() => { const t = Date.now(); for (const lb of lobbies.values()) { if (lb.over) { if (t >= lb.nextAt) newRound(lb); } else if (lb.endAt && t >= lb.endAt) endRound(lb); } }, 500);
function broadcast(lobby, msg, except) { const s = JSON.stringify(msg); for (const p of lobby.values()) if (p !== except) p.send(s); }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    const body = gamePage(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(body);
  }
  if (u.pathname === '/lobby') {
    const lb = lobbies.get(cleanCode(u.searchParams.get('c')));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ players: lb ? [...lb.values()].map(p => ({ n: p.name })) : [] }));
  }
  if (u.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (u.pathname.startsWith('/assets/')) return serveFile(res, path.join(ROOT, 'assets'), decodeURIComponent(u.pathname.slice(8)));
  if (u.pathname.startsWith('/vendor/')) return serveFile(res, VENDOR, decodeURIComponent(u.pathname.slice(8)));
  res.writeHead(404); res.end('not found');
});

// ---------- a small WebSocket implementation (RFC 6455, text frames) ----------
server.on('upgrade', (req, sock) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws' || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key']; if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const p = { id: 0, name: 'Soldier', lobby: null, code: '', kills: 0, deaths: 0, state: null, alive: true, rate: 0, rateT: Date.now(), pong: Date.now() };
  let buf = Buffer.alloc(0), frag = [];
  p.send = s => { if (sock.destroyed) return; const d = Buffer.from(s); let h; if (d.length < 126) h = Buffer.from([0x81, d.length]); else if (d.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(d.length, 2); } else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(d.length), 2); } sock.write(Buffer.concat([h, d])); };
  const ctrl = (op, d) => { if (!sock.destroyed) sock.write(Buffer.concat([Buffer.from([0x80 | op, d.length]), d])); };
  const close = () => { if (p.closed) return; p.closed = true; leave(p); try { ctrl(8, Buffer.alloc(0)); } catch (e) {} sock.end(); setTimeout(() => sock.destroy(), 500); };
  p.close = close;
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_MSG * 2) return close();
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX_MSG)) return close(); len = Number(big); off = 10; }
      if (!masked || len > MAX_MSG) return close();
      if (buf.length < off + 4 + len) return;
      const mask = buf.slice(off, off + 4), data = Buffer.from(buf.slice(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.slice(off + 4 + len);
      if (op === 8) return close();
      if (op === 9) { ctrl(10, data); continue; }
      if (op === 10) { p.pong = Date.now(); continue; }
      if (op === 1 || op === 0) { frag.push(data); if (!fin) continue; const txt = Buffer.concat(frag).toString('utf8'); frag = []; onMessage(p, txt); }
    }
  });
  sock.on('close', () => { p.closed = true; leave(p); });
  sock.on('error', () => { p.closed = true; leave(p); });
  p.ping = () => ctrl(9, Buffer.alloc(0));
  p.sock = sock;
});

function onMessage(p, txt) {
  const t = Date.now(); if (t - p.rateT > 1000) { p.rateT = t; p.rate = 0; } if (++p.rate > MAX_MSGS_PER_SEC) return;
  let m; try { m = JSON.parse(txt); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello') {
    if (p.lobby) return;
    const code = cleanCode(m.lobby);
    let lb = lobbies.get(code);
    if (!lb) { if (lobbies.size >= MAX_LOBBIES) { p.send(JSON.stringify({ t: 'full' })); return p.close(); } lb = new Map(); lb.code = code; lb.cfg = cleanCfg(m.cfg); newRound(lb, true); lobbies.set(code, lb); }
    else if (m.host && m.cfg && !lb.hasHost) { lb.cfg = cleanCfg(m.cfg); newRound(lb); }
    if (m.host) lb.hasHost = true;
    if (lb.size >= MAX_PER_LOBBY) { p.send(JSON.stringify({ t: 'full' })); return p.close(); }
    p.id = nextId++; p.name = cleanName(m.name); p.lobby = lb; p.code = code; p.host = !!m.host;
    p.send(JSON.stringify({ t: 'welcome', id: p.id, players: [...lb.values()].map(o => ({ id: o.id, name: o.name, kills: o.kills, deaths: o.deaths, state: o.state })), cfg: lb.cfg, left: lb.endAt ? Math.max(0, (lb.endAt - Date.now()) / 1000) : 0, over: lb.over ? { w: rows(lb)[0] ? rows(lb)[0].name : '', rows: rows(lb), n: Math.max(1, Math.round((lb.nextAt - Date.now()) / 1000)) } : null }));
    lb.set(p.id, p);
    broadcast(lb, { t: 'join', id: p.id, name: p.name }, p);
    console.log(`  ${p.name} joined ${code} (${lb.size} playing)`);
    return;
  }
  const lb = p.lobby; if (!lb) return;
  m.id = p.id;
  if (m.t === 's') { p.state = m; broadcast(lb, m, p); }
  else if (m.t === 'shot') broadcast(lb, m, p);
  else if (m.t === 'hit') { const to = lb.get(m.to); if (to && to !== p) to.send(JSON.stringify(m)); }
  else if (m.t === 'died') { if (lb.over) return; p.deaths++; const k = lb.get(m.by); if (k && k !== p) k.kills++; broadcast(lb, m, p); checkKills(lb); }
  else if (m.t === 'nade') { if (!Array.isArray(m.p) || !Array.isArray(m.v)) return; broadcast(lb, { t: 'nade', id: p.id, k: m.k === 'smoke' ? 'smoke' : 'frag', p: m.p.slice(0, 3).map(Number), v: m.v.slice(0, 3).map(Number) }, p); }
  else if (m.t === 'proj') { if (!Array.isArray(m.p) || !Array.isArray(m.v)) return; broadcast(lb, { t: 'proj', id: p.id, k: m.k === 'rkt' ? 'rkt' : 'g40', i: String(m.i || '').slice(0, 40), w: String(m.w || '').slice(0, 12), p: m.p.slice(0, 3).map(Number), v: m.v.slice(0, 3).map(Number) }, p); }
  else if (m.t === 'boom') { if (!Array.isArray(m.p)) return; broadcast(lb, { t: 'boom', id: p.id, i: String(m.i || '').slice(0, 40), w: String(m.w || '').slice(0, 12), p: m.p.slice(0, 3).map(Number) }, p); }
  else if (m.t === 'chat') { const x = cleanChat(m.x); if (!x) return; const t2 = Date.now(); if (t2 - (p.chatT || 0) < 400) return; p.chatT = t2; broadcast(lb, { t: 'chat', id: p.id, x }, p); }
  else if (m.t === 'cfg') { if (!p.host) return; lb.cfg = cleanCfg(m.cfg); newRound(lb); }
}
function leave(p) {
  const lb = p.lobby; if (!lb) return; p.lobby = null;
  if (lb.get(p.id) === p) { lb.delete(p.id); if (p.host) lb.hasHost = false; broadcast(lb, { t: 'leave', id: p.id }); console.log(`  ${p.name} left ${p.code} (${lb.size} playing)`); }
  if (!lb.size) lobbies.delete(p.code);
}
// drop players whose connection silently died
setInterval(() => { const t = Date.now(); for (const lb of lobbies.values()) for (const p of lb.values()) { if (t - p.pong > 45000) { p.close(); continue; } try { p.ping(); } catch (e) {} } }, 15000);

server.listen(PORT, '0.0.0.0', async () => {
  console.log('\n  Bab El Oued Contact server is running.\n');
  console.log('  On this computer:        http://localhost:' + PORT);
  for (const ip of lanIPs()) console.log('  Friends on your network: http://' + ip + ':' + PORT);
  if (PUBLIC_URL) console.log('  Public address:          ' + PUBLIC_URL);
  console.log('\n  In the game: Online, create a lobby, then send the invite link.');
  console.log('  Keep this window open while you play. Close it to stop the server.\n');
  await cacheVendor();
});
server.on('error', e => { if (e.code === 'EADDRINUSE') console.error('\n  Port ' + PORT + ' is already in use. Close the other server, or start with another port, for example: PORT=8081 node server.js\n'); else console.error(e); process.exit(1); });
