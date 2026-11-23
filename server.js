// Couch — watch together + go live.
// One Node process: serves the web page and relays real-time events with Socket.IO.
// Video itself never passes through this server:
//   - YouTube plays on each viewer's own device; the server only syncs play/pause/time.
//   - Live video goes browser-to-browser over WebRTC; the server only relays the handshake.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 3e6 }); // room for meme uploads

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

// ---- Relay (TURN) servers for live video ----
// Phones on cell data and some home routers can't connect browser-to-browser directly.
// A TURN relay fixes that. Set METERED_APP and METERED_API_KEY (free at metered.ca) in Render.
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
let iceCache = { at: 0, servers: null };
async function getIceServers() {
  const { METERED_APP, METERED_API_KEY } = process.env;
  if (!METERED_APP || !METERED_API_KEY) return { servers: STUN, relay: false };
  if (iceCache.servers && Date.now() - iceCache.at < 60 * 60 * 1000) return { servers: iceCache.servers, relay: true };
  try {
    const url = `https://${METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const servers = await res.json();
    if (!Array.isArray(servers) || !servers.length) throw new Error('empty list');
    iceCache = { at: Date.now(), servers };
    return { servers, relay: true };
  } catch (err) {
    console.warn('Could not get TURN credentials:', err.message);
    return { servers: STUN, relay: false };
  }
}
app.get('/ice', async (_req, res) => res.json(await getIceServers()));

// ---- Optional GIF search (GIPHY). Set GIPHY_API_KEY in Render to turn it on. ----
app.get('/config', (_req, res) => res.json({ gifs: !!process.env.GIPHY_API_KEY }));
app.get('/gifs', async (req, res) => {
  const key = process.env.GIPHY_API_KEY;
  if (!key) return res.status(404).json({ error: 'GIF search is not set up' });
  const q = String(req.query.q || '').trim().slice(0, 50);
  const base = 'https://api.giphy.com/v1/gifs/';
  const url = q
    ? `${base}search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&limit=24&rating=r`
    : `${base}trending?api_key=${encodeURIComponent(key)}&limit=24&rating=r`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    res.json((j.data || []).map((g) => ({
      id: g.id,
      preview: g.images?.fixed_width_small?.url || g.images?.fixed_height_small?.url,
      url: g.images?.fixed_height?.url || g.images?.original?.url,
    })).filter((g) => g.preview && g.url));
  } catch {
    res.status(502).json({ error: 'GIF search failed' });
  }
});
const isGiphyUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)giphy\.com$/.test(x.hostname); } catch { return false; } };

/** code -> { users: Map<socketId,{name}>, video, broadcasters: Set<socketId>, chat[] } */
const MAX_LIVE = 4;
const rooms = new Map();

const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Guest';
const isVideoId = (id) => /^[A-Za-z0-9_-]{11}$/.test(String(id || ''));
const FONTS = new Set(['Inter', 'Space Grotesk', 'Comic Neue', 'Bangers', 'Pacifico', 'Press Start 2P', 'Courier Prime', 'Permanent Marker', 'Caveat']);
function cleanStyle(st) {
  const out = {};
  if (/^#[0-9a-fA-F]{6}$/.test(st?.color || '')) out.color = st.color;
  if (FONTS.has(st?.font)) out.font = st.font;
  if (st?.bold) out.bold = true;
  return out;
}
const isEmoji = (e) => typeof e === 'string' && e.length <= 16 && /\p{Extended_Pictographic}/u.test(e) && !/[<>&"'\s]/.test(e);
const MEME_MAX = 30;
const MEME_BYTES = 10e6;
const MEME_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { users: new Map(), video: null, broadcasters: new Set(), chat: [], memes: [] });
  return rooms.get(code);
}

// Where the video "should" be right now, given the last known state.
function liveVideo(v) {
  if (!v) return null;
  const time = v.playing ? v.time + (Date.now() - v.updatedAt) / 1000 : v.time;
  return { id: v.id, playing: v.playing, time };
}

function roster(r) {
  return [...r.users].map(([id, u]) => ({ id, name: u.name, live: r.broadcasters.has(id) }));
}

function pushChat(code, msg) {
  const r = rooms.get(code);
  if (!r) return;
  r.chat.push(msg);
  if (r.chat.length > 200) r.chat.shift();
  io.to(code).emit('chat', msg);
}
const sys = (code, text) => pushChat(code, { sys: true, text, ts: Date.now() });

io.on('connection', (socket) => {
  let code = null;
  let name = 'Guest';
  const room = () => (code ? rooms.get(code) : null);

  function endLive() {
    const r = room();
    if (!r || !r.broadcasters.has(socket.id)) return;
    r.broadcasters.delete(socket.id);
    io.to(code).emit('live:ended', { id: socket.id });
    io.to(code).emit('roster', roster(r));
    sys(code, `${name} ended the live stream`);
  }

  socket.on('join', (payload, ack) => {
    if (code) return ack?.({ error: 'Already in a room' });
    const c = cleanCode(payload?.room);
    if (c.length < 3) return ack?.({ error: 'Room code must be 3–8 letters or numbers' });
    code = c;
    name = cleanName(payload?.name);
    const entrance = String(payload?.entrance || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const r = getRoom(code);
    socket.join(code);
    r.users.set(socket.id, { name });
    ack?.({
      ok: true,
      you: socket.id,
      room: code,
      video: liveVideo(r.video),
      chat: r.chat.slice(-60),
      memes: r.memes,
      broadcasters: [...r.broadcasters].map((id) => ({ id, name: r.users.get(id)?.name })),
    });
    io.to(code).emit('roster', roster(r));
    socket.to(code).emit('presence', { type: 'join', name, line: entrance });
    sys(code, `${name} joined`);
  });

  // ---- Watch together ----
  socket.on('video:load', ({ id } = {}) => {
    const r = room();
    if (!r || !isVideoId(id)) return;
    r.video = { id, playing: true, time: 0, updatedAt: Date.now() };
    io.to(code).emit('video:state', { ...liveVideo(r.video), by: name, loaded: true });
    sys(code, `${name} put on a new video`);
  });

  socket.on('video:state', ({ playing, time } = {}) => {
    const r = room();
    if (!r || !r.video) return;
    const t = Number(time);
    r.video = { id: r.video.id, playing: !!playing, time: Number.isFinite(t) && t >= 0 ? t : 0, updatedAt: Date.now() };
    socket.to(code).emit('video:state', { ...liveVideo(r.video), by: name });
  });

  socket.on('video:sync', (_p, ack) => ack?.(liveVideo(room()?.video)));

  // ---- Chat + reactions ----
  socket.on('chat', ({ text, style } = {}) => {
    const t = String(text || '').trim().slice(0, 500);
    if (room() && t) pushChat(code, { name, text: t, ts: Date.now(), style: cleanStyle(style) });
  });

  // Light flood protection for reactions and memes.
  let lastBurst = 0;
  const tooFast = () => { const now = Date.now(); if (now - lastBurst < 150) return true; lastBurst = now; return false; };

  socket.on('react', ({ emoji } = {}) => {
    if (room() && isEmoji(emoji) && !tooFast()) io.to(code).emit('react', { emoji, name });
  });

  // ---- Meme reactions ----
  socket.on('meme:add', ({ data } = {}, ack) => {
    const r = room();
    if (!r) return;
    if (typeof data !== 'string' || data.length > 2.2e6 || !MEME_RE.test(data)) {
      return ack?.({ error: 'That image is too big or not a supported type' });
    }
    const m = { id: crypto.randomUUID().slice(0, 8), data, by: name };
    r.memes.push(m);
    let total = r.memes.reduce((n, x) => n + x.data.length, 0);
    while (r.memes.length > MEME_MAX || total > MEME_BYTES) total -= r.memes.shift().data.length;
    io.to(code).emit('meme:added', m);
    io.to(code).emit('meme:show', { id: m.id, name });
    ack?.({ ok: true, id: m.id });
  });

  socket.on('meme:send', ({ id, url } = {}) => {
    const r = room();
    if (!r || tooFast()) return;
    if (id && r.memes.some((m) => m.id === id)) io.to(code).emit('meme:show', { id, name });
    else if (url && isGiphyUrl(url)) io.to(code).emit('meme:show', { url, name });
  });

  // ---- Go live (WebRTC signaling relay; up to MAX_LIVE broadcasters per room) ----
  socket.on('live:start', (_p, ack) => {
    const r = room();
    if (!r) return ack?.({ error: 'Not in a room' });
    if (!r.broadcasters.has(socket.id) && r.broadcasters.size >= MAX_LIVE) {
      return ack?.({ error: `${MAX_LIVE} people are already live — wait for someone to stop` });
    }
    r.broadcasters.add(socket.id);
    ack?.({ ok: true });
    socket.to(code).emit('live:started', { id: socket.id, name });
    socket.to(code).emit('presence', { type: 'live', name });
    io.to(code).emit('roster', roster(r));
    sys(code, `${name} went live 🔴`);
  });

  socket.on('live:stop', endLive);

  socket.on('live:watch', ({ id } = {}) => {
    const r = room();
    if (r?.broadcasters.has(id) && id !== socket.id) io.to(id).emit('live:viewer', { id: socket.id });
  });

  socket.on('rtc:signal', ({ to, data } = {}) => {
    const r = room();
    if (r && r.users.has(to) && data) io.to(to).emit('rtc:signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    const r = room();
    if (!r) return;
    endLive();
    r.broadcasters.forEach((b) => io.to(b).emit('live:viewer-left', { id: socket.id }));
    r.users.delete(socket.id);
    if (r.users.size === 0) {
      rooms.delete(code);
    } else {
      io.to(code).emit('roster', roster(r));
      io.to(code).emit('presence', { type: 'leave', name });
      sys(code, `${name} left`);
    }
  });
});

server.listen(PORT, () => console.log(`Couch running at http://localhost:${PORT}`));
