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
    leaveCurrentRoom();

    currentRoom = room;
    socket.join(room);

    if (!roomsUsers[room]) roomsUsers[room] = {};
    roomsUsers[room][socket.id] = username || 'Anonymous';

    emitActiveUsers(room);

    console.log(`${username || 'User'} joined room ${room}`);
  });

  socket.on('draw', (data) => {
    if (currentRoom) socket.to(currentRoom).emit('draw', data);
  });

  socket.on('chat', (data) => {
    if (currentRoom) io.to(currentRoom).emit('chat', data);
  });

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
      waitingQueue.splice(waitingQueue.indexOf(partner), 1);

      const room = generateRoomCode();

      // Make both sockets leave any old rooms & remove from roomsUsers
      [partner.socket, socket].forEach(s => {
        leaveAllRooms(s);
        s.join(room);
      });

      currentRoom = room;

      if (!roomsUsers[room]) roomsUsers[room] = {};
      roomsUsers[room][socket.id] = username;
      roomsUsers[room][partner.socket.id] = partner.username;

      emitActiveUsers(room);

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

    leaveCurrentRoom();
  });

  // Helper functions
  function leaveCurrentRoom() {
    if (currentRoom) {
      socket.leave(currentRoom);
      if (roomsUsers[currentRoom]) {
        delete roomsUsers[currentRoom][socket.id];
        emitActiveUsers(currentRoom);
        // Clean up empty rooms
        if (Object.keys(roomsUsers[currentRoom]).length === 0) {
          delete roomsUsers[currentRoom];
        }
      }
      currentRoom = null;
    }
  }

  function leaveAllRooms(s) {
    const rooms = Object.keys(roomsUsers);
    rooms.forEach(room => {
      if (roomsUsers[room] && roomsUsers[room][s.id]) {
        s.leave(room);
        delete roomsUsers[room][s.id];
        emitActiveUsers(room);
        if (Object.keys(roomsUsers[room]).length === 0) {
          delete roomsUsers[room];
        }
      }
    });
  }

  function emitActiveUsers(room) {
    const count = roomsUsers[room] ? Object.keys(roomsUsers[room]).length : 0;
    console.log(`Room ${room} active users: ${count}`);
    io.to(room).emit('activeUsers', count);
  }

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
