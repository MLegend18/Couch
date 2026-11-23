// Couch client: lobby, synced YouTube player, chat, reactions, and WebRTC go-live.
const $ = (s) => document.querySelector(s);
const socket = io({ autoConnect: false });

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

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
    if (res.broadcaster) onLiveStarted(res.broadcaster);
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

document.querySelectorAll('.reactions button').forEach((b) => (b.onclick = () => socket.emit('react', { emoji: b.dataset.e })));
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
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
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

// ---------- Go live (WebRTC, broadcaster -> each viewer) ----------
let localStream = null;
let broadcasterId = null;
const peers = new Map(); // peerId -> { pc, chain }

function closePeer(id) {
  const p = peers.get(id);
  if (p) { p.pc.close(); peers.delete(id); }
}
function closeAllPeers() { [...peers.keys()].forEach(closePeer); }
const signal = (to, data) => socket.emit('rtc:signal', { to, data });

function makePeer(id) {
  const pc = new RTCPeerConnection(ICE);
  pc.onicecandidate = (e) => e.candidate && signal(id, { candidate: e.candidate });
  const entry = { pc, chain: Promise.resolve() };
  peers.set(id, entry);
  return entry;
}

async function startLive(kind) {
  if (localStream) return;
  try {
    localStream = kind === 'screen'
      ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      : await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    return toast(err.name === 'NotAllowedError' ? 'Camera/screen permission was blocked' : 'Could not start video');
  }
  socket.emit('live:start', null, (res) => {
    if (res?.error) { stopTracks(); return toast(res.error); }
    showLive('You', localStream, true);
    $('#camBtn').classList.add('hidden'); $('#screenBtn').classList.add('hidden'); $('#stopBtn').classList.remove('hidden');
    localStream.getVideoTracks()[0].onended = stopLive; // browser "Stop sharing" button
  });
}

function stopTracks() { localStream?.getTracks().forEach((t) => t.stop()); localStream = null; }
function stopLive() {
  if (!localStream) return;
  socket.emit('live:stop');
  stopTracks(); closeAllPeers(); hideLive();
  $('#camBtn').classList.remove('hidden'); $('#screenBtn').classList.remove('hidden'); $('#stopBtn').classList.add('hidden');
}

$('#camBtn').onclick = () => startLive('camera');
$('#screenBtn').onclick = () => startLive('screen');
$('#stopBtn').onclick = stopLive;

// Broadcaster: a viewer wants the stream -> send them an offer.
socket.on('live:viewer', async ({ id }) => {
  if (!localStream) return;
  closePeer(id);
  const { pc } = makePeer(id);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signal(id, { sdp: pc.localDescription });
});
socket.on('live:viewer-left', ({ id }) => closePeer(id));

// Viewer side
function onLiveStarted({ id, name }) {
  if (id === myId) return;
  broadcasterId = id;
  $('#liveName').textContent = `${name} is live`;
  $('#livePanel').classList.remove('hidden');
  socket.emit('live:watch');
}
socket.on('live:started', onLiveStarted);
socket.on('live:ended', ({ id }) => {
  if (id === broadcasterId) { closePeer(id); broadcasterId = null; hideLive(); }
});

// Both sides: handle offers/answers/candidates in order, per peer.
socket.on('rtc:signal', ({ from, data }) => {
  let entry = peers.get(from);
  if (!entry) {
    if (!data.sdp || data.sdp.type !== 'offer') return;
    entry = makePeer(from);
    entry.pc.ontrack = (e) => showLive(null, e.streams[0], false);
  }
  entry.chain = entry.chain.then(async () => {
    const { pc } = entry;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        signal(from, { sdp: pc.localDescription });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }).catch((err) => console.warn('WebRTC error', err));
});

function showLive(label, stream, isSelf) {
  const v = $('#liveVideo');
  v.srcObject = stream;
  v.muted = true; // self: avoid echo; viewers: browsers block autoplay with sound
  if (label) $('#liveName').textContent = isSelf ? 'You are live' : label;
  $('#unmuteBtn').classList.toggle('hidden', isSelf);
  $('#unmuteBtn').textContent = '🔇 Tap to unmute';
  $('#livePanel').classList.remove('hidden');
  v.play().catch(() => {});
}
function hideLive() {
  $('#liveVideo').srcObject = null;
  $('#livePanel').classList.add('hidden');
}
$('#unmuteBtn').onclick = () => {
  const v = $('#liveVideo');
  v.muted = !v.muted;
  v.play().catch(() => {});
  $('#unmuteBtn').textContent = v.muted ? '🔇 Tap to unmute' : '🔊 Sound on';
};

socket.on('disconnect', () => toast('Disconnected — trying to reconnect…'));
socket.io.on('reconnect', () => location.reload());
