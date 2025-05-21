const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // allow all origins, change for production
});

const port = process.env.PORT || 3000;

const roomsUsers = {};  // { roomCode: { socketId: username, ... } }

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Store username for this socket
  let currentRoom = null;
  let username = null;

  socket.on('username', (name) => {
    username = name;
  });

  socket.on('joinRoom', (room) => {
    if (currentRoom) {
      // Leave old room
      socket.leave(currentRoom);
      if (roomsUsers[currentRoom]) {
        delete roomsUsers[currentRoom][socket.id];
        // Update user count to room
        io.to(currentRoom).emit('activeUsers', Object.keys(roomsUsers[currentRoom]).length);
      }
    }

    currentRoom = room;
    socket.join(room);

    if (!roomsUsers[room]) roomsUsers[room] = {};
    roomsUsers[room][socket.id] = username || 'Anonymous';

    // Send updated active user count to the room
    io.to(room).emit('activeUsers', Object.keys(roomsUsers[room]).length);

    console.log(`${username || 'User'} joined room ${room}`);
  });

  socket.on('draw', (data) => {
    // Broadcast drawing data to others in the room except sender
    if (currentRoom)
      socket.to(currentRoom).emit('draw', data);
  });

  socket.on('chat', (data) => {
    if (currentRoom) {
      // Broadcast chat message to all in the room, including sender (sender can ignore if desired)
      io.to(currentRoom).emit('chat', data);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    if (currentRoom && roomsUsers[currentRoom]) {
      delete roomsUsers[currentRoom][socket.id];
      io.to(currentRoom).emit('activeUsers', Object.keys(roomsUsers[currentRoom]).length);
    }
  });
});

server.listen(port, () => {
  console.log(`Socket.IO server running on port ${port}`);
});
