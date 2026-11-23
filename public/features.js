// Couch extras: custom video controls, themes, chat styles, emoji drawer, meme reactions.
// Loaded after app.js and uses its globals (socket, player, lastState, toast, $ …).

const store = {
  get(k, d) { try { const v = localStorage.getItem(`couch:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`couch:${k}`, JSON.stringify(v)); } catch {} },
};

// ======================= Custom video controls =======================
// YouTube's own controls are off, and a transparent shield sits over the video,
// so clicks never open youtube.com. Our buttons drive the player instead.
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};
let seekDragging = false;
let userMuted = false;
let ctrlHideTimer = null;

const videoActive = () => playerReady && lastState && currentId() === lastState.id;
const isPlayingNow = () => {
  if (!window.YT?.PlayerState) return false;
  const st = player?.getPlayerState?.();
  return st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING;
};

function onVideoShown() {
  $('#shield').classList.remove('hidden');
  $('#vctrl').classList.remove('hidden');
  showControls();
}

function userSetPlaying(playing) {
  if (!videoActive()) return;
  suppress(1200);
  const time = player.getCurrentTime();
  if (playing) {
    if (!userMuted) { player.unMute(); $('#soundBtn').classList.add('hidden'); }
    player.playVideo();
  } else {
    player.pauseVideo();
  }
  lastState = { id: lastState.id, playing, time, at: performance.now() };
  socket.emit('video:state', { playing, time });
  if (playing) ensurePlaying();
}
const togglePlay = () => userSetPlaying(!isPlayingNow());

function userSeek(t) {
  if (!videoActive()) return;
  suppress(1200);
  player.seekTo(t, true);
  lastState = { ...lastState, time: t, at: performance.now() };
  socket.emit('video:state', { playing: lastState.playing, time: t });
}

function showControls() {
  const c = $('#vctrl');
  c.classList.add('show');
  clearTimeout(ctrlHideTimer);
  ctrlHideTimer = setTimeout(() => { if (isPlayingNow() && !seekDragging) c.classList.remove('show'); }, 3000);
}

const shield = $('#shield');
shield.addEventListener('pointerup', (e) => {
  // Touch: first tap shows the controls. Mouse: click plays/pauses.
  if (e.pointerType === 'touch' && !$('#vctrl').classList.contains('show')) return showControls();
  togglePlay();
  showControls();
});
shield.addEventListener('dblclick', toggleFullscreen);
$('.screen').addEventListener('mousemove', showControls);

$('#vPlay').onclick = () => { togglePlay(); showControls(); };
$('#vSeek').addEventListener('input', () => { seekDragging = true; $('#vCur').textContent = fmtTime($('#vSeek').value); showControls(); });
$('#vSeek').addEventListener('change', () => { seekDragging = false; userSeek(Number($('#vSeek').value)); });
$('#vMute').onclick = () => {
  if (!playerReady) return;
  userMuted = !player.isMuted();
  if (userMuted) player.mute(); else { player.unMute(); $('#soundBtn').classList.add('hidden'); }
  showControls();
};
$('#vVol').addEventListener('input', () => {
  if (!playerReady) return;
  const v = Number($('#vVol').value);
  player.setVolume(v);
  if (v > 0 && player.isMuted()) { player.unMute(); userMuted = false; }
  store.set('volume', v);
});
$('#vFull').onclick = toggleFullscreen;

function toggleFullscreen() {
  const scr = $('.screen');
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  if (scr.classList.contains('pseudo-fs')) return setPseudoFs(false);
  const req = scr.requestFullscreen || scr.webkitRequestFullscreen;
  if (req) {
    const p = req.call(scr);
    if (p?.catch) p.catch(() => setPseudoFs(true));
  } else {
    setPseudoFs(true); // iPhone Safari can't fullscreen a page element
  }
}
function setPseudoFs(on) {
  $('.screen').classList.toggle('pseudo-fs', on);
  document.body.classList.toggle('no-scroll', on);
}

// Keep the bar in step with the player.
setInterval(() => {
  if (!playerReady || !player.getDuration) return;
  const dur = player.getDuration() || 0;
  const cur = player.getCurrentTime() || 0;
  const seek = $('#vSeek');
  seek.max = dur;
  if (!seekDragging) { seek.value = cur; $('#vCur').textContent = fmtTime(cur); }
  seek.style.setProperty('--pct', dur ? `${(Number(seek.value) / dur) * 100}%` : '0%');
  $('#vDur').textContent = fmtTime(dur);
  $('#vPlay').textContent = isPlayingNow() ? '❚❚' : '▶';
  $('#vMute').textContent = player.isMuted() ? '🔇' : '🔊';
  // If the shield was lifted so a phone could tap YouTube's own play button, put it back once playing.
  if (isPlayingNow() && lastState?.id) shield.classList.remove('hidden');
}, 250);

// Apply saved volume once the player exists.
const volTimer = setInterval(() => {
  if (!playerReady) return;
  clearInterval(volTimer);
  const v = store.get('volume', 100);
  $('#vVol').value = v;
  player.setVolume(v);
}, 300);

// Last-resort for phones that refuse to start the video from our button:
// lift the shield so they can tap YouTube's own play button once.
$('#tapToPlay').addEventListener('click', () => {
  setTimeout(() => {
    if (lastState?.playing && !isPlayingNow()) {
      shield.classList.add('hidden');
      toast("Tap the video's ▶ button to start", 4000);
    }
  }, 1300);
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); showControls(); }
  if (e.key === 'f') toggleFullscreen();
  if (e.key === 'Escape') { setPseudoFs(false); closeSheets(); }
});

// ======================= Sheets (pop-up panels) =======================
function openSheet(id) {
  closeSheets();
  $(`#${id}`).classList.remove('hidden');
  $('#backdrop').classList.remove('hidden');
}
function closeSheets() {
  document.querySelectorAll('.sheet').forEach((s) => s.classList.add('hidden'));
  $('#backdrop').classList.add('hidden');
}
$('#backdrop').onclick = closeSheets;
document.querySelectorAll('.sheet .close').forEach((b) => (b.onclick = closeSheets));

// ======================= Themes =======================
const THEMES = {
  ember: { label: 'Ember', a: '#ff6b3d', b: '#ffb347' },
  ocean: { label: 'Ocean', a: '#3dc1ff', b: '#7c5cff' },
  grape: { label: 'Grape', a: '#b26bff', b: '#ff6bd5' },
  lime: { label: 'Lime', a: '#9dff3d', b: '#3dffb0' },
  rose: { label: 'Rose', a: '#ff4d8d', b: '#ffa3c4' },
  gold: { label: 'Gold', a: '#ffcf3d', b: '#ff8a3d' },
  mint: { label: 'Mint', a: '#3dffc8', b: '#3d9bff' },
  blood: { label: 'Blood', a: '#ff2d2d', b: '#8b0000' },
};
const MODES = {
  dark: { bg: '#0f0d12', panel: '#18151d', panel2: '#221e29', line: '#2f2938', text: '#f3eef7', muted: '#9a90a6' },
  light: { bg: '#f7f4f0', panel: '#ffffff', panel2: '#f0ebe5', line: '#ddd4ca', text: '#1d1820', muted: '#756b7c' },
};
let theme = store.get('theme', { a: THEMES.ember.a, b: THEMES.ember.b, mode: 'dark' });

function applyTheme() {
  const r = document.documentElement.style;
  const m = MODES[theme.mode] || MODES.dark;
  r.setProperty('--bg', m.bg); r.setProperty('--panel', m.panel); r.setProperty('--panel-2', m.panel2);
  r.setProperty('--line', m.line); r.setProperty('--text', m.text); r.setProperty('--muted', m.muted);
  r.setProperty('--accent', theme.a); r.setProperty('--accent-2', theme.b);
  document.body.classList.toggle('light', theme.mode === 'light');
  $('#accent1').value = theme.a;
  $('#accent2').value = theme.b;
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === theme.mode));
  document.querySelectorAll('.theme').forEach((b) => b.classList.toggle('on', b.dataset.a === theme.a && b.dataset.b === theme.b));
  store.set('theme', theme);
}
Object.entries(THEMES).forEach(([key, t]) => {
  const b = document.createElement('button');
  b.className = 'theme';
  b.dataset.a = t.a; b.dataset.b = t.b;
  b.innerHTML = `<i style="background:linear-gradient(135deg,${t.a},${t.b})"></i><span>${t.label}</span>`;
  b.onclick = () => { theme = { ...theme, a: t.a, b: t.b }; applyTheme(); };
  $('#themeGrid').appendChild(b);
});
document.querySelectorAll('#modeSeg button').forEach((b) => (b.onclick = () => { theme.mode = b.dataset.mode; applyTheme(); }));
$('#accent1').addEventListener('input', (e) => { theme.a = e.target.value; applyTheme(); });
$('#accent2').addEventListener('input', (e) => { theme.b = e.target.value; applyTheme(); });
applyTheme();

// ======================= Chat style + entrance line =======================
const FONT_LIST = ['Inter', 'Space Grotesk', 'Comic Neue', 'Bangers', 'Pacifico', 'Press Start 2P', 'Courier Prime', 'Permanent Marker', 'Caveat'];
const NAME_COLORS = ['#ffb347', '#ff6b3d', '#ff4d8d', '#b26bff', '#3dc1ff', '#3dffc8', '#9dff3d', '#ffe14d'];
let chatStyle = store.get('chatStyle', { color: '', font: 'Inter', bold: false, size: 15 });

function myStyle() { return { color: chatStyle.color || undefined, font: chatStyle.font, bold: chatStyle.bold }; }
function getEntrance() { return $('#entranceInput').value.trim(); }

function styleMessage(nameEl, textEl, st) {
  if (!st) return;
  if (st.color) nameEl.style.color = st.color;
  if (st.font && st.font !== 'Inter') {
    const ff = `'${st.font}', Inter, sans-serif`;
    nameEl.style.fontFamily = ff;
    textEl.style.fontFamily = ff;
    if (st.font === 'Press Start 2P') textEl.style.fontSize = '0.72em';
    if (st.font === 'Caveat' || st.font === 'Pacifico') textEl.style.fontSize = '1.15em';
  }
  if (st.bold) textEl.style.fontWeight = '700';
}

function applyChatStyle() {
  document.documentElement.style.setProperty('--chat-size', `${chatStyle.size}px`);
  $('#fontSelect').value = chatStyle.font;
  $('#boldCheck').checked = !!chatStyle.bold;
  $('#sizeSelect').value = String(chatStyle.size);
  $('#nameColor').value = chatStyle.color || '#ffb347';
  document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.c === chatStyle.color));
  // Live preview
  const pv = $('#chatPreview');
  pv.innerHTML = '';
  const li = document.createElement('li');
  const b = document.createElement('b'); b.textContent = $('#nameInput').value.trim() || 'You';
  const t = document.createElement('span'); t.textContent = 'this is how my messages look 👀';
  styleMessage(b, t, myStyle());
  li.append(b, t); pv.appendChild(li);
  store.set('chatStyle', chatStyle);
}
FONT_LIST.forEach((f) => {
  const o = document.createElement('option');
  o.value = f; o.textContent = f; o.style.fontFamily = `'${f}'`;
  $('#fontSelect').appendChild(o);
});
NAME_COLORS.forEach((c) => {
  const s = document.createElement('button');
  s.className = 'swatch'; s.dataset.c = c; s.style.background = c; s.title = c;
  s.onclick = () => { chatStyle.color = c; applyChatStyle(); };
  $('#nameSwatches').appendChild(s);
});
$('#nameColor').addEventListener('input', (e) => { chatStyle.color = e.target.value; applyChatStyle(); });
$('#fontSelect').onchange = (e) => { chatStyle.font = e.target.value; applyChatStyle(); };
$('#boldCheck').onchange = (e) => { chatStyle.bold = e.target.checked; applyChatStyle(); };
$('#sizeSelect').onchange = (e) => { chatStyle.size = Number(e.target.value); applyChatStyle(); };
$('#entranceInput').value = store.get('entrance', '');
$('#entranceInput').addEventListener('input', (e) => store.set('entrance', e.target.value));
applyChatStyle();

