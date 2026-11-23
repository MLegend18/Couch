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

/** code -> { users: Map<socketId,{name}>, video, broadcaster, chat[] } */
const rooms = new Map();

const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Guest';
const isVideoId = (id) => /^[A-Za-z0-9_-]{11}$/.test(String(id || ''));

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { users: new Map(), video: null, broadcaster: null, chat: [] });
  return rooms.get(code);
}

// Where the video "should" be right now, given the last known state.
function liveVideo(v) {
  if (!v) return null;
  const time = v.playing ? v.time + (Date.now() - v.updatedAt) / 1000 : v.time;
  return { id: v.id, playing: v.playing, time };
}

function roster(r) {
  return [...r.users].map(([id, u]) => ({ id, name: u.name, live: r.broadcaster === id }));
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
    if (!r || r.broadcaster !== socket.id) return;
    r.broadcaster = null;
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
      broadcaster: r.broadcaster ? { id: r.broadcaster, name: r.users.get(r.broadcaster)?.name } : null,
    });
    io.to(code).emit('roster', roster(r));
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

  // ---- Go live (WebRTC signaling relay; one broadcaster per room) ----
  socket.on('live:start', (_p, ack) => {
    const r = room();
    if (!r) return ack?.({ error: 'Not in a room' });
    if (r.broadcaster && r.broadcaster !== socket.id) {
      return ack?.({ error: `${r.users.get(r.broadcaster)?.name || 'Someone'} is already live` });
    }
    r.broadcaster = socket.id;
    ack?.({ ok: true });
    socket.to(code).emit('live:started', { id: socket.id, name });
    io.to(code).emit('roster', roster(r));
    sys(code, `${name} went live 🔴`);
  });

  socket.on('live:stop', endLive);

  socket.on('live:watch', () => {
    const r = room();
    if (r?.broadcaster && r.broadcaster !== socket.id) io.to(r.broadcaster).emit('live:viewer', { id: socket.id });
  });

  socket.on('rtc:signal', ({ to, data } = {}) => {
    const r = room();
    if (r && r.users.has(to) && data) io.to(to).emit('rtc:signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    const r = room();
    if (!r) return;
    if (r.broadcaster === socket.id) endLive();
    else if (r.broadcaster) io.to(r.broadcaster).emit('live:viewer-left', { id: socket.id });
    r.users.delete(socket.id);
    if (r.users.size === 0) {
      rooms.delete(code);
    } else {
      io.to(code).emit('roster', roster(r));
      sys(code, `${name} left`);
    }
  });
});

server.listen(PORT, () => console.log(`Couch running at http://localhost:${PORT}`));
