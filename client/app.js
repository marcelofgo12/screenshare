// >>> Troque pela URL do seu servidor no Render depois do deploy <<<
const SIGNALING_URL = 'https://screenshare-ba36.onrender.com';

// STUN/TURN público de demonstração (Open Relay Project).
// Funciona para uso pessoal, mas tem limite de banda. Veja o passo a passo
// para trocar por credenciais próprias gratuitas se precisar de mais.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

// Limita a captura de tela a 30fps (o suficiente pra compartilhar tela e
// gasta bem menos upload/CPU do que ir sem limite, que costuma seguir a
// taxa do monitor, 60fps+).
const SCREEN_CONSTRAINTS = {
  video: { frameRate: { ideal: 30, max: 30 } },
  audio: true
};

const GOOGLE_CLIENT_ID = '1050161941044-bq1252g2hh4rdqbu92ftjtp0sn3c3cdl.apps.googleusercontent.com';

const socket = io(SIGNALING_URL);

function emitAsync(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

// ----- Avisos sonoros (gerados na hora, sem depender de nenhum arquivo externo) -----
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTone(freq, duration, delay = 0, volume = 0.15) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = volume;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime + delay;
    osc.start(t);
    osc.stop(t + duration);
  } catch (err) {
    console.error('Erro ao tocar aviso sonoro', err);
  }
}

function playJoinSound() {
  playTone(660, 0.12, 0);
  playTone(880, 0.14, 0.1);
}

function playLeaveSound() {
  playTone(660, 0.12, 0);
  playTone(415, 0.18, 0.1);
}

// ----- Elementos: navegação -----
const loginGateView = document.getElementById('login-gate');
const homeView = document.getElementById('home');
const hostView = document.getElementById('host-view');
const voiceCreateView = document.getElementById('voice-create-view');
const joinView = document.getElementById('join-view');
const viewerView = document.getElementById('viewer-view');
const voiceRoomView = document.getElementById('voice-room-view');

const btnHost = document.getElementById('btn-host');
const btnVoiceCreate = document.getElementById('btn-voice-create');
const btnJoin = document.getElementById('btn-join');
const statusEl = document.getElementById('status');

function show(view) {
  [loginGateView, homeView, hostView, voiceCreateView, joinView, viewerView, voiceRoomView].forEach((v) =>
    v.classList.add('hidden')
  );
  view.classList.remove('hidden');
}

function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.classList.remove('status-error', 'status-success');
  if (type === 'error') statusEl.classList.add('status-error');
  if (type === 'success') statusEl.classList.add('status-success');
}

// ----- Estado da conexão com o servidor (avisa se o Render "acordar" demorar) -----
let coldStartTimer = setTimeout(() => {
  setStatus('O servidor gratuito pode estar "acordando" — isso pode levar até 1 minuto na primeira vez.');
}, 4000);

socket.on('connect', () => {
  clearTimeout(coldStartTimer);
  setStatus('');
});

socket.on('connect_error', () => {
  setStatus('Não foi possível conectar ao servidor. Tentando novamente...', 'error');
});

socket.on('disconnect', () => {
  setStatus('Conexão com o servidor perdida. Tentando reconectar...', 'error');
});

// ----- Identidade da pessoa (sempre vem do login com Google, sem campo pra digitar) -----
function currentIdentity() {
  if (googleProfile) return { name: googleProfile.name, avatar: googleProfile.avatar };
  return { name: 'Convidado', avatar: null };
}

// ----- Aviso para quem está no Safari do iPhone/iPad (não suporta compartilhar tela) -----
const iosWarning = document.getElementById('ios-warning');
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
if (isIOS && !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
  iosWarning.classList.remove('hidden');
}

// ----- Ajusta o vídeo pra sempre caber na tela, sem precisar de scroll -----
function fitVideoToViewport(videoEl) {
  if (!videoEl) return;
  requestAnimationFrame(() => {
    if (videoEl.offsetParent === null) return; // está escondido agora
    const rect = videoEl.getBoundingClientRect();
    const available = window.innerHeight - rect.top - 20;
    if (available > 120) {
      videoEl.style.maxHeight = available + 'px';
    }
  });
}

