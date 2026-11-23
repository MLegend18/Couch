// Couch client: lobby, synced YouTube player, chat, reactions, and WebRTC go-live.
const $ = (s) => document.querySelector(s);
const socket = io({ autoConnect: false });

let ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
let hasRelay = false;
// Ask the server for relay (TURN) servers so phones on cell data can connect.
fetch('/ice').then((r) => r.json()).then((d) => {
  if (Array.isArray(d?.servers) && d.servers.length) ICE = { iceServers: d.servers };
  hasRelay = !!d?.relay;
}).catch(() => {});

// In-app browsers (Instagram, Messenger, Snapchat, TikTok…) usually block the camera.
const inAppBrowser = /Instagram|FBAN|FBAV|FB_IAB|Messenger|Snapchat|TikTok|musical_ly|Line\/|Twitter|LinkedInApp/i.test(navigator.userAgent);

let myId = null;
let roomCode = null;

// ---------- Lobby ----------
const params = new URLSearchParams(location.search);
const randomCode = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
$('#roomInput').value = (params.get('room') || '').toUpperCase();
try { $('#nameInput').value = localStorage.getItem('couch:name') || ''; } catch {}
$('#randomBtn').onclick = () => { $('#roomInput').value = randomCode(); };

$('#joinForm').onsubmit = (e) => {
  e.preventDefault();
  const name = $('#nameInput').value.trim();
  const room = $('#roomInput').value.trim() || randomCode();
  try { localStorage.setItem('couch:name', name); } catch {}
  socket.connect();
  socket.emit('join', { name, room }, (res) => {
    if (res?.error) { $('#lobbyError').textContent = res.error; socket.disconnect(); return; }
    myId = res.you;
    roomCode = res.room;
    history.replaceState(null, '', `?room=${roomCode}`);
    $('#roomCode').textContent = roomCode;
    $('#lobby').classList.add('hidden');
    $('#app').classList.remove('hidden');
    res.chat.forEach(addMessage);
    if (res.video) applyState(res.video);
    res.broadcasters.forEach(onLiveStarted);
  });
};

$('#copyLink').onclick = async () => {
  const link = `${location.origin}${location.pathname}?room=${roomCode}`;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
  catch { toast(link); }
};

// ---------- People + chat ----------
socket.on('roster', (list) => {
  const box = $('#people');
  box.innerHTML = '';
  list.forEach((p) => {
    const el = document.createElement('span');
    el.className = 'person' + (p.id === myId ? ' me' : '') + (p.live ? ' live' : '');
    el.textContent = p.id === myId ? `${p.name} (you)` : p.name;
    box.appendChild(el);
  });
});

function addMessage(m) {
  const li = document.createElement('li');
  if (m.sys) { li.className = 'sys'; li.textContent = m.text; }
  else { const b = document.createElement('b'); b.textContent = m.name; li.append(b, document.createTextNode(m.text)); }
  const list = $('#messages');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.appendChild(li);
  if (atBottom) list.scrollTop = list.scrollHeight;
}
socket.on('chat', addMessage);
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#chatInput').value.trim();
  if (t) socket.emit('chat', { text: t });
  $('#chatInput').value = '';
};

document.querySelectorAll('.reactions button').forEach((b) => (b.onclick = () => {
  socket.emit('react', { emoji: b.dataset.e });
  b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
}));

// Pop-up banner when someone joins, leaves, or goes live.
socket.on('presence', ({ type, name }) => {
  const el = document.createElement('div');
  el.className = `banner ${type}`;
  const icon = document.createElement('span'); icon.className = 'big';
  icon.textContent = type === 'join' ? '👋' : type === 'live' ? '🔴' : '🚪';
  const who = document.createElement('b'); who.textContent = name;
  const what = type === 'join' ? ' just pulled up to the couch' : type === 'live' ? ' is live now' : ' left the room';
  el.append(icon, who, document.createTextNode(what));
  const box = $('#banners');
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), 4100);
});
socket.on('react', ({ emoji, name }) => {
  const f = document.createElement('div');
  f.className = 'floater';
  f.style.left = `${8 + Math.random() * 80}%`;
  f.textContent = emoji;
  const s = document.createElement('small'); s.textContent = name; f.appendChild(s);
  $('#floaters').appendChild(f);
  setTimeout(() => f.remove(), 2700);
});

let toastTimer;
function toast(text, ms = 2200) {
  const t = $('#toast');
  t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- Watch together (YouTube sync) ----------
let player = null;
let playerReady = false;
let applyingRemote = false;
let remoteTimer = null;
let lastState = null; // { id, playing, time, at }

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
    events: {
      onReady: () => { playerReady = true; if (lastState) applyState(stateNow()); },
      onStateChange,
    },
  });
};

