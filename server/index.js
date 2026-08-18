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

// code -> { hostId, viewers: Set<socketId> }
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  socket.on('host:create', (_payload, cb) => {
    const code = generateCode();
    rooms.set(code, { hostId: socket.id, viewers: new Set() });
    socket.data.role = 'host';
    socket.data.code = code;
    socket.join(code);
    cb({ code });
  });

  socket.on('viewer:join', (code, cb) => {
    const room = rooms.get(code);
    if (!room) {
      cb({ error: 'Codigo invalido ou sala encerrada.' });
      return;
    }
    room.viewers.add(socket.id);
    socket.data.role = 'viewer';
    socket.data.code = code;
    socket.join(code);
    cb({ ok: true });
    io.to(room.hostId).emit('viewer:new', { viewerId: socket.id });
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
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Signaling server rodando na porta ${PORT}`));
