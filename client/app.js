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
const btnConnect = document.getElementById('btn-connect');
const codeInput = document.getElementById('code-input');
const codeDisplay = document.getElementById('code-display');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const statusEl = document.getElementById('status');

let localStream = null;
const peerConnections = new Map(); // viewerId -> RTCPeerConnection (lado host)
let hostPeerConnection = null;     // lado viewer
let hostId = null;

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
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
  } catch (err) {
    setStatus('Não foi possível capturar a tela.');
    return;
  }

  socket.emit('host:create', null, ({ code }) => {
    codeDisplay.textContent = code;
    setStatus('Aguardando espectadores entrarem com o código...');
  });

  localStream.getVideoTracks()[0].addEventListener('ended', () => {
    setStatus('Compartilhamento encerrado.');
    peerConnections.forEach((pc) => pc.close());
    peerConnections.clear();
  });
};

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

// ----- Lado VIEWER: entrar com código -----
btnConnect.onclick = () => {
  const code = codeInput.value.trim().toUpperCase();
  if (!code) return;
  socket.emit('viewer:join', code, (res) => {
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

socket.on('host:left', () => {
  setStatus('O host encerrou o compartilhamento.');
  remoteVideo.srcObject = null;
});
