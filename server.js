const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const roomsHistory = {}; // This will now store full command objects per room

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

  socket.on('username', (name) => {
    socket.data.username = name;
    console.log(`Username set for ${socket.id}: ${socket.data.username}`);
  });

  socket.on('joinRoom', (room) => {
    if (socket.data.room && roomsUsers[socket.data.room] && socket.data.room !== room) {
      socket.leave(socket.data.room);
      delete roomsUsers[socket.data.room][socket.id];
      emitActiveUsers(socket.data.room);
      if (Object.keys(roomsUsers[socket.data.room]).length === 0) {
        delete roomsUsers[socket.data.room];
      }
    }

    socket.data.room = room;
    socket.join(room);

    if (!roomsUsers[room]) roomsUsers[room] = {};
    roomsUsers[room][socket.id] = socket.data.username || 'Anonymous';

    emitActiveUsers(room);

    console.log(`${socket.data.username || 'User'} joined room ${room}`);

    // Send the complete history for this room when a user joins
    socket.emit('initializeCanvas', roomsHistory[room] || []);
  });

  // NEW: Handler for receiving complete drawing or text commands
  socket.on('sendDrawingCommand', (data) => {
    if (socket.data.room && data.command) {
      console.log(`Received drawing command for room ${socket.data.room}:`, data.command.type);

      // Add sender's socket ID to the command (already present in your code)
      // This is useful for the client to distinguish its own commands
      data.command.senderSocketId = socket.id;

      // Initialize history for the room if it doesn't exist
      if (!roomsHistory[socket.data.room]) {
        roomsHistory[socket.data.room] = [];
      }

      // Add the complete command object to the room's history
      roomsHistory[socket.data.room].push(data.command);

      // Broadcast the complete command to all clients in the room
      io.to(socket.data.room).emit('receiveDrawingCommand', data.command);
    }
  });

  // *** THIS IS THE NEW IMPORTANT ADDITION FOR REAL-TIME DRAWING ***
  socket.on('sendPartialDrawing', (data) => {
    if (socket.data.room && data.point1 && data.point2) {
      // Broadcast the partial command to all other clients in the room
      // This allows other clients to see the drawing in real-time as it's being made.
      // Use socket.to() to send to everyone EXCEPT the sender.
      socket.to(socket.data.room).emit('receivePartialDrawing', {
        point1: data.point1,
        point2: data.point2,
        color: data.color,
        size: data.size,
        tool: data.tool,
        username: socket.data.username, // Include username for client-side distinction
        isStart: data.isStart // Pass along the 'isStart' flag
      });
    }
  });
  // ******************************************************************

  socket.on('clearCanvas', (room) => {
    if (room && roomsUsers[room]) {
      console.log(`Clearing canvas for room: ${room}`);
      io.to(room).emit('clearCanvas');

      // Clear history for this room
      roomsHistory[room] = [];
    }
  });

  socket.on('undoCommand', (room) => {
    if (room && roomsHistory[room] && roomsHistory[room].length > 0) {
      // In a real application, you'd manage the history state more robustly on the server
      // For this setup, we simply broadcast the undo action.
      // A more robust undo would involve sending a specific history state or index
      // and managing it on the server (e.g., removing the last command from roomsHistory[room])
      // However, given the current client-side undo logic, this broadcast is sufficient.
      io.to(room).emit('undoCommand');
    }
  });

  socket.on('redoCommand', (room) => {
    if (room && roomsHistory[room] && roomsHistory[room].length > 0) {
      // Similar to undo, broadcast to redo the next action on the client
      io.to(room).emit('redoCommand');
    }
  });

  socket.on('chatMessage', (data) => {
    if (socket.data.room) io.to(socket.data.room).emit('message', data);
  });

  socket.on('findPartner', (name) => {
    socket.data.username = name || socket.data.username;
    if (!socket.data.username) {
      socket.emit('error', 'Username not set');
      return;
    }

    if (waitingQueue.find(u => u.socket.id === socket.id)) {
      console.log(`${socket.data.username} (ID: ${socket.id}) tried to find partner but is already in queue.`);
      return;
    }

    const partnerEntry = waitingQueue.find(user => user.socket.id !== socket.id);

    if (partnerEntry) {
      waitingQueue.splice(waitingQueue.indexOf(partnerEntry), 1);

      const room = generateRoomCode();

      socket.data.room = room;
      partnerEntry.socket.data.room = room;

      socket.join(room);
      partnerEntry.socket.join(room);

      if (!roomsUsers[room]) roomsUsers[room] = {};
      roomsUsers[room][socket.id] = socket.data.username;
      roomsUsers[room][partnerEntry.socket.id] = partnerEntry.socket.data.username || 'Anonymous';

      emitActiveUsers(room);

      console.log(`${socket.data.username} matched with ${partnerEntry.socket.data.username} in room ${room}`);

      socket.emit('partnerFound', { room, partner: partnerEntry.socket.data.username });
      partnerEntry.socket.emit('partnerFound', { room, partner: socket.data.username });
    } else {
      waitingQueue.push({ socket: socket, username: socket.data.username });
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

    const index = waitingQueue.findIndex(u => u.socket.id === socket.id);
    if (index !== -1) waitingQueue.splice(index, 1);

    if (socket.data.room && roomsUsers[socket.data.room]) {
      delete roomsUsers[socket.data.room][socket.id];
      emitActiveUsers(socket.data.room);
      if (Object.keys(roomsUsers[socket.data.room]).length === 0) {
        delete roomsUsers[socket.data.room];
      }
    }
  });

  function emitActiveUsers(room) {
    const count = roomsUsers[room] ? Object.keys(roomsUsers[room]).length : 0;
    console.log(`Room ${room} active users: ${count}`);
    io.to(room).emit('updateUsers', count); // Changed 'activeUsers' to 'updateUsers' to match client
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