$('#customizeBtn').onclick = () => { applyChatStyle(); openSheet('customSheet'); };

// ======================= Emojis =======================
const EMOJI_SETS = {
  Faces: '😂 🤣 😭 😍 🥰 😘 😎 🤩 😮 😱 😳 🥺 😤 😡 🤯 🙄 😴 🤔 🫠 🤡 💀 ☠️ 👻 🙈',
  Hype: '🔥 💯 👏 🙌 🎉 🥳 ⚡ 💥 🚀 🏆 👑 💎 ✨ 🫡 🤝 👀 🍿 🎬 📺 🎮',
  Love: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💕 💖 😻 🫶 💐 🌹',
  'Spicy 🌶️': '🍆 🍑 💦 👅 🥵 😏 🫦 😈 💋 🍒 🌶️ 🍌 🌮 🥒 🍩 🔞 🛏️ 🫣',
  Shade: '🧢 🗑️ 🤥 🐍 🤨 😒 🙃 💅 ☕ 🫖 🤐 👎 🥱 🧂 🚩',
  'Animals & stuff': '🐐 🦍 🐸 🐶 🐱 🦄 🐔 🦆 🐒 🍕 🍗 🍾 🍻 💸 💰 🎂 💩',
};
const DEFAULT_QUICK = ['😂', '🔥', '😮', '❤️', '💀', '🍆', '👀'];
let recent = store.get('recentEmoji', DEFAULT_QUICK);
let emojiMode = 'react'; // 'react' or 'chat'