function fitActiveVideos() {
  if (!viewerView.classList.contains('hidden')) fitVideoToViewport(remoteVideo);
  if (!voiceRoomView.classList.contains('hidden')) fitVideoToViewport(voiceRemoteVideo);
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitActiveVideos, 120);
});

// ----- Chat de texto — painel embutido estilo canal de texto (disponível durante -----
// ----- compartilhamento simples e sala de voz) -----
const chatPanel = document.getElementById('chat-panel');
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const btnChatMinimize = document.getElementById('btn-chat-minimize');

function showChatPanel() {
  chatPanel.classList.remove('hidden');
  chatPanel.classList.remove('minimized');
  btnChatMinimize.textContent = '－';
  document.body.classList.add('chat-active');
}

function hideChatPanel() {
  chatPanel.classList.add('hidden');
  document.body.classList.remove('chat-active');
  chatMessages.innerHTML = '';
}

btnChatMinimize.onclick = () => {
  const minimized = chatPanel.classList.toggle('minimized');
  btnChatMinimize.textContent = minimized ? '＋' : '－';
};

chatForm.onsubmit = (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat:message', { text });
  chatInput.value = '';
};

function colorFromName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 55%, 42%)`;
}

function buildAvatar(name, avatarUrl) {
  if (avatarUrl) {
    const img = document.createElement('img');
    img.className = 'chat-avatar';
    img.src = avatarUrl;
    img.referrerPolicy = 'no-referrer';
    img.alt = name;
    return img;
  }
  const div = document.createElement('div');
  div.className = 'chat-avatar chat-avatar-fallback';
  div.style.background = colorFromName(name || '');
  div.textContent = (name || '?').trim().charAt(0).toUpperCase();
  return div;
}

socket.on('chat:message', ({ from, name, avatar, text, at }) => {
  const isMine = from === socket.id;
  const displayName = isMine ? 'Você' : name;

  const row = document.createElement('div');
  row.className = 'chat-row' + (isMine ? ' mine' : '');
  row.appendChild(buildAvatar(displayName, avatar));

  const content = document.createElement('div');
  content.className = 'chat-content';

  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'chat-name';
  nameSpan.textContent = displayName;
  const timeSpan = document.createElement('span');
  timeSpan.className = 'chat-time';
  timeSpan.textContent = new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  meta.appendChild(nameSpan);
  meta.appendChild(timeSpan);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'chat-text';
  bodyEl.textContent = text;

  content.appendChild(meta);
  content.appendChild(bodyEl);
  row.appendChild(content);

  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// ----- Login com Google (Google Identity Services, sem backend próprio) -----
const googleStatusEl = document.getElementById('google-status');
const googleStatusAvatar = document.getElementById('google-status-avatar');
const googleStatusName = document.getElementById('google-status-name');
const btnGoogleLogout = document.getElementById('btn-google-logout');

const GOOGLE_PROFILE_KEY = 'screenshare_google_profile';
let googleProfile = null; // { name, avatar }

function getSavedGoogleProfile() {
  try {
    const raw = localStorage.getItem(GOOGLE_PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function saveGoogleProfile(profile) {
  try {
    localStorage.setItem(GOOGLE_PROFILE_KEY, JSON.stringify(profile));
  } catch (err) {
    // sem problema, só não lembra na próxima visita
  }
}

function clearGoogleProfile() {
  try {
    localStorage.removeItem(GOOGLE_PROFILE_KEY);
  } catch (err) {
    // ignora
  }
}

function updateGoogleStatusUI() {
  if (googleProfile) {
    googleStatusEl.classList.remove('hidden');
    googleStatusName.textContent = `Conectado como ${googleProfile.name}`;
    if (googleProfile.avatar) {
      googleStatusAvatar.src = googleProfile.avatar;
      googleStatusAvatar.classList.remove('hidden');
    } else {
      googleStatusAvatar.classList.add('hidden');
    }
  } else {
    googleStatusEl.classList.add('hidden');
  }
}

function decodeGoogleJwt(token) {
  const payload = token.split('.')[1];
  const json = decodeURIComponent(
    atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
      .split('')
      .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('')
  );
  return JSON.parse(json);
}

function handleGoogleCredential(response) {
  const payload = decodeGoogleJwt(response.credential);
  googleProfile = { name: payload.name || payload.given_name || 'Convidado', avatar: payload.picture || null };
  saveGoogleProfile(googleProfile);
  updateGoogleStatusUI();
  enterApp();
}

function setupGoogleButton() {
  const slot = document.getElementById('gate-google-btn');
  if (!slot || GOOGLE_CLIENT_ID.startsWith('SEU_CLIENT_ID')) return;
  if (!window.google || !window.google.accounts || !window.google.accounts.id) return;

  window.google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredential
  });
  window.google.accounts.id.renderButton(slot, {
    theme: 'filled_black',
    size: 'large',
    text: 'continue_with',
    shape: 'pill'
  });
}

window.addEventListener('load', setupGoogleButton);

btnGoogleLogout.onclick = () => {
  stopSharing(); // não faz nada se não houver compartilhamento ativo
  if (myId) btnVoiceLeave.onclick(); // estava numa sala de voz
  if (hostPeerConnection) btnLeaveViewer.onclick(); // estava assistindo um compartilhamento

  googleProfile = null;
  clearGoogleProfile();
  updateGoogleStatusUI();
  show(loginGateView);
};

function enterApp() {
  show(homeView);
}

// ----- Salas ativas (lobby) -----
const lobbyListEl = document.getElementById('lobby-list');
const lobbyCountEl = document.getElementById('lobby-count');
const lobbyEmptyEl = document.getElementById('lobby-empty');
const joinContextEl = document.getElementById('join-context');

function renderLobby(roomsList) {
  lobbyCountEl.textContent = roomsList.length;
  lobbyListEl.innerHTML = '';
  lobbyEmptyEl.classList.toggle('hidden', roomsList.length > 0);

  roomsList.forEach((room) => {
    const li = document.createElement('li');
    li.className = 'lobby-item';

    const icon = document.createElement('span');
    icon.className = 'lobby-icon';
    icon.textContent = room.type === 'voice' ? '🎙️' : '🖥️';

    const info = document.createElement('div');
    info.className = 'lobby-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'lobby-name';
    nameEl.textContent = room.name;
    const typeEl = document.createElement('div');
    typeEl.className = 'lobby-type';
    typeEl.textContent = room.type === 'voice' ? 'Sala de voz' : 'Compartilhamento de tela';
    info.appendChild(nameEl);
    info.appendChild(typeEl);

    li.appendChild(icon);
    li.appendChild(info);
    li.onclick = () => openJoinFromLobby(room);
    lobbyListEl.appendChild(li);
  });
}

socket.on('lobby:update', renderLobby);

function openJoinFromLobby(room) {
  joinContextEl.textContent = `Entrando em "${room.name}" (${room.type === 'voice' ? 'sala de voz' : 'compartilhamento'})`;
  joinContextEl.classList.remove('hidden');
  show(joinView);
  codeInput.focus();
}

btnHost.onclick = () => show(hostView);
btnVoiceCreate.onclick = () => show(voiceCreateView);
btnJoin.onclick = () => {
  joinContextEl.classList.add('hidden');
  joinContextEl.textContent = '';
  show(joinView);
};

document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.onclick = () => {
    stopSharing(); // não faz nada se não houver compartilhamento ativo
    show(homeView);
  };
});

// =====================================================================
// Compartilhamento simples (1 host -> N espectadores)
// =====================================================================

const roomNameInput = document.getElementById('room-name-input');
const btnStartShare = document.getElementById('btn-start-share');
const customCodeInput = document.getElementById('custom-code-input');
const codeDisplay = document.getElementById('code-display');
const localVideo = document.getElementById('local-video');
const viewerCountEl = document.getElementById('viewer-count');
const viewerListEl = document.getElementById('viewer-list');

let localStream = null;
let sharing = false;
const peerConnections = new Map(); // viewerId -> RTCPeerConnection (lado host)

function renderViewers(viewers) {
  viewerCountEl.textContent = viewers.length;
  viewerListEl.innerHTML = '';
  viewers.forEach(({ name, avatar }) => {
    const li = document.createElement('li');
    li.title = name;
    li.appendChild(buildAvatar(name, avatar));
    viewerListEl.appendChild(li);
  });
}

btnStartShare.onclick = async () => {
  if (!sharing) {
    await startSharing();
  } else {
    stopSharing();
  }
};

async function startSharing() {
  const customCode = customCodeInput.value.trim();
  const roomName = roomNameInput.value.trim();

  const result = await emitAsync('host:create', { customCode, roomName });
  if (result.error) {
    setStatus(result.error, 'error');
    return;
  }
  const code = result.code;

  try {
    localStream = await navigator.mediaDevices.getDisplayMedia(SCREEN_CONSTRAINTS);
    localVideo.srcObject = localStream;
  } catch (err) {
    socket.emit('host:stop');
    setStatus('Não foi possível capturar a tela.', 'error');
    return;
  }

  codeDisplay.textContent = code;
  setStatus('Aguardando espectadores entrarem com o código...');

  sharing = true;
  btnStartShare.textContent = '⏹️ Parar compartilhamento';
  btnStartShare.classList.add('btn-stop');
  customCodeInput.disabled = true;
  roomNameInput.disabled = true;
  renderViewers([]);
  showChatPanel();

  localStream.getVideoTracks()[0].addEventListener('ended', () => {
    // usuário parou pela barra nativa do navegador, não pelo nosso botão
    stopSharing();
  });
}

function stopSharing() {
  if (!sharing) return;
  sharing = false;

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;

  peerConnections.forEach((pc) => pc.close());
  peerConnections.clear();

  socket.emit('host:stop');

  codeDisplay.textContent = '------';
  renderViewers([]);
  btnStartShare.textContent = '🖥️ Iniciar compartilhamento';
  btnStartShare.classList.remove('btn-stop');
  customCodeInput.disabled = false;
  roomNameInput.disabled = false;
  setStatus('Compartilhamento encerrado.');
  hideChatPanel();
}

// ----- Lado HOST: cria (ou recria) a conexão com um espectador -----
async function createHostConnectionForViewer(viewerId) {
  const existingPc = peerConnections.get(viewerId);
  if (existingPc) existingPc.close();

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections.set(viewerId, pc);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal:ice', { to: viewerId, candidate: e.candidate });
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal:offer', { to: viewerId, offer });
}

socket.on('viewer:new', ({ viewerId }) => {
  playJoinSound();
  setStatus('Espectador conectado.', 'success');
  createHostConnectionForViewer(viewerId);
});

// espectador clicou em "Reconectar": refaz a conexão sem soar como uma entrada nova
socket.on('viewer:reconnect-request', ({ viewerId }) => {
  setStatus('Reconectando espectador...');
  createHostConnectionForViewer(viewerId);
});

socket.on('signal:answer', async ({ from, answer }) => {
  const pc = peerConnections.get(from);
  if (pc) await pc.setRemoteDescription(answer);
});

socket.on('viewer:left', ({ viewerId }) => {
  playLeaveSound();
  const pc = peerConnections.get(viewerId);
  if (pc) {
    pc.close();
    peerConnections.delete(viewerId);
  }
});

socket.on('viewers:update', (viewers) => {
  renderViewers(viewers);
});

// =====================================================================
// Entrada unificada por código (o servidor decide o tipo de sala)
// =====================================================================

const btnConnect = document.getElementById('btn-connect');
const codeInput = document.getElementById('code-input');

btnConnect.onclick = async () => {
  const code = codeInput.value.trim().toUpperCase();
  if (!code) return;
  const { name, avatar } = currentIdentity();

  const result = await emitAsync('room:join', { code, name, avatar });
  if (result.error) {
    setStatus(result.error, 'error');
    return;
  }

  if (result.type === 'share') {
    show(viewerView);
    setStatus('Conectado. Aguardando vídeo...', 'success');
    showChatPanel();
  } else if (result.type === 'voice') {
    show(voiceRoomView);
    await enterVoiceRoom(code, name, avatar, result.id, result.participants, result.sharerId, result.roomName);
    showChatPanel();
  }
};

// =====================================================================
// Lado ESPECTADOR do compartilhamento simples
// =====================================================================

const remoteVideo = document.getElementById('remote-video');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnReconnect = document.getElementById('btn-reconnect');
const btnLeaveViewer = document.getElementById('btn-leave-viewer');
let hostId = null;
let hostPeerConnection = null;

btnLeaveViewer.onclick = () => {
  if (hostPeerConnection) {
    hostPeerConnection.close();
    hostPeerConnection = null;
  }
  remoteVideo.srcObject = null;
  document.body.classList.remove('watching');
  btnFullscreen.classList.add('hidden');
  socket.emit('viewer:leave');
  hostId = null;
  setStatus('');
  hideChatPanel();
  show(homeView);
};

socket.on('signal:offer', async ({ from, offer }) => {
  if (hostPeerConnection) hostPeerConnection.close();
  hostId = from;
  hostPeerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  hostPeerConnection.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    document.body.classList.add('watching');
    btnFullscreen.classList.remove('hidden');
    setStatus('Recebendo transmissão.', 'success');
    fitVideoToViewport(remoteVideo);
  };

  hostPeerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal:ice', { to: hostId, candidate: e.candidate });
    }
  };

  await hostPeerConnection.setRemoteDescription(offer);
  const answer = await hostPeerConnection.createAnswer();
  await hostPeerConnection.setLocalDescription(answer);
  socket.emit('signal:answer', { to: hostId, answer });
});

socket.on('signal:ice', async ({ from, candidate }) => {
  const pc = peerConnections.get(from) || (from === hostId ? hostPeerConnection : null);
  if (pc) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      console.error('Erro ao adicionar ICE candidate', err);
    }
  }
});

btnFullscreen.onclick = () => {
  if (remoteVideo.requestFullscreen) {
    remoteVideo.requestFullscreen();
  } else if (remoteVideo.webkitRequestFullscreen) {
    remoteVideo.webkitRequestFullscreen();
  }
};

btnReconnect.onclick = () => {
  if (hostPeerConnection) {
    hostPeerConnection.close();
    hostPeerConnection = null;
  }
  remoteVideo.srcObject = null;
  document.body.classList.remove('watching');
  btnFullscreen.classList.add('hidden');
  setStatus('Reconectando...');
  socket.emit('viewer:reconnect');
};

socket.on('host:left', () => {
  setStatus('O host encerrou o compartilhamento.', 'error');
  remoteVideo.srcObject = null;
  document.body.classList.remove('watching');
  btnFullscreen.classList.add('hidden');
  hideChatPanel();
});

// =====================================================================
// Sala de voz (mesh N-a-N) com compartilhamento de tela opcional,
// limitado a 1 pessoa por vez (a segunda que iniciar assume e derruba
// a anterior).
// =====================================================================

const voiceRoomNameInput = document.getElementById('voice-room-name-input');
const voiceCustomCodeInput = document.getElementById('voice-custom-code-input');
const btnVoiceCreateConfirm = document.getElementById('btn-voice-create-confirm');
const voiceRoomNameDisplay = document.getElementById('voice-room-name-display');
const voiceCodeDisplay = document.getElementById('voice-code-display');
const voiceParticipantCountEl = document.getElementById('voice-participant-count');
const voiceParticipantListEl = document.getElementById('voice-participant-list');
const btnMicToggle = document.getElementById('btn-mic-toggle');
const btnVoiceShare = document.getElementById('btn-voice-share');
const btnVoiceLeave = document.getElementById('btn-voice-leave');
const voiceVideoWrap = document.getElementById('voice-video-wrap');
const voiceRemoteVideo = document.getElementById('voice-remote-video');
const btnVoiceFullscreen = document.getElementById('btn-voice-fullscreen');
const btnVoiceReconnect = document.getElementById('btn-voice-reconnect');
const remoteAudioContainer = document.getElementById('remote-audio-container');

let myId = null;
let micStream = null;
let micMuted = false;
let screenStream = null;
let isVoiceSharer = false;
let currentSharerId = null;
const voicePeers = new Map(); // peerId -> { name, pc }
const pendingNames = new Map(); // peerId -> name (de quem ainda não tem pc)

// ----- Indicador de "quem está falando" (analisa o volume de cada stream de áudio) -----
const speakingAnalysers = new Map(); // peerId -> { analyser, data }
let speakingIds = new Set();
let speakingInterval = null;

function attachSpeakingAnalyser(peerId, stream) {
  try {
    const ctx = getAudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    speakingAnalysers.set(peerId, { analyser, data: new Uint8Array(analyser.frequencyBinCount) });
  } catch (err) {
    console.error('Erro ao analisar volume do áudio', err);
  }
}

function startSpeakingLoop() {
  if (speakingInterval) return;
  speakingInterval = setInterval(() => {
    const next = new Set();
    speakingAnalysers.forEach(({ analyser, data }, peerId) => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      if (Math.sqrt(sum / data.length) > 0.04) next.add(peerId);
    });

    const changed = next.size !== speakingIds.size || [...next].some((id) => !speakingIds.has(id));
    if (changed) {
      speakingIds = next;
      renderVoiceParticipants(lastParticipants);
    }
  }, 200);
}

function stopSpeakingLoop() {
  if (speakingInterval) {
    clearInterval(speakingInterval);
    speakingInterval = null;
  }
  speakingAnalysers.clear();
  speakingIds = new Set();
}

btnVoiceCreateConfirm.onclick = async () => {
  const customCode = voiceCustomCodeInput.value.trim();
  const roomName = voiceRoomNameInput.value.trim();
  const { name, avatar } = currentIdentity();

  const result = await emitAsync('voice:create', { customCode, roomName, name, avatar });
  if (result.error) {
    setStatus(result.error, 'error');
    return;
  }

  show(voiceRoomView);
  await enterVoiceRoom(result.code, name, avatar, result.id, [], null, result.roomName);
  showChatPanel();
};

async function enterVoiceRoom(code, myName, myAvatar, id, participants, sharerId, roomName) {
  myId = id;
  currentSharerId = sharerId;
  isVoiceSharer = false;
  micMuted = false;
  voicePeers.clear();
  pendingNames.clear();
  remoteAudioContainer.innerHTML = '';
  voiceVideoWrap.classList.add('hidden');
  btnVoiceFullscreen.classList.add('hidden');
  btnMicToggle.textContent = '🎙️ Mutar microfone';
  btnMicToggle.classList.remove('btn-stop');
  updateShareButton();

  voiceRoomNameDisplay.textContent = roomName || 'Sala de voz';
  voiceCodeDisplay.textContent = code;
  renderVoiceParticipants([{ id: myId, name: myName, avatar: myAvatar }, ...participants]);
  setStatus('Conectando ao microfone...');
  stopSpeakingLoop();

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus('Não foi possível acessar o microfone.', 'error');
    return;
  }

  attachSpeakingAnalyser(myId, micStream);
  startSpeakingLoop();

  participants.forEach(({ id: peerId, name }) => {
    const pc = createVoicePeerConnection(peerId);
    voicePeers.set(peerId, { name, pc });
  });

  setStatus('Conectado à sala de voz.', 'success');
}

function createVoicePeerConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));
  if (isVoiceSharer && screenStream) {
    screenStream.getTracks().forEach((track) => pc.addTrack(track, screenStream));
  }

  pc.ontrack = (e) => {
    if (e.track.kind === 'audio') {
      let audioEl = document.getElementById('audio-' + peerId);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = 'audio-' + peerId;
        audioEl.autoplay = true;
        remoteAudioContainer.appendChild(audioEl);
      }
      audioEl.srcObject = e.streams[0];
      attachSpeakingAnalyser(peerId, e.streams[0]);
    } else if (e.track.kind === 'video') {
      voiceRemoteVideo.srcObject = e.streams[0];
      voiceVideoWrap.classList.remove('hidden');
      btnVoiceFullscreen.classList.remove('hidden');
      document.body.classList.add('watching');
      fitVideoToViewport(voiceRemoteVideo);
      e.track.addEventListener('ended', () => {
        if (currentSharerId === peerId) clearVoiceVideo();
      });
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('vsignal:ice', { to: peerId, candidate: e.candidate });
    }
  };

  pc.onnegotiationneeded = async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('vsignal:offer', { to: peerId, offer });
    } catch (err) {
      console.error('Erro ao renegociar conexão de voz', err);
    }
  };

  return pc;
}

socket.on('voice:participant-joined', ({ id, name }) => {
  playJoinSound();
  pendingNames.set(id, name);
});

socket.on('vsignal:reconnect-request', ({ from }) => {
  // só quem está compartilhando a tela deve responder; se essa mensagem
  // chegou aqui é porque quem pediu identificou este cliente como o dono
  // atual do compartilhamento.
  const oldEntry = voicePeers.get(from);
  if (oldEntry) {
    oldEntry.pc.close();
    voicePeers.delete(from);
  }
  const pc = createVoicePeerConnection(from);
  voicePeers.set(from, { name: pendingNames.get(from) || 'Convidado', pc });
});

socket.on('vsignal:offer', async ({ from, offer }) => {
  let entry = voicePeers.get(from);
  if (!entry) {
    const name = pendingNames.get(from) || 'Convidado';
    const pc = createVoicePeerConnection(from);
    entry = { name, pc };
    voicePeers.set(from, entry);
  }
  await entry.pc.setRemoteDescription(offer);
  const answer = await entry.pc.createAnswer();
  await entry.pc.setLocalDescription(answer);
  socket.emit('vsignal:answer', { to: from, answer });
});

socket.on('vsignal:answer', async ({ from, answer }) => {
  const entry = voicePeers.get(from);
  if (entry) await entry.pc.setRemoteDescription(answer);
});

socket.on('vsignal:ice', async ({ from, candidate }) => {
  const entry = voicePeers.get(from);
  if (entry) {
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch (err) {
      console.error('Erro ao adicionar ICE candidate (voz)', err);
    }
  }
});

socket.on('voice:participant-left', ({ id }) => {
  playLeaveSound();
  const entry = voicePeers.get(id);
  if (entry) {
    entry.pc.close();
    voicePeers.delete(id);
  }
  const audioEl = document.getElementById('audio-' + id);
  if (audioEl) audioEl.remove();
  pendingNames.delete(id);
  speakingAnalysers.delete(id);
});

socket.on('voice:participants-update', ({ participants, sharerId }) => {
  currentSharerId = sharerId;
  renderVoiceParticipants(participants);
});

let lastParticipants = [];

function renderVoiceParticipants(participants) {
  lastParticipants = participants;
  voiceParticipantCountEl.textContent = participants.length;
  voiceParticipantListEl.innerHTML = '';
  participants.forEach(({ id, name, avatar }) => {
    const li = document.createElement('li');
    const label = id === myId ? `${name} (você)` : name;
    li.title = id === currentSharerId ? `🖥️ ${label} (compartilhando)` : label;
    li.appendChild(buildAvatar(name, avatar));
    li.classList.toggle('speaking', speakingIds.has(id));
    voiceParticipantListEl.appendChild(li);
  });
}

btnMicToggle.onclick = () => {
  if (!micStream) return;
  micMuted = !micMuted;
  micStream.getAudioTracks().forEach((track) => {
    track.enabled = !micMuted;
  });
  btnMicToggle.textContent = micMuted ? '🔇 Ativar microfone' : '🎙️ Mutar microfone';
  btnMicToggle.classList.toggle('btn-stop', micMuted);
};

btnVoiceShare.onclick = async () => {
  if (!isVoiceSharer) {
    await startVoiceShare();
  } else {
    stopVoiceShare();
  }
};

async function startVoiceShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(SCREEN_CONSTRAINTS);
  } catch (err) {
    setStatus('Não foi possível capturar a tela.', 'error');
    return;
  }

  const result = await emitAsync('voice:share-start', null);
  if (result.error) {
    stream.getTracks().forEach((track) => track.stop());
    setStatus(result.error, 'error');
    return;
  }

  screenStream = stream;
  isVoiceSharer = true;
  currentSharerId = myId;
  renderVoiceParticipants(lastParticipants);

  voicePeers.forEach(({ pc }) => {
    screenStream.getTracks().forEach((track) => pc.addTrack(track, screenStream));
  });

  voiceRemoteVideo.srcObject = screenStream;
  voiceVideoWrap.classList.remove('hidden');
  btnVoiceFullscreen.classList.remove('hidden');
  document.body.classList.add('watching');
  fitVideoToViewport(voiceRemoteVideo);
  updateShareButton();
  setStatus('Compartilhando sua tela para a sala.');

  screenStream.getVideoTracks()[0].addEventListener('ended', () => {
    stopVoiceShare();
  });
}

function stopVoiceShare() {
  if (!isVoiceSharer) return;
  isVoiceSharer = false;

  if (screenStream) {
    screenStream.getTracks().forEach((track) => {
      voicePeers.forEach(({ pc }) => {
        const sender = pc.getSenders().find((s) => s.track === track);
        if (sender) pc.removeTrack(sender);
      });
      track.stop();
    });
    screenStream = null;
  }

  socket.emit('voice:share-stop');
  clearVoiceVideo();
  updateShareButton();
  setStatus('Você parou de compartilhar a tela.');
}

function clearVoiceVideo() {
  voiceRemoteVideo.srcObject = null;
  voiceVideoWrap.classList.add('hidden');
  btnVoiceFullscreen.classList.add('hidden');
  document.body.classList.remove('watching');
  currentSharerId = null;
  renderVoiceParticipants(lastParticipants);
}

function updateShareButton() {
  if (isVoiceSharer) {
    btnVoiceShare.textContent = '⏹️ Parar compartilhamento';
    btnVoiceShare.classList.add('btn-stop');
  } else {
    btnVoiceShare.textContent = '🖥️ Compartilhar minha tela';
    btnVoiceShare.classList.remove('btn-stop');
  }
}

socket.on('voice:share-started', ({ sharerId }) => {
  if (sharerId === myId) {
    currentSharerId = sharerId;
    return;
  }
  if (isVoiceSharer) stopVoiceShare();
  currentSharerId = sharerId;
  renderVoiceParticipants(lastParticipants);
  setStatus('Alguém está compartilhando a tela.');
});

socket.on('voice:share-stopped', () => {
  if (!isVoiceSharer) clearVoiceVideo();
  setStatus('Compartilhamento de tela encerrado.');
});

btnVoiceFullscreen.onclick = () => {
  if (voiceRemoteVideo.requestFullscreen) {
    voiceRemoteVideo.requestFullscreen();
  } else if (voiceRemoteVideo.webkitRequestFullscreen) {
    voiceRemoteVideo.webkitRequestFullscreen();
  }
};

btnVoiceReconnect.onclick = () => {
  if (!currentSharerId || currentSharerId === myId) return; // sou eu que compartilho, nada a reconectar

  const entry = voicePeers.get(currentSharerId);
  if (entry) {
    entry.pc.close();
    voicePeers.delete(currentSharerId);
  }
  voiceRemoteVideo.srcObject = null;
  setStatus('Reconectando à transmissão...');
  socket.emit('vsignal:reconnect-request', { to: currentSharerId });
};

btnVoiceLeave.onclick = () => {
  stopVoiceShare();
  clearVoiceVideo();
  stopSpeakingLoop();

  voicePeers.forEach(({ pc }) => pc.close());
  voicePeers.clear();
  pendingNames.clear();
  remoteAudioContainer.innerHTML = '';

  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }

  socket.emit('voice:leave');
  myId = null;
  currentSharerId = null;
  setStatus('');
  hideChatPanel();
  show(homeView);
};

// =====================================================================
// Inicialização: decide se mostra o portão de login ou vai direto pra home
// =====================================================================

(function initApp() {
  const stored = getSavedGoogleProfile();
  if (stored) {
    googleProfile = stored;
    updateGoogleStatusUI();
    enterApp();
  } else if (GOOGLE_CLIENT_ID.startsWith('SEU_CLIENT_ID')) {
    // sem Client ID configurado ainda: nao trava o uso do app
    enterApp();
  } else {
    show(loginGateView);
  }
})();
