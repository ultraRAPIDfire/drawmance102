const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

const roomsUsers = {};
const roomsHistory = {};
const waitingQueue = {};

app.get('/health', (_, res) => res.send('OK'));

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('username', (name) => {
    socket.data.username = name || 'Anonymous';
  });

  socket.on('joinRoom', (room) => {
    if (typeof room !== 'string' || room.trim() === '') {
        console.error(`SERVER ERROR: joinRoom received invalid room:`, room, `from socket: ${socket.id}`);
        return;
    }

    const previousRoom = socket.data.room;

    if (previousRoom && roomsUsers[previousRoom]) {
      socket.leave(previousRoom);
      delete roomsUsers[previousRoom][socket.id];
      emitUserCount(previousRoom);

      if (Object.keys(roomsUsers[previousRoom]).length === 0) {
        delete roomsUsers[previousRoom];
      }
    }

    socket.data.room = room;
    socket.join(room);

    if (!roomsUsers[room]) {
      roomsUsers[room] = {};
    }
    roomsUsers[room][socket.id] = socket.data.username;

    emitUserCount(room);
    console.log(`${socket.data.username || socket.id} joined room: ${room}`);

    if (roomsHistory[room]) {
      socket.emit('drawingHistory', { history: roomsHistory[room], index: roomsHistory[room].length - 1 });
    } else {
      roomsHistory[room] = [];
    }
  });

  socket.on('sendDrawingCommand', (command) => {
    const room = socket.data.room;
    if (!room || !roomsHistory[room]) return;

    roomsHistory[room].push(command);

    socket.broadcast.to(room).emit('receiveDrawingCommand', { command, username: socket.data.username });
  });

  socket.on('moveCommand', (movedCommands) => {
    const room = socket.data.room;
    if (!room || !roomsHistory[room]) return;

    movedCommands.forEach(movedCmd => {
      const index = roomsHistory[room].findIndex(cmd => cmd.id === movedCmd.id);
      if (index !== -1) {
        roomsHistory[room][index] = movedCmd;
      }
    });

    socket.broadcast.to(room).emit('remoteMoveCommand', movedCommands);
  });

  socket.on('clearCanvas', () => {
    const room = socket.data.room;
    if (!room) return;
    roomsHistory[room] = [];
    io.to(room).emit('clearCanvas');
    console.log(`Canvas cleared for room ${room}`);
  });

  socket.on('undoCommand', () => {
    const room = socket.data.room;
    if (!room || !roomsHistory[room] || roomsHistory[room].length === 0) return;

    roomsHistory[room].pop();

    io.to(room).emit('updateHistory', { history: roomsHistory[room], index: roomsHistory[room].length - 1 });
  });

  socket.on('redoCommand', () => {
    const room = socket.data.room;
    if (!room || !roomsHistory[room]) return;

    io.to(room).emit('redoCommand');
  });

  socket.on('chatMessage', (message) => {
    const room = socket.data.room;
    const username = socket.data.username;
    if (room && message.trim() !== '') {
      io.to(room).emit('message', { username, text: message, timestamp: new Date().toLocaleTimeString() });
    }
  });

  socket.on('findPartner', () => {
    if (waitingQueue.length > 0) {
      const partner = waitingQueue.shift();
      const room = `ROOM_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

      partner.socket.join(room);
      socket.join(room);

      partner.socket.data.room = room;
      socket.data.room = room;

      partner.socket.emit('partnerFound', room);
      socket.emit('partnerFound', room);

      roomsUsers[room] = {
        [partner.socket.id]: partner.socket.data.username,
        [socket.id]: socket.data.username
      };
      roomsHistory[room] = [];
      emitUserCount(room);
    } else {
      waitingQueue.push({ socket, username: socket.data.username });
      socket.emit('waiting', 'Waiting for a partner...');
    }
  });

  socket.on('cancelMatch', () => {
    const index = waitingQueue.findIndex(u => u.socket.id === socket.id);
    if (index !== -1) {
      waitingQueue.splice(index, 1);
      console.log(`${socket.data.username || socket.id} canceled matchmaking`);
    }
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;

    const queueIndex = waitingQueue.findIndex(u => u.socket.id === socket.id);
    if (queueIndex !== -1) waitingQueue.splice(queueIndex, 1);

    if (room && roomsUsers[room]) {
      delete roomsUsers[room][socket.id];
      emitUserCount(room);
      if (Object.keys(roomsUsers[room]).length === 0) {
        delete roomsUsers[room];
        delete roomsHistory[room];
      }
    }

    console.log(`Socket disconnected: ${socket.id}`);
  });

  function emitUserCount(room) {
    const count = roomsUsers[room] ? Object.keys(roomsUsers[room]).length : 0;
    io.to(room).emit('updateUsers', count);
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});