function sendReaction(e, btn) {
  socket.emit('react', { emoji: e });
  recent = [e, ...recent.filter((x) => x !== e)].slice(0, 7);
  store.set('recentEmoji', recent);
  if (btn) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); }
  renderQuick();
}
function renderQuick() {
  const box = $('#quickEmoji');
  // Keep the bar stable while tapping: only re-render if the set changed.
  const key = recent.join('');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  recent.forEach((e) => {
    const b = document.createElement('button');
    b.className = 'rbtn'; b.textContent = e;
    b.onclick = () => sendReaction(e, b);
    box.appendChild(b);
  });
}
// Re-render the quick bar only after the user stops tapping, so buttons don't jump mid-spam.
let quickTimer;
const _renderQuick = renderQuick;
renderQuick = () => { clearTimeout(quickTimer); quickTimer = setTimeout(_renderQuick, 1500); };
_renderQuick();

Object.entries(EMOJI_SETS).forEach(([name, list]) => {
  const h = document.createElement('h4'); h.textContent = name;
  const grid = document.createElement('div'); grid.className = 'emoji-grid';
  list.split(' ').forEach((e) => {
    const b = document.createElement('button');
    b.textContent = e;
    b.onclick = () => {
      if (emojiMode === 'chat') {
        const inp = $('#chatInput');
        inp.value = (inp.value + e).slice(0, 500);
        closeSheets(); inp.focus();
      } else {
        sendReaction(e, b);
        closeSheets(); // so you can see it float up; it's now in your quick bar too
        _renderQuick();
      }
    };
    grid.appendChild(b);
  });
  $('#emojiBody').append(h, grid);
});
$('#moreEmoji').onclick = () => { emojiMode = 'react'; $('#emojiTitle').textContent = 'React with an emoji'; openSheet('emojiSheet'); };
$('#chatEmoji').onclick = () => { emojiMode = 'chat'; $('#emojiTitle').textContent = 'Add to your message'; openSheet('emojiSheet'); };

