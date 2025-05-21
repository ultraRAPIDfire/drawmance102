const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const port = process.env.PORT || 3000;

const roomsUsers = {};  // { roomCode: { socketId: username, ... } }
const waitingQueue = []; // [{ socket, username }]

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  let currentRoom = null;
  let username = null;

  socket.on('username', (name) => {
    username = name;
    console.log(`Username set: ${username}`);
  });

  socket.on('joinRoom', (room) => {
    if (currentRoom) {
      socket.leave(currentRoom);
      if (roomsUsers[currentRoom]) {
        delete roomsUsers[currentRoom][socket.id];
        io.to(currentRoom).emit('activeUsers', Object.keys(roomsUsers[currentRoom]).length);
      }
    }

    currentRoom = room;
    socket.join(room);

    if (!roomsUsers[room]) roomsUsers[room] = {};
    roomsUsers[room][socket.id] = username || 'Anonymous';

    io.to(room).emit('activeUsers', Object.keys(roomsUsers[room]).length);
    console.log(`${username || 'User'} joined room ${room}`);
  });

  socket.on('draw', (data) => {
    if (currentRoom) socket.to(currentRoom).emit('draw', data);
  });

  socket.on('chat', (data) => {
    if (currentRoom) io.to(currentRoom).emit('chat', data);
  });

  // 🔁 Matchmaking logic
  socket.on('findPartner', (name) => {
    username = name || username;
    if (!username) {
      socket.emit('error', 'Username not set');
      return;
    }

    // Prevent duplicate entries in waiting queue
    if (waitingQueue.find(u => u.socket.id === socket.id)) return;

    const partner = waitingQueue.find(user => user.socket.id !== socket.id);

    if (partner) {
      // Remove matched partner from waiting queue
      waitingQueue.splice(waitingQueue.indexOf(partner), 1);

      const room = generateRoomCode();

      [partner.socket, socket].forEach(s => {
        // Leave previous room if any
        if (currentRoom) {
          s.leave(currentRoom);
        }

        // Remove from any old roomsUsers
        for (const r in roomsUsers) {
          if (roomsUsers[r] && roomsUsers[r][s.id]) {
            delete roomsUsers[r][s.id];
            io.to(r).emit('activeUsers', Object.keys(roomsUsers[r]).length);
          }
        }

        s.join(room);
      });

      currentRoom = room;
      if (!roomsUsers[room]) roomsUsers[room] = {};
      roomsUsers[room][socket.id] = username;
      roomsUsers[room][partner.socket.id] = partner.username;

      io.to(room).emit('activeUsers', Object.keys(roomsUsers[room]).length);

      console.log(`${username} matched with ${partner.username} in room ${room}`);

      [partner.socket, socket].forEach(s => {
        s.emit('partnerFound', { room, partner: s === socket ? partner.username : username });
      });
    } else {
      waitingQueue.push({ socket, username });
      socket.emit('waiting', 'Waiting for a partner...');
      console.log(`${username} is waiting for a match`);
    }
  });

  socket.on('cancelMatch', () => {
    const index = waitingQueue.findIndex(u => u.socket.id === socket.id);
    if (index !== -1) {
      waitingQueue.splice(index, 1);
      console.log(`${username || socket.id} canceled matchmaking`);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    // Remove from waiting queue
    const index = waitingQueue.findIndex(u => u.socket.id === socket.id);
    if (index !== -1) waitingQueue.splice(index, 1);

    if (currentRoom && roomsUsers[currentRoom]) {
      delete roomsUsers[currentRoom][socket.id];
      io.to(currentRoom).emit('activeUsers', Object.keys(roomsUsers[currentRoom]).length);
    }
  });

  function generateRoomCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }
});

server.listen(port, () => {
  console.log(`Socket.IO server running on port ${port}`);
});
