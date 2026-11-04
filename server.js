#!/usr/bin/env node
// Bab El Oued Contact game server. No packages needed, only Node.js 18 or newer.
//   LAN:    node server.js            then friends on the same Wi-Fi open the address it prints
//   Online: deploy this folder to a host that runs Node (Render, Railway, Fly, a VPS), or run it
//           at home and open it to the internet with a tunnel (see README.txt)
// It serves the game, relays match traffic between players in the same lobby, and remembers
// the latest state of each player so newcomers see everyone straight away.
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const HTTPS_PORT = +process.env.HTTPS_PORT || PORT + 363; // secure LAN address, browsers only allow the microphone on https
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const MAX_PER_LOBBY = +process.env.MAX_PLAYERS || 12;
const MAX_LOBBIES = 200, MAX_MSG = 64 * 1024, MAX_MSGS_PER_SEC = 120;
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
  if (isLocalHost(host)) { const ip = lanIPs()[0]; if (ip) return req.socket.encrypted ? 'https://' + ip + ':' + HTTPS_PORT : 'http://' + ip + ':' + PORT; }
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
const TIMES = [0, 300, 600, 900, 1200, 1800], KILLS = [0, 10, 20, 30, 50, 75, 100], BREAK_MS = 12000, TEAM_NAMES = ['Blue', 'Red'];
const cleanCfg = c => { const mode = c && c.mode === 'tdm' ? 'tdm' : 'ffa'; return { mode, time: mode === 'tdm' ? 0 : c && TIMES.includes(+c.time) ? +c.time : 600, kills: c && KILLS.includes(+c.kills) ? +c.kills : (mode === 'tdm' ? 50 : 30) }; };
const isTdm = lb => lb.cfg.mode === 'tdm';
// put a player on the smaller team (the team that is behind when they are level)
function pickTeam(lb, except) {
  const n = [0, 0]; for (const o of lb.values()) if (o !== except && (o.team === 0 || o.team === 1)) n[o.team]++;
  if (n[0] !== n[1]) return n[0] < n[1] ? 0 : 1;
  const tk = lb.teamKills || [0, 0]; return tk[0] === tk[1] ? Math.round(Math.random()) : tk[0] < tk[1] ? 0 : 1;
}
function teamMap(lb) { const o = {}; for (const p of lb.values()) o[p.id] = p.team; return o; }
const cleanChat = t => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 120);
function newRound(lb, quiet) {
  lb.over = false; lb.endAt = lb.cfg.time ? Date.now() + lb.cfg.time * 1000 : 0; lb.round = (lb.round || 0) + 1; lb.teamKills = [0, 0];
  for (const p of lb.values()) { p.kills = 0; p.deaths = 0; }
  // keep teams even between rounds
  if (isTdm(lb)) { for (const p of lb.values()) p.team = null; for (const p of [...lb.values()].sort(() => Math.random() - .5)) p.team = pickTeam(lb, p); }
  if (!quiet) broadcast(lb, { t: 'round', cfg: lb.cfg, left: lb.cfg.time, r: lb.round, teams: teamMap(lb), tk: lb.teamKills });
}
function rows(lb) { return [...lb.values()].map(p => ({ id: p.id, name: p.name, k: p.kills, d: p.deaths, tm: p.team })).sort((a, b) => b.k - a.k || a.d - b.d); }
function endRound(lb) {
  if (lb.over) return; lb.over = true; lb.nextAt = Date.now() + BREAK_MS;
  const r = rows(lb);
  if (isTdm(lb)) {
    const tk = lb.teamKills, wt = tk[0] === tk[1] ? -1 : tk[0] > tk[1] ? 0 : 1;
    broadcast(lb, { t: 'end', w: wt < 0 ? '' : TEAM_NAMES[wt] + ' team', wt, tk, rows: r, n: BREAK_MS / 1000 });
    console.log(`  round over in ${lb.code}, ${wt < 0 ? 'draw' : TEAM_NAMES[wt] + ' team wins'} ${tk[0]} to ${tk[1]}`);
    return;
  }
  broadcast(lb, { t: 'end', w: r[0] ? r[0].name : '', wid: r[0] ? r[0].id : 0, rows: r, n: BREAK_MS / 1000 });
  console.log(`  round over in ${lb.code}${r[0] ? ', ' + r[0].name + ' wins' : ''}`);
}
function checkKills(lb) {
  if (lb.over || !lb.cfg.kills) return;
  if (isTdm(lb)) { if (lb.teamKills[0] >= lb.cfg.kills || lb.teamKills[1] >= lb.cfg.kills) endRound(lb); return; }
  for (const p of lb.values()) if (p.kills >= lb.cfg.kills) return endRound(lb);
}
setInterval(() => { const t = Date.now(); for (const lb of lobbies.values()) { if (lb.over) { if (t >= lb.nextAt) newRound(lb); } else if (lb.endAt && t >= lb.endAt) endRound(lb); } }, 500);
function broadcast(lobby, msg, except) { const s = JSON.stringify(msg); for (const p of lobby.values()) if (p !== except) p.send(s); }