function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Where the room should be now, from the last state we know.
function expectedTime() {
  if (!lastState) return 0;
  return lastState.playing ? lastState.time + (performance.now() - lastState.at) / 1000 : lastState.time;
}
const stateNow = () => ({ ...lastState, time: expectedTime() });
const currentId = () => player?.getVideoData?.()?.video_id || null;

function applyState(s) {
  lastState = { id: s.id, playing: s.playing, time: s.time, at: performance.now() };
  $('#emptyScreen').classList.add('hidden');
  if (s.by && !s.loaded) toast(`${s.by} ${s.playing ? 'played' : 'paused'}`);
  if (!playerReady) return; // onReady will apply it
  applyingRemote = true;
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(() => (applyingRemote = false), 900);
  if (currentId() !== s.id) {
    if (s.playing) player.loadVideoById(s.id, s.time);
    else player.cueVideoById(s.id, s.time);
    return;
  }
  if (Math.abs(player.getCurrentTime() - s.time) > 1) player.seekTo(s.time, true);
  if (s.playing) player.playVideo(); else player.pauseVideo();
}
socket.on('video:state', applyState);

function emitState(playing) {
  if (!lastState || currentId() !== lastState.id) return;
  const time = player.getCurrentTime();
  // Skip if nothing really changed (stops echo between viewers).
  if (lastState.playing === playing && Math.abs(expectedTime() - time) < 1.2) return;
  lastState = { id: lastState.id, playing, time, at: performance.now() };
  socket.emit('video:state', { playing, time });
}

function onStateChange(e) {
  if (applyingRemote) return;
  if (e.data === YT.PlayerState.PLAYING) emitState(true);
  else if (e.data === YT.PlayerState.PAUSED) emitState(false);
}

// Catch seeks while paused (no YouTube event fires) and correct drift while playing.
setInterval(() => {
  if (!playerReady || !lastState || applyingRemote || currentId() !== lastState.id) return;
  const st = player.getPlayerState();
  const diff = Math.abs(player.getCurrentTime() - expectedTime());
  if (st === YT.PlayerState.PAUSED && !lastState.playing && diff > 1.5) emitState(false);
  else if (st === YT.PlayerState.PLAYING && lastState.playing && diff > 2.5) {
    applyingRemote = true;
    player.seekTo(expectedTime(), true);
    clearTimeout(remoteTimer); remoteTimer = setTimeout(() => (applyingRemote = false), 900);
  }
}, 1000);

$('#loadForm').onsubmit = (e) => {
  e.preventDefault();
  const id = parseYouTubeId($('#urlInput').value);
  if (!id) return toast("That doesn't look like a YouTube link");
  socket.emit('video:load', { id });
  $('#urlInput').value = '';
};
$('#syncBtn').onclick = () => socket.emit('video:sync', null, (v) => (v ? applyState(v) : toast('Nothing playing yet')));

// ---------- Go live (WebRTC). Up to 4 people live at once; each sends to every viewer. ----------
let localStream = null;
const peers = new Map(); // "ownerId>viewerId" -> { pc, chain }
const keyOf = (owner, viewer) => `${owner}>${viewer}`;

function closePeer(key) {
  const p = peers.get(key);
  if (p) { p.pc.close(); peers.delete(key); }
}
const signal = (to, key, data) => socket.emit('rtc:signal', { to, data: { ...data, key } });

function makePeer(key, remoteId) {
  const pc = new RTCPeerConnection(ICE);
  pc.onicecandidate = (e) => e.candidate && signal(remoteId, key, { candidate: e.candidate });
  const entry = { pc, chain: Promise.resolve() };
  peers.set(key, entry);
  return entry;
}

async function startLive(kind) {
  if (localStream) return;
  if (!navigator.mediaDevices?.getUserMedia || (kind === 'screen' && !navigator.mediaDevices.getDisplayMedia)) {
    return toast(kind === 'screen'
      ? "This browser can't share its screen. Phones can only go live with the camera."
      : inAppBrowser ? 'Open this link in Safari or Chrome to go live — this app blocks the camera.'
        : "This browser can't use the camera. Try Safari or Chrome.", 6000);
  }
  try {
    localStream = kind === 'screen'
      ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      : await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    return toast(err.name === 'NotAllowedError'
      ? (inAppBrowser ? 'Open this link in Safari or Chrome to go live — this app blocks the camera.'
        : 'Camera was blocked. Allow camera access for this site in your browser settings, then try again.')
      : 'Could not start the camera — is another app using it?', 6000);
  }
  socket.emit('live:start', null, (res) => {
    if (res?.error) { stopTracks(); return toast(res.error); }
    addTile(myId, 'You', localStream, true);
    $('#camBtn').classList.add('hidden'); $('#screenBtn').classList.add('hidden'); $('#stopBtn').classList.remove('hidden');
    localStream.getVideoTracks()[0].onended = stopLive; // browser "Stop sharing" button
  });
}

