const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Signaling server ativo'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// code -> room
// share: { type: 'share', hostId, viewers: Map<socketId, name> }
// voice: { type: 'voice', participants: Map<socketId, name>, sharerId: string|null }
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function resolveCode(customCode) {
  const requested = (customCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (requested) {
    if (requested.length < 4 || requested.length > 12) {
      return { error: 'O código deve ter entre 4 e 12 letras/números.' };
    }
    if (rooms.has(requested)) {
      return { error: 'Esse código já está em uso.' };
    }
    return { code: requested };
  }
  return { code: generateCode() };
}

function broadcastShareViewers(room) {
  const viewers = Array.from(room.viewers, ([id, name]) => ({ id, name }));
  io.to(room.hostId).emit('viewers:update', viewers);
}

function broadcastVoiceParticipants(code, room) {
  const participants = Array.from(room.participants, ([id, name]) => ({ id, name }));
  io.to(code).emit('voice:participants-update', { participants, sharerId: room.sharerId });
}

function leaveVoiceRoom(socket) {
  const code = socket.data.code;
  const room = rooms.get(code);
  if (!room || room.type !== 'voice') return;

  room.participants.delete(socket.id);
  const wasSharer = room.sharerId === socket.id;
  if (wasSharer) room.sharerId = null;

  socket.leave(code);
  socket.data.role = null;
  socket.data.code = null;

  if (room.participants.size === 0) {
    rooms.delete(code);
  } else {
    socket.to(code).emit('voice:participant-left', { id: socket.id });
    if (wasSharer) io.to(code).emit('voice:share-stopped');
    broadcastVoiceParticipants(code, room);
  }
}

io.on('connection', (socket) => {
  // ---- Compartilhamento simples (host/espectadores) ----
  socket.on('host:create', (payload, cb) => {
    const result = resolveCode(payload && payload.customCode);
    if (result.error) {
      cb({ error: result.error });
      return;
    }
    const code = result.code;
    rooms.set(code, { type: 'share', hostId: socket.id, viewers: new Map() });
    socket.data.role = 'host';
    socket.data.code = code;
    socket.join(code);
    cb({ code });
  });

  socket.on('host:stop', () => {
    if (socket.data.role !== 'host' || !socket.data.code) return;
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || room.type !== 'share') return;
    io.to(code).emit('host:left');
    rooms.delete(code);
    socket.leave(code);
    socket.data.role = null;
    socket.data.code = null;
  });

  // ---- Sala de voz (mesh, qualquer participante pode compartilhar tela) ----
  socket.on('voice:create', (payload, cb) => {
    const result = resolveCode(payload && payload.customCode);
    if (result.error) {
      cb({ error: result.error });
      return;
    }
    const code = result.code;
    const name = ((payload && payload.name) || '').trim().slice(0, 30) || 'Convidado';
    rooms.set(code, { type: 'voice', participants: new Map([[socket.id, name]]), sharerId: null });
    socket.data.role = 'voice';
    socket.data.code = code;
    socket.join(code);
    cb({ code, id: socket.id });
  });

  socket.on('voice:share-start', (_payload, cb) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || room.type !== 'voice') {
      if (cb) cb({ error: 'Sala inválida.' });
      return;
    }
    room.sharerId = socket.id;
    io.to(code).emit('voice:share-started', { sharerId: socket.id });
    if (cb) cb({ ok: true });
  });

  socket.on('voice:share-stop', () => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || room.type !== 'voice') return;
    if (room.sharerId !== socket.id) return;
    room.sharerId = null;
    io.to(code).emit('voice:share-stopped');
  });

  socket.on('voice:leave', () => leaveVoiceRoom(socket));

  socket.on('viewer:leave', () => {
    if (socket.data.role !== 'viewer' || !socket.data.code) return;
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room || room.type !== 'share') return;
    room.viewers.delete(socket.id);
    socket.leave(code);
    socket.data.role = null;
    socket.data.code = null;
    io.to(room.hostId).emit('viewer:left', { viewerId: socket.id });
    broadcastShareViewers(room);
  });

  socket.on('viewer:reconnect', () => {
    if (socket.data.role !== 'viewer' || !socket.data.code) return;
    const room = rooms.get(socket.data.code);
    if (!room || room.type !== 'share') return;
    io.to(room.hostId).emit('viewer:reconnect-request', { viewerId: socket.id });
  });

  socket.on('vsignal:reconnect-request', ({ to }) => {
    io.to(to).emit('vsignal:reconnect-request', { from: socket.id });
  });

  // ---- Entrada unificada: cliente so sabe o codigo, servidor decide o tipo ----
  socket.on('room:join', ({ code, name }, cb) => {
    const room = rooms.get(code);
    if (!room) {
      cb({ error: 'Codigo invalido ou sala encerrada.' });
      return;
    }

    if (room.type === 'share') {
      const viewerName = (name || '').trim().slice(0, 30) || 'Convidado';
      room.viewers.set(socket.id, viewerName);
      socket.data.role = 'viewer';
      socket.data.code = code;
      socket.join(code);
      cb({ ok: true, type: 'share' });
      io.to(room.hostId).emit('viewer:new', { viewerId: socket.id, name: viewerName });
      broadcastShareViewers(room);
      return;
    }

    if (room.type === 'voice') {
      const participantName = (name || '').trim().slice(0, 30) || 'Convidado';
      const existing = Array.from(room.participants, ([id, n]) => ({ id, name: n }));
      room.participants.set(socket.id, participantName);
      socket.data.role = 'voice';
      socket.data.code = code;
      socket.join(code);
      cb({ ok: true, type: 'voice', id: socket.id, participants: existing, sharerId: room.sharerId });
      socket.to(code).emit('voice:participant-joined', { id: socket.id, name: participantName });
      broadcastVoiceParticipants(code, room);
    }
  });

  // ---- Chat de texto (funciona tanto no compartilhamento simples quanto na sala de voz) ----
  socket.on('chat:message', ({ text }) => {
    const code = socket.data.code;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const trimmed = (text || '').trim().slice(0, 500);
    if (!trimmed) return;

    let name = 'Convidado';
    if (room.type === 'share') {
      name = room.hostId === socket.id ? 'Host' : room.viewers.get(socket.id) || 'Convidado';
    } else if (room.type === 'voice') {
      name = room.participants.get(socket.id) || 'Convidado';
    }

    io.to(code).emit('chat:message', { from: socket.id, name, text: trimmed, at: Date.now() });
  });

  // ---- Sinalizacao WebRTC do compartilhamento simples (1 host -> N espectadores) ----
  socket.on('signal:offer', ({ to, offer }) => {
    io.to(to).emit('signal:offer', { from: socket.id, offer });
  });

  socket.on('signal:answer', ({ to, answer }) => {
    io.to(to).emit('signal:answer', { from: socket.id, answer });
  });

  socket.on('signal:ice', ({ to, candidate }) => {
    io.to(to).emit('signal:ice', { from: socket.id, candidate });
  });

  // ---- Sinalizacao WebRTC da sala de voz (mesh N-a-N) ----
  socket.on('vsignal:offer', ({ to, offer }) => {
    io.to(to).emit('vsignal:offer', { from: socket.id, offer });
  });

  socket.on('vsignal:answer', ({ to, answer }) => {
    io.to(to).emit('vsignal:answer', { from: socket.id, answer });
  });

  socket.on('vsignal:ice', ({ to, candidate }) => {
    io.to(to).emit('vsignal:ice', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    const { role, code } = socket.data;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (room.type === 'share') {
      if (role === 'host') {
        io.to(code).emit('host:left');
        rooms.delete(code);
      } else if (role === 'viewer') {
        room.viewers.delete(socket.id);
        io.to(room.hostId).emit('viewer:left', { viewerId: socket.id });
        broadcastShareViewers(room);
      }
    } else if (room.type === 'voice') {
      leaveVoiceRoom(socket);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Signaling server rodando na porta ${PORT}`));