function handleRequest(req, res) {
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
}
const server = http.createServer(handleRequest);

// ---------- a small WebSocket implementation (RFC 6455, text frames) ----------
function onUpgrade(req, sock) {
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
}
server.on('upgrade', onUpgrade);

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
    p.id = nextId++; p.name = cleanName(m.name); p.lobby = lb; p.code = code; p.host = !!m.host; p.team = pickTeam(lb, p);
    p.send(JSON.stringify({ t: 'welcome', id: p.id, team: p.team, tk: lb.teamKills, players: [...lb.values()].map(o => ({ id: o.id, name: o.name, kills: o.kills, deaths: o.deaths, state: o.state, team: o.team })), cfg: lb.cfg, left: lb.endAt ? Math.max(0, (lb.endAt - Date.now()) / 1000) : 0, over: lb.over ? { w: isTdm(lb) ? (lb.teamKills[0] === lb.teamKills[1] ? '' : TEAM_NAMES[lb.teamKills[0] > lb.teamKills[1] ? 0 : 1] + ' team') : rows(lb)[0] ? rows(lb)[0].name : '', wt: isTdm(lb) ? (lb.teamKills[0] === lb.teamKills[1] ? -1 : lb.teamKills[0] > lb.teamKills[1] ? 0 : 1) : undefined, tk: lb.teamKills, rows: rows(lb), n: Math.max(1, Math.round((lb.nextAt - Date.now()) / 1000)) } : null }));
    lb.set(p.id, p);
    broadcast(lb, { t: 'join', id: p.id, name: p.name, team: p.team }, p);
    console.log(`  ${p.name} joined ${code} (${lb.size} playing)`);
    return;
  }
  const lb = p.lobby; if (!lb) return;
  m.id = p.id;
  if (m.t === 's') { p.state = m; broadcast(lb, m, p); }
  else if (m.t === 'shot') broadcast(lb, m, p);
  else if (m.t === 'hit') { const to = lb.get(m.to); if (to && to !== p) to.send(JSON.stringify(m)); }
  else if (m.t === 'died') {
    if (lb.over) return; p.deaths++; const k = lb.get(m.by);
    // in team deathmatch a team kill scores nothing
    if (k && k !== p && !(isTdm(lb) && k.team === p.team)) { k.kills++; if (isTdm(lb) && (k.team === 0 || k.team === 1)) lb.teamKills[k.team]++; }
    broadcast(lb, m, p); if (isTdm(lb)) broadcast(lb, { t: 'tk', tk: lb.teamKills }); checkKills(lb);
  }
  else if (m.t === 'pg') { p.send(JSON.stringify({ t: 'pg', c: +m.c || 0 })); }
  else if (m.t === 'vc') {
    // voice: 40 ms of speech per message. Team radio goes to teammates only; everything else to the whole lobby, and each player's game makes it quieter with distance
    if (typeof m.d !== 'string' || m.d.length > 1600) return;
    const team = m.c === 't' && isTdm(lb), out = JSON.stringify({ t: 'vc', id: p.id, d: m.d, c: team ? 't' : 'a' });
    for (const o of lb.values()) if (o !== p && (!team || o.team === p.team)) o.send(out);
  }
  else if (m.t === 'nade') { if (!Array.isArray(m.p) || !Array.isArray(m.v)) return; broadcast(lb, { t: 'nade', id: p.id, k: ['smoke', 'molotov', 'flash'].includes(m.k) ? m.k : 'frag', p: m.p.slice(0, 3).map(Number), v: m.v.slice(0, 3).map(Number) }, p); }
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


