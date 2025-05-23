const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const port = process.env.PORT || 3000;

const roomsUsers = {};  // { roomCode: { socketId: username, ... } }
const waitingQueue = []; // [{ socket, username }]

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('username', (name) => {
    socket.data.username = name; // Store username directly on socket.data
    console.log(`Username set for ${socket.id}: ${socket.data.username}`);
  });

  socket.on('joinRoom', (room) => {
    // If this socket was already associated with a room, leave it first
    if (socket.data.room && roomsUsers[socket.data.room] && socket.data.room !== room) {
      socket.leave(socket.data.room);
      delete roomsUsers[socket.data.room][socket.id];
      emitActiveUsers(socket.data.room); // Update count for the room being left
      // Clean up empty rooms
      if (Object.keys(roomsUsers[socket.data.room]).length === 0) {
        delete roomsUsers[socket.data.room];
      }
    }

    socket.data.room = room; // Store the new room on socket.data
    socket.join(room);

    if (!roomsUsers[room]) roomsUsers[room] = {};
    roomsUsers[room][socket.id] = socket.data.username || 'Anonymous'; // Use username from socket.data

    emitActiveUsers(room); // Update count for the room being joined

    console.log(`${socket.data.username || 'User'} joined room ${room}`);
  });

  socket.on('draw', (data) => {
    if (socket.data.room) socket.to(socket.data.room).emit('draw', data);
  });

  // Handle drawText event
  socket.on('drawText', (data) => {
    if (socket.data.room) socket.to(socket.data.room).emit('drawText', data);
  });

  // Handle clearCanvas event - IMPROVED
  socket.on('clearCanvas', () => { // Removed 'room' argument from here
    if (socket.data.room && roomsUsers[socket.data.room]) { // Use socket.data.room
      console.log(`Clearing canvas for room: ${socket.data.room}`);
      io.to(socket.data.room).emit('clearCanvas'); // Broadcast to all clients in the room
    }
  });

  // FIX: Change 'chat' to 'chatMessage' to match client emission
  socket.on('chatMessage', (data) => {
    // FIX: Change 'chat' to 'message' to match client listener
    if (socket.data.room) io.to(socket.data.room).emit('message', data);
  });

  socket.on('findPartner', (name) => {
    socket.data.username = name || socket.data.username; // Ensure username is set on current socket
    if (!socket.data.username) {
      socket.emit('error', 'Username not set');
      return;
    }

    // Prevent duplicate entries in waiting queue
    if (waitingQueue.find(u => u.socket.id === socket.id)) {
        console.log(`${socket.data.username} (ID: ${socket.id}) tried to find partner but is already in queue.`);
        return;
    }

    const partnerEntry = waitingQueue.find(user => user.socket.id !== socket.id);

    if (partnerEntry) {
      waitingQueue.splice(waitingQueue.indexOf(partnerEntry), 1); // Remove partner from queue

      const room = generateRoomCode();

      // --- CRUCIAL FIX: Update `socket.data.room` for *both* sockets before client redirect ---
      socket.data.room = room;
      partnerEntry.socket.data.room = room;

      // Make both sockets join the new room on the server side
      socket.join(room);
      partnerEntry.socket.join(room);

      if (!roomsUsers[room]) roomsUsers[room] = {};
      roomsUsers[room][socket.id] = socket.data.username;
      roomsUsers[room][partnerEntry.socket.id] = partnerEntry.socket.data.username || 'Anonymous';

      emitActiveUsers(room); // Should now correctly emit 2

      console.log(`${socket.data.username} matched with ${partnerEntry.socket.data.username} in room ${room}`);

      // Emit partnerFound to both clients, passing the *other* partner's username
      socket.emit('partnerFound', { room, partner: partnerEntry.socket.data.username });
      partnerEntry.socket.emit('partnerFound', { room, partner: socket.data.username });
    } else {
      waitingQueue.push({ socket: socket, username: socket.data.username }); // Store the socket and its username
      socket.emit('waiting', 'Waiting for a partner...');
      console.log(`${socket.data.username} is waiting for a match`);
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
    console.log('User disconnected:', socket.id);

    // Remove from waiting queue
    const index = waitingQueue.findIndex(u => u.socket.id === socket.id);
    if (index !== -1) waitingQueue.splice(index, 1);

    // Clean up from roomsUsers if they were in a room using socket.data.room
    if (socket.data.room && roomsUsers[socket.data.room]) {
      delete roomsUsers[socket.data.room][socket.id];
      emitActiveUsers(socket.data.room); // Update count for the room that user left
      // Clean up empty rooms
      if (Object.keys(roomsUsers[socket.data.room]).length === 0) {
        delete roomsUsers[socket.data.room];
      }
    }
  });

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