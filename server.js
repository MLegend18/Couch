// Couch — watch together + go live.
// One Node process: serves the web page and relays real-time events with Socket.IO.
// Video itself never passes through this server:
//   - YouTube plays on each viewer's own device; the server only syncs play/pause/time.
//   - Live video goes browser-to-browser over WebRTC; the server only relays the handshake.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

/** code -> { users: Map<socketId,{name}>, video, broadcasters: Set<socketId>, chat[] } */
const MAX_LIVE = 4;
const rooms = new Map();

const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Guest';
const isVideoId = (id) => /^[A-Za-z0-9_-]{11}$/.test(String(id || ''));

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { users: new Map(), video: null, broadcasters: new Set(), chat: [] });
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
    const r = getRoom(code);
    socket.join(code);
    r.users.set(socket.id, { name });
    ack?.({
      ok: true,
      you: socket.id,
      room: code,
      video: liveVideo(r.video),
      chat: r.chat.slice(-60),
      broadcasters: [...r.broadcasters].map((id) => ({ id, name: r.users.get(id)?.name })),
    });
    io.to(code).emit('roster', roster(r));
    socket.to(code).emit('presence', { type: 'join', name });
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
  socket.on('chat', ({ text } = {}) => {
    const t = String(text || '').trim().slice(0, 500);
    if (room() && t) pushChat(code, { name, text: t, ts: Date.now() });
  });

  const EMOJI = new Set(['😂', '🔥', '😮', '❤️', '👏', '💀']);
  socket.on('react', ({ emoji } = {}) => {
    if (room() && EMOJI.has(emoji)) io.to(code).emit('react', { emoji, name });
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