// ======================= Memes =======================
const memes = new Map(); // id -> { data, by }

function addMemeTile(m) {
  if (memes.has(m.id)) return;
  memes.set(m.id, m);
  while (memes.size > 30) {
    const oldest = memes.keys().next().value;
    memes.delete(oldest);
    document.querySelector(`[data-meme="${oldest}"]`)?.remove();
  }
  const b = document.createElement('button');
  b.className = 'memetile';
  b.dataset.meme = m.id;
  b.title = `Added by ${m.by}`;
  const img = document.createElement('img');
  img.src = m.data; img.alt = 'meme'; img.loading = 'lazy';
  b.appendChild(img);
  b.onclick = () => { socket.emit('meme:send', { id: m.id }); closeSheets(); };
  $('#memeGrid').insertBefore(b, $('#memeGrid .upload-tile').nextSibling);
}
socket.on('meme:added', addMemeTile);

function onJoinedExtras(res) {
  (res.memes || []).forEach(addMemeTile);
}

socket.on('meme:show', ({ id, url, name }) => {
  const src = id ? memes.get(id)?.data : url;
  if (!src) return;
  const layer = $('#memeLayer');
  const pop = document.createElement('div');
  pop.className = 'memepop';
  pop.style.left = `${10 + Math.random() * 45}%`;
  pop.style.top = `${8 + Math.random() * 30}%`;
  pop.style.setProperty('--tilt', `${(Math.random() * 14 - 7).toFixed(1)}deg`);
  const img = document.createElement('img');
  img.src = src; img.alt = 'meme';
  const cap = document.createElement('small'); cap.textContent = name;
  pop.append(img, cap);
  layer.appendChild(pop);
  while (layer.children.length > 4) layer.firstChild.remove();
  setTimeout(() => pop.remove(), 3800);
});

