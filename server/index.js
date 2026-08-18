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

// code -> { hostId, viewers: Map<socketId, name> }
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function broadcastViewers(room) {
  const viewers = Array.from(room.viewers, ([id, name]) => ({ id, name }));
  io.to(room.hostId).emit('viewers:update', viewers);
}

io.on('connection', (socket) => {
  socket.on('host:create', (payload, cb) => {
    const requested = (payload && payload.customCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

    let code;
    if (requested) {
      if (requested.length < 4 || requested.length > 12) {
        cb({ error: 'O código deve ter entre 4 e 12 letras/números.' });
        return;
      }
      if (rooms.has(requested)) {
        cb({ error: 'Esse código já está em uso.' });
        return;
      }
      code = requested;
    } else {
      code = generateCode();
    }

    rooms.set(code, { hostId: socket.id, viewers: new Map() });
    socket.data.role = 'host';
    socket.data.code = code;
    socket.join(code);
    cb({ code });
  });

  socket.on('host:stop', () => {
    if (socket.data.role !== 'host' || !socket.data.code) return;
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room) return;
    io.to(code).emit('host:left');
    rooms.delete(code);
    socket.leave(code);
    socket.data.role = null;
    socket.data.code = null;
  });

  socket.on('viewer:join', ({ code, name }, cb) => {
    const room = rooms.get(code);
    if (!room) {
      cb({ error: 'Codigo invalido ou sala encerrada.' });
      return;
    }
    const viewerName = (name || '').trim().slice(0, 30) || 'Convidado';
    room.viewers.set(socket.id, viewerName);
    socket.data.role = 'viewer';
    socket.data.code = code;
    socket.join(code);
    cb({ ok: true });
    io.to(room.hostId).emit('viewer:new', { viewerId: socket.id, name: viewerName });
    broadcastViewers(room);
  });

  socket.on('signal:offer', ({ to, offer }) => {
    io.to(to).emit('signal:offer', { from: socket.id, offer });
  });

  socket.on('signal:answer', ({ to, answer }) => {
    io.to(to).emit('signal:answer', { from: socket.id, answer });
  });

  socket.on('signal:ice', ({ to, candidate }) => {
    io.to(to).emit('signal:ice', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    const { role, code } = socket.data;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (role === 'host') {
      io.to(code).emit('host:left');
      rooms.delete(code);
    } else if (role === 'viewer') {
      room.viewers.delete(socket.id);
      io.to(room.hostId).emit('viewer:left', { viewerId: socket.id });
      broadcastViewers(room);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Signaling server rodando na porta ${PORT}`));
