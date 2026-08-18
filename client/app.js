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

const socket = io(SIGNALING_URL);

const homeView = document.getElementById('home');
const hostView = document.getElementById('host-view');
const viewerView = document.getElementById('viewer-view');

const btnHost = document.getElementById('btn-host');
const btnJoin = document.getElementById('btn-join');
const btnStartShare = document.getElementById('btn-start-share');
const customCodeInput = document.getElementById('custom-code-input');
const btnConnect = document.getElementById('btn-connect');
const nameInput = document.getElementById('name-input');
const codeInput = document.getElementById('code-input');
const codeDisplay = document.getElementById('code-display');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const btnFullscreen = document.getElementById('btn-fullscreen');
const viewerCountEl = document.getElementById('viewer-count');
const viewerListEl = document.getElementById('viewer-list');
const statusEl = document.getElementById('status');

let localStream = null;
let sharing = false;
const peerConnections = new Map(); // viewerId -> RTCPeerConnection (lado host)
let hostPeerConnection = null;     // lado viewer
let hostId = null;

function renderViewers(viewers) {
  viewerCountEl.textContent = viewers.length;
  viewerListEl.innerHTML = '';
  viewers.forEach(({ name }) => {
    const li = document.createElement('li');
    li.textContent = name;
    viewerListEl.appendChild(li);
  });
}

function show(view) {
  [homeView, hostView, viewerView].forEach((v) => v.classList.add('hidden'));
  view.classList.remove('hidden');
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

btnHost.onclick = () => show(hostView);
btnJoin.onclick = () => show(viewerView);

btnStartShare.onclick = async () => {
  if (!sharing) {
    await startSharing();
  } else {
    stopSharing();
  }
};

async function startSharing() {
  const customCode = customCodeInput.value.trim();

  const result = await new Promise((resolve) => {
    socket.emit('host:create', { customCode }, resolve);
  });

  if (result.error) {
    setStatus(result.error);
    return;
  }
  const code = result.code;

  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
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

// ----- Lado VIEWER: entrar com código -----
btnConnect.onclick = () => {
  const code = codeInput.value.trim().toUpperCase();
  const name = nameInput.value.trim() || 'Convidado';
  if (!code) return;
  socket.emit('viewer:join', { code, name }, (res) => {
    if (res.error) {
      setStatus(res.error);
    } else {
      setStatus('Conectado. Aguardando vídeo...');
    }
  });
};

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

// ----- ICE candidates (ambos os lados) -----
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