const readAsDataURL = (file) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file);
});
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

async function prepareMeme(file) {
  if (!file.type.startsWith('image/')) throw new Error('Pick an image file');
  if (file.size > 20e6) throw new Error('That image is too big');
  // Small GIFs go up as-is so they stay animated.
  if (file.type === 'image/gif' && file.size <= 1.5e6) return { data: await readAsDataURL(file) };
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const scale = Math.min(1, 480 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    let data = c.toDataURL('image/webp', 0.82);
    if (!data.startsWith('data:image/webp')) data = c.toDataURL('image/jpeg', 0.85);
    return { data, flattened: file.type === 'image/gif' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('#memeFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { data, flattened } = await prepareMeme(file);
    toast('Uploading meme…');
    socket.emit('meme:add', { data }, (res) => {
      if (res?.error) return toast(res.error, 4000);
      toast(flattened ? 'Added! (Big GIFs become still images — keep GIFs under 1.5 MB to animate)' : 'Added to room memes', 3500);
      closeSheets();
    });
  } catch (err) {
    toast(err.message || "Couldn't read that image", 4000);
  }
});

// Tabs + GIF search (only if the server has a GIPHY key)
document.querySelectorAll('#memeSheet .tab').forEach((t) => (t.onclick = () => {
  document.querySelectorAll('#memeSheet .tab').forEach((x) => x.classList.toggle('on', x === t));
  $('#tab-room').classList.toggle('hidden', t.dataset.tab !== 'room');
  $('#tab-gifs').classList.toggle('hidden', t.dataset.tab !== 'gifs');
  if (t.dataset.tab === 'gifs' && !$('#gifGrid').children.length) searchGifs('');
}));
fetch('/config').then((r) => r.json()).then((c) => { if (c.gifs) $('#gifTabBtn').classList.remove('hidden'); }).catch(() => {});

async function searchGifs(q) {
  const grid = $('#gifGrid');
  grid.innerHTML = '<p class="fine">Loading…</p>';
  try {
    const r = await fetch(`/gifs?q=${encodeURIComponent(q)}`);
    const list = await r.json();
    grid.innerHTML = '';
    if (!Array.isArray(list) || !list.length) { grid.innerHTML = '<p class="fine">No GIFs found.</p>'; return; }
    list.forEach((g) => {
      const b = document.createElement('button');
      b.className = 'memetile';
      const img = document.createElement('img');
      img.src = g.preview; img.alt = 'GIF'; img.loading = 'lazy';
      b.appendChild(img);
      b.onclick = () => { socket.emit('meme:send', { url: g.url }); closeSheets(); };
      grid.appendChild(b);
    });
  } catch {
    grid.innerHTML = '<p class="fine">GIF search failed. Try again.</p>';
  }
}
$('#gifForm').onsubmit = (e) => { e.preventDefault(); searchGifs($('#gifQuery').value.trim()); };
$('#memeBtn').onclick = () => openSheet('memeSheet');
