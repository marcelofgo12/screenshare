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

const socket = io(SIGNALING_URL);

function emitAsync(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

// ----- Elementos: navegação -----
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
  [homeView, hostView, voiceCreateView, joinView, viewerView, voiceRoomView].forEach((v) =>
    v.classList.add('hidden')
  );
  view.classList.remove('hidden');
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

btnHost.onclick = () => show(hostView);
btnVoiceCreate.onclick = () => show(voiceCreateView);
btnJoin.onclick = () => show(joinView);

// =====================================================================
// Compartilhamento simples (1 host -> N espectadores)
// =====================================================================

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
  viewers.forEach(({ name }) => {
    const li = document.createElement('li');
    li.textContent = name;
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

  const result = await emitAsync('host:create', { customCode });
  if (result.error) {
    setStatus(result.error);
    return;
  }
  const code = result.code;

  try {
    localStream = await navigator.mediaDevices.getDisplayMedia(SCREEN_CONSTRAINTS);
    localVideo.srcObject = localStream;
  } catch (err) {
    socket.emit('host:stop');
    setStatus('Não foi possível capturar a tela.');
    return;
  }

  codeDisplay.textContent = code;
  setStatus('Aguardando espectadores entrarem com o código...');

  sharing = true;
  btnStartShare.textContent = 'Parar compartilhamento';
  btnStartShare.classList.add('btn-stop');
  customCodeInput.disabled = true;
  renderViewers([]);

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
  btnStartShare.textContent = 'Iniciar compartilhamento';
  btnStartShare.classList.remove('btn-stop');
  customCodeInput.disabled = false;
  setStatus('Compartilhamento encerrado.');
}

// ----- Lado HOST: um novo espectador entrou -----
socket.on('viewer:new', async ({ viewerId }) => {
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
  setStatus('Espectador conectado.');
});

socket.on('signal:answer', async ({ from, answer }) => {
  const pc = peerConnections.get(from);
  if (pc) await pc.setRemoteDescription(answer);
});

socket.on('viewer:left', ({ viewerId }) => {
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
const nameInput = document.getElementById('name-input');
const codeInput = document.getElementById('code-input');

btnConnect.onclick = async () => {
  const code = codeInput.value.trim().toUpperCase();
  const name = nameInput.value.trim() || 'Convidado';
  if (!code) return;

  const result = await emitAsync('room:join', { code, name });
  if (result.error) {
    setStatus(result.error);
    return;
  }

  if (result.type === 'share') {
    show(viewerView);
    setStatus('Conectado. Aguardando vídeo...');
  } else if (result.type === 'voice') {
    show(voiceRoomView);
    await enterVoiceRoom(code, name, result.id, result.participants, result.sharerId);
  }
};

// =====================================================================
// Lado ESPECTADOR do compartilhamento simples
// =====================================================================

const remoteVideo = document.getElementById('remote-video');
const btnFullscreen = document.getElementById('btn-fullscreen');
let hostId = null;
let hostPeerConnection = null;

socket.on('signal:offer', async ({ from, offer }) => {
  hostId = from;
  hostPeerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  hostPeerConnection.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    document.body.classList.add('watching');
    btnFullscreen.classList.remove('hidden');
    setStatus('Recebendo transmissão.');
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

socket.on('host:left', () => {
  setStatus('O host encerrou o compartilhamento.');
  remoteVideo.srcObject = null;
  document.body.classList.remove('watching');
  btnFullscreen.classList.add('hidden');
});

// =====================================================================
// Sala de voz (mesh N-a-N) com compartilhamento de tela opcional,
// limitado a 1 pessoa por vez (a segunda que iniciar assume e derruba
// a anterior).
// =====================================================================

const voiceNameInput = document.getElementById('voice-name-input');
const voiceCustomCodeInput = document.getElementById('voice-custom-code-input');
const btnVoiceCreateConfirm = document.getElementById('btn-voice-create-confirm');
const voiceCodeDisplay = document.getElementById('voice-code-display');
const voiceParticipantCountEl = document.getElementById('voice-participant-count');
const voiceParticipantListEl = document.getElementById('voice-participant-list');
const btnMicToggle = document.getElementById('btn-mic-toggle');
const btnVoiceShare = document.getElementById('btn-voice-share');
const btnVoiceLeave = document.getElementById('btn-voice-leave');
const voiceVideoWrap = document.getElementById('voice-video-wrap');
const voiceRemoteVideo = document.getElementById('voice-remote-video');
const btnVoiceFullscreen = document.getElementById('btn-voice-fullscreen');
const remoteAudioContainer = document.getElementById('remote-audio-container');

let myId = null;
let micStream = null;
let micMuted = false;
let screenStream = null;
let isVoiceSharer = false;
let currentSharerId = null;
const voicePeers = new Map(); // peerId -> { name, pc }
const pendingNames = new Map(); // peerId -> name (de quem ainda não tem pc)

btnVoiceCreateConfirm.onclick = async () => {
  const name = voiceNameInput.value.trim() || 'Convidado';
  const customCode = voiceCustomCodeInput.value.trim();

  const result = await emitAsync('voice:create', { customCode, name });
  if (result.error) {
    setStatus(result.error);
    return;
  }

  show(voiceRoomView);
  await enterVoiceRoom(result.code, name, result.id, [], null);
};

async function enterVoiceRoom(code, myName, id, participants, sharerId) {
  myId = id;
  currentSharerId = sharerId;
  isVoiceSharer = false;
  micMuted = false;
  voicePeers.clear();
  pendingNames.clear();
  remoteAudioContainer.innerHTML = '';
  voiceVideoWrap.classList.add('hidden');
  btnVoiceFullscreen.classList.add('hidden');
  btnMicToggle.textContent = 'Mutar microfone';
  btnMicToggle.classList.remove('btn-stop');
  updateShareButton();

  voiceCodeDisplay.textContent = code;
  renderVoiceParticipants([{ id: myId, name: myName }, ...participants]);
  setStatus('Conectando ao microfone...');

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus('Não foi possível acessar o microfone.');
    return;
  }

  participants.forEach(({ id: peerId, name }) => {
    const pc = createVoicePeerConnection(peerId);
    voicePeers.set(peerId, { name, pc });
  });

  setStatus('Conectado à sala de voz.');
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
    } else if (e.track.kind === 'video') {
      voiceRemoteVideo.srcObject = e.streams[0];
      voiceVideoWrap.classList.remove('hidden');
      btnVoiceFullscreen.classList.remove('hidden');
      document.body.classList.add('watching');
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
  pendingNames.set(id, name);
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
  const entry = voicePeers.get(id);
  if (entry) {
    entry.pc.close();
    voicePeers.delete(id);
  }
  const audioEl = document.getElementById('audio-' + id);
  if (audioEl) audioEl.remove();
  pendingNames.delete(id);
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
  participants.forEach(({ id, name }) => {
    const li = document.createElement('li');
    const label = id === myId ? `${name} (você)` : name;
    li.textContent = id === currentSharerId ? `🖥️ ${label}` : label;
    voiceParticipantListEl.appendChild(li);
  });
}

btnMicToggle.onclick = () => {
  if (!micStream) return;
  micMuted = !micMuted;
  micStream.getAudioTracks().forEach((track) => {
    track.enabled = !micMuted;
  });
  btnMicToggle.textContent = micMuted ? 'Ativar microfone' : 'Mutar microfone';
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
    setStatus('Não foi possível capturar a tela.');
    return;
  }

  const result = await emitAsync('voice:share-start', null);
  if (result.error) {
    stream.getTracks().forEach((track) => track.stop());
    setStatus(result.error);
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
    btnVoiceShare.textContent = 'Parar compartilhamento';
    btnVoiceShare.classList.add('btn-stop');
  } else {
    btnVoiceShare.textContent = 'Compartilhar minha tela';
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

btnVoiceLeave.onclick = () => {
  stopVoiceShare();
  clearVoiceVideo();

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
  show(homeView);
};