// ---------- secure LAN address ----------
// Browsers only hand a page the microphone on https (or localhost). On a LAN there is no real certificate, so the
// server makes its own self-signed one (kept in lan-cert.pem) and also listens on HTTPS_PORT. Each player accepts the
// browser's warning once. The online tunnel and cloud hosts are already https and do not need this.
function der(tag, ...parts) {
  const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
  let len; if (body.length < 128) len = Buffer.from([body.length]);
  else { const b = []; let x = body.length; while (x > 0) { b.unshift(x & 255); x = Math.floor(x / 256); } len = Buffer.from([0x80 | b.length, ...b]); }
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const dSeq = (...p) => der(0x30, ...p), dSet = (...p) => der(0x31, ...p);
const dInt = b => der(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const dOid = str => { const a = str.split('.').map(Number), out = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) { const b = [v & 127]; let x = v >>> 7; while (x > 0) { b.unshift((x & 127) | 128); x >>>= 7; } out.push(...b); }
  return der(0x06, Buffer.from(out)); };
const dTime = d => { const z = n => String(n).padStart(2, '0'); return der(0x17, Buffer.from(z(d.getUTCFullYear() % 100) + z(d.getUTCMonth() + 1) + z(d.getUTCDate()) + z(d.getUTCHours()) + z(d.getUTCMinutes()) + z(d.getUTCSeconds()) + 'Z')); };
function makeCert(ips) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alg = dSeq(dOid('1.2.840.113549.1.1.11'), Buffer.from([5, 0]));
  const name = dSeq(dSet(dSeq(dOid('2.5.4.3'), der(0x0c, Buffer.from('Bab El Oued Contact LAN')))));
  const now = Date.now(), san = [der(0x82, Buffer.from('localhost')), ...ips.map(ip => der(0x87, Buffer.from(ip.split('.').map(Number))))];
  const ext = der(0xa3, dSeq(dSeq(dOid('2.5.29.17'), der(0x04, dSeq(...san))), dSeq(dOid('2.5.29.19'), der(0x04, dSeq())), dSeq(dOid('2.5.29.37'), der(0x04, dSeq(dOid('1.3.6.1.5.5.7.3.1'))))));
  const serial = crypto.randomBytes(12); serial[0] &= 0x7f;
  const tbs = dSeq(der(0xa0, dInt(Buffer.from([2]))), dInt(serial), alg, name, dSeq(dTime(new Date(now - 864e5)), dTime(new Date(now + 2 * 365 * 864e5))), name, publicKey.export({ type: 'spki', format: 'der' }), ext);
  const cert = dSeq(tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)])));
  const pem = '-----BEGIN CERTIFICATE-----\n' + cert.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
function lanCert() {
  const f = path.join(ROOT, 'lan-cert.json'), ips = lanIPs().concat('127.0.0.1');
  try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (ips.every(ip => c.ips.includes(ip)) && Date.now() < c.until) return c; } catch (e) {}
  const c = Object.assign(makeCert(ips), { ips, until: Date.now() + 700 * 864e5 });
  try { fs.writeFileSync(f, JSON.stringify(c)); } catch (e) {}
  return c;
}
let secure = null;
if (!process.env.NO_LAN_HTTPS) {
  try {
    const c = lanCert();
    secure = https.createServer({ cert: c.cert, key: c.key }, handleRequest);
    secure.on('upgrade', onUpgrade);
    secure.on('error', e => { console.log('  secure LAN address not available (' + e.code + '), voice chat on the LAN will not work'); secure = null; });
    secure.listen(HTTPS_PORT, '0.0.0.0');
  } catch (e) { console.log('  could not start the secure LAN address:', e.message); secure = null; }
}

server.listen(PORT, '0.0.0.0', async () => {
  console.log('\n  Bab El Oued Contact server is running.\n');
  console.log('  On this computer:        http://localhost:' + PORT);
  for (const ip of lanIPs()) console.log('  Friends on your network: http://' + ip + ':' + PORT);
  if (secure) for (const ip of lanIPs()) console.log('  With voice chat:         https://' + ip + ':' + HTTPS_PORT + '   (accept the browser warning once)');
  if (PUBLIC_URL) console.log('  Public address:          ' + PUBLIC_URL);
  console.log('\n  In the game: Online, create a lobby, then send the invite link.');
  console.log('  Keep this window open while you play. Close it to stop the server.\n');
  await cacheVendor();
});
server.on('error', e => { if (e.code === 'EADDRINUSE') console.error('\n  Port ' + PORT + ' is already in use. Close the other server, or start with another port, for example: PORT=8081 node server.js\n'); else console.error(e); process.exit(1); });