function stopTracks() { localStream?.getTracks().forEach((t) => t.stop()); localStream = null; }
function stopLive() {
  if (!localStream) return;
  socket.emit('live:stop');
  stopTracks();
  [...peers.keys()].filter((k) => k.startsWith(`${myId}>`)).forEach(closePeer);
  removeTile(myId);
  $('#camBtn').classList.remove('hidden'); $('#screenBtn').classList.remove('hidden'); $('#stopBtn').classList.add('hidden');
}

$('#camBtn').onclick = () => startLive('camera');
$('#screenBtn').onclick = () => startLive('screen');
$('#stopBtn').onclick = stopLive;

// I'm live and someone wants to watch -> send them an offer.
socket.on('live:viewer', async ({ id }) => {
  if (!localStream) return;
  const key = keyOf(myId, id);
  closePeer(key);
  const { pc } = makePeer(key, id);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  await pc.setLocalDescription(await pc.createOffer());
  signal(id, key, { sdp: pc.localDescription });
});
socket.on('live:viewer-left', ({ id }) => closePeer(keyOf(myId, id)));

// Someone else went live -> make a tile and ask for their stream.
function onLiveStarted({ id, name }) {
  if (id === myId) return;
  addTile(id, name, null, false);
  socket.emit('live:watch', { id });
}
socket.on('live:started', onLiveStarted);
socket.on('live:ended', ({ id }) => { closePeer(keyOf(id, myId)); removeTile(id); });

// Offers/answers/candidates, handled in order per connection.
socket.on('rtc:signal', ({ from, data }) => {
  const key = data?.key;
  if (key !== keyOf(from, myId) && key !== keyOf(myId, from)) return;
  let entry = peers.get(key);
  if (!entry) {
    if (key !== keyOf(from, myId) || data.sdp?.type !== 'offer') return;
    entry = makePeer(key, from);
    entry.pc.ontrack = (e) => setTileStream(from, e.streams[0]);
    setTileStatus(from, 'Connecting…');
    entry.pc.onconnectionstatechange = () => {
      const st = entry.pc.connectionState;
      if (st === 'connected') setTileStatus(from, '');
      else if (st === 'failed') setTileStatus(from, hasRelay
        ? "Couldn't connect. Tap to retry."
        : "Couldn't connect: their network blocks direct video. Tap to retry. (Fix: add a relay server — see README.)", true);
      else if (st === 'disconnected') setTileStatus(from, 'Reconnecting…');
    };
  }
  entry.chain = entry.chain.then(async () => {
    const { pc } = entry;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        signal(from, key, { sdp: pc.localDescription });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }).catch((err) => console.warn('WebRTC error', err));
});

// ---------- Live tiles ----------
const tileOf = (id) => document.getElementById(`tile-${id}`);
function addTile(id, name, stream, isSelf) {
  let t = tileOf(id);
  if (!t) {
    t = document.createElement('div');
    t.className = 'tile';
    t.id = `tile-${id}`;
    t.innerHTML = '<div class="live-head"><span class="badge">LIVE</span> <span class="nm"></span></div>'
      + '<video autoplay playsinline muted></video><div class="status hidden"></div><button class="chip unmute">🔇 Unmute</button>';
    const v = t.querySelector('video');
    const b = t.querySelector('button');
    if (isSelf) b.remove();
    else b.onclick = () => { v.muted = !v.muted; v.play().catch(() => {}); b.textContent = v.muted ? '🔇 Unmute' : '🔊 Sound on'; };
    // Your own tile first, then others in the order they went live.
    isSelf ? $('#liveGrid').prepend(t) : $('#liveGrid').appendChild(t);
  }
  t.querySelector('.nm').textContent = isSelf ? 'You' : name;
  if (stream) setTileStream(id, stream);
  else if (!isSelf) setTileStatus(id, 'Connecting…');
  updateGrid();
}
function setTileStatus(id, text, retry = false) {
  const t = tileOf(id);
  const el = t?.querySelector('.status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('hidden', !text);
  el.onclick = retry ? () => { closePeer(keyOf(id, myId)); setTileStatus(id, 'Connecting…'); socket.emit('live:watch', { id }); } : null;
  el.style.cursor = retry ? 'pointer' : '';
}
function setTileStream(id, stream) {
  const v = tileOf(id)?.querySelector('video');
  if (!v) return;
  v.srcObject = stream;
  v.play().catch(() => {});
}
function removeTile(id) { tileOf(id)?.remove(); updateGrid(); }
function updateGrid() {
  const g = $('#liveGrid');
  g.classList.toggle('hidden', g.children.length === 0);
  g.classList.toggle('multi', g.children.length > 1);
}

socket.on('disconnect', () => toast('Disconnected — trying to reconnect…'));
socket.io.on('reconnect', () => location.reload());
