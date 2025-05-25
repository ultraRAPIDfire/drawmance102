const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
// If you don't have uuid installed, run `npm install uuid` and uncomment the line below
// const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// In-memory data
const roomsUsers = {};          // { roomCode: { socketId: username } }
const roomsHistory = {};        // { roomCode: [command1, command2, ...] }
const waitingQueue = [];        // [{ socket, username }]

// Health check route (optional)
app.get('/health', (_, res) => res.send('OK'));

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // Store username
  socket.on('username', (name) => {
    socket.data.username = name || 'Anonymous';
  });

  // Join a room
  socket.on('joinRoom', (room) => {
    // --- START OF FIXES FOR 'undefined joined room [object Object]' ---
    // 1. Validate the 'room' parameter: Ensure it's a non-empty string.
    if (typeof room !== 'string' || room.trim() === '') {
        console.error(`SERVER ERROR: joinRoom received invalid room (not a string or empty):`,
        room, `from socket: ${socket.id}`);
        // Consider sending an error back to the client if needed:
        // socket.emit('joinRoomError', 'Invalid room code provided.');
        return; // Stop processing if the room is invalid
    }
    // --- END OF FIXES ---

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

    // Send existing drawing history to the newly joined client
    if (roomsHistory[room]) {
      socket.emit('drawingHistory', { history: roomsHistory[room], index: roomsHistory[room].length - 1 });
    } else {
      roomsHistory[room] = []; // Initialize history for new room
    }
  });

  // Handle incoming drawing commands
  socket.on('sendDrawingCommand', (command) => {
    const room = socket.data.room;
    if (!room || !roomsHistory[room]) return;

    // Assign a unique ID if not already present (for pasted items)
    // if (!command.id) {
    //     command.id = uuidv4(); // Uncomment if uuidv4 is imported
    // }

    // Add command to history
    roomsHistory[room].push(command);

    // Broadcast the command to all other clients in the room
    socket.broadcast.to(room).emit('receiveDrawingCommand', { command, username: socket.data.username });
  });

  // NEW: Handle element movement
  socket.on('moveCommand', (movedCommands) => {
    const room = socket.data.room;
    if (!room || !roomsHistory[room]) return;

    movedCommands.forEach(movedCmd => {
      const index = roomsHistory[room].findIndex(cmd => cmd.id === movedCmd.id);
      if (index !== -1) {
        // Update the existing command in history with the new position/properties
        // This ensures the server's authoritative history is correct.
        roomsHistory[room][index] = movedCmd;
      }
    });

    // Broadcast the updated commands to all other clients in the room
    // The sender's canvas is already updated locally during the drag.
    socket.broadcast.to(room).emit('remoteMoveCommand', movedCommands);
  });

  // Clear canvas
  socket.on('clearCanvas', () => {
    const room = socket.data.room;
    if (!room) return;
    roomsHistory[room] = []; // Clear history for the room
    io.to(room).emit('clearCanvas'); // Broadcast to all clients in the room
    console.log(`Canvas cleared for room ${room}`);
  });

  // Undo
  socket.on('undoCommand', () => {
    const room = socket.data.room;
    if (!room || !roomsHistory[room] || roomsHistory[room].length === 0) return;

    // Remove the last command from history
    roomsHistory[room].pop();

    // Broadcast the updated history (or just the undo action)
    // For simplicity and full sync, sending full history after undo/redo is robust
    io.to(room).emit('updateHistory', { history: roomsHistory[room], index: roomsHistory[room].length - 1 });
  });

  // Redo (This part typically needs a separate "redo history" or more complex state management)
  socket.on('redoCommand', () => {
    // This is a placeholder. Real redo needs a stack of undone commands.
    // For now, it might just re-emit the current history if the client handled redo locally
    const room = socket.data.room;
    if (!room || !roomsHistory[room]) return; // No server-side redo history managed here

    // Assuming client sends redo commands that were previously undone.
    // If the server was to manage a redo stack, the logic would go here.
    // For this simple setup, if a client initiates a redo, it's expected to have
    // the command it wants to reapply and send it as a new drawing command or similar.
    // As per the client code, 'updateHistory' is used to sync.
    // This means server needs to know what was redone to update its history.
    // Since the server doesn't maintain an explicit redo stack, a direct 'redoCommand'
    // from client implies client is re-adding a command.
    // So, if client re-adds, it would use 'sendDrawingCommand'.
    // If 'redoCommand' is meant to re-apply something from server's 'undo' stack,
    // then the server needs to manage that.
    // For now, it simply broadcasts a generic redo signal, expecting clients to re-sync their views.
    io.to(room).emit('redoCommand'); // Let clients handle their local redo logic
  });


  // Chat messaging
  socket.on('chatMessage', (message) => {
    const room = socket.data.room;
    const username = socket.data.username;
    if (room && message.trim() !== '') {
      io.to(room).emit('message', { username, text: message, timestamp: new Date().toLocaleTimeString() });
    }
  });

  // Matchmaking logic (simplified, assuming it's part of the original code)
  socket.on('findPartner', () => {
    if (waitingQueue.length > 0) {
      const partner = waitingQueue.shift();
      const room = `ROOM_${Math.random().toString(36).substr(2, 9).toUpperCase()}`; // Generate unique room

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