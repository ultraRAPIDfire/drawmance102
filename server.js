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

// In-memory data
const roomsUsers = {};         // { roomCode: { socketId: username } }
const roomsHistory = {};       // { roomCode: [command1, command2, ...] }
const waitingQueue = [];       // [{ socket, username }]

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
        console.error(`SERVER ERROR: joinRoom received invalid room (not a string or empty):`, room, `from socket: ${socket.id}`);
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

    if (!roomsUsers[room]) roomsUsers[room] = {};
    roomsUsers[room][socket.id] = socket.data.username;

    emitUserCount(room);
    // --- START OF FIXES ---
    // 2. Make the username logging more robust
    console.log(`${socket.data.username || 'Unknown User'} joined room ${room}`);
    // --- END OF FIXES ---

    socket.emit('initializeCanvas', roomsHistory[room] || []);
  });

  // Full drawing command (on mouse up or text insert)
  socket.on('sendDrawingCommand', (data) => {
    const room = socket.data.room;
    if (!room || !data.command) return;

    data.command.senderSocketId = socket.id;
    if (!roomsHistory[room]) roomsHistory[room] = [];
    roomsHistory[room].push(data.command);

    io.to(room).emit('receiveDrawingCommand', data.command);
  });

  // Real-time partial drawing (for smooth live strokes)
  socket.on('sendPartialDrawing', (data) => {
    const room = socket.data.room;
    if (!room || !data.point1 || !data.point2) return;

    socket.to(room).emit('receivePartialDrawing', {
      point1: data.point1,
      point2: data.point2,
      color: data.color,
      size: data.size,
      tool: data.tool,
      username: socket.data.username,
      isStart: data.isStart
    });
  });

  // Handle live movement of selected elements (during drag)
  socket.on('moveCommand', (data) => {
    const room = socket.data.room;
    if (!room || !data.movedCommands) return;
    // Broadcast the moved commands to all *other* users in the room for live visual updates
    socket.to(room).emit('remoteMoveCommand', data.movedCommands);
  });

  // Handle final position update of selected elements (after drag ends)
  socket.on('sendFinalMove', (data) => {
    const room = socket.data.room;
    if (!room || !data.finalMovedCommands || !roomsHistory[room]) return;

    // Update the server's canonical history with the final positions
    data.finalMovedCommands.forEach(finalCmd => {
      const index = roomsHistory[room].findIndex(cmd => cmd.id === finalCmd.id);
      if (index !== -1) {
        // Replace the old command with the new, moved command
        roomsHistory[room][index] = finalCmd;
      } else {
        // This case should ideally not happen if IDs are unique and elements exist.
        // It might indicate a new element was added during drag (unlikely for move).
        console.warn(`SERVER: sendFinalMove received command with ID ${finalCmd.id} not found in history. Adding as new.`);
        roomsHistory[room].push(finalCmd);
      }
    });

    // Broadcast the updated full history to all clients to ensure consistency
    // This will trigger the client's 'updateHistory' listener, which handles deduplication.
    io.to(room).emit('updateHistory', {
      history: roomsHistory[room],
      index: roomsHistory[room].length - 1,
      username: socket.data.username // Indicate who initiated the update
    });
    console.log(`SERVER: Final move committed for room ${room}. History updated.`);
  });

  // Clear canvas
  socket.on('clearCanvas', () => {
    const room = socket.data.room;
    if (!room) return;

    roomsHistory[room] = [];
    io.to(room).emit('clearCanvas');
    console.log(`Canvas cleared for room ${room}`);
  });

  // Undo (Note: Server-side undo/redo logic needs to manage history index accurately)
  socket.on('undoCommand', () => {
    const room = socket.data.room;
    if (!room || !roomsHistory[room] || roomsHistory[room].length === 0) return;

    // This is a simple broadcast. A more robust undo/redo would involve
    // the server managing the history index and sending the state.
    // For now, it relies on client-side history management for undo/redo.
    io.to(room).emit('undoCommand');
  });

  // Redo (Note: Server-side undo/redo logic needs to manage history index accurately)
  socket.on('redoCommand', () => {
    const room = socket.data.room;
    if (!room || !roomsHistory[room] || roomsHistory[room].length === 0) return;

    // Similar to undo, this relies on client-side history management.
    io.to(room).emit('redoCommand');
  });

  // Handle full history updates (e.g., after cut/delete or initial sync)
  socket.on('historyChange', (data) => {
    const room = socket.data.room;
    if (!room || !data.history) return;

    // Server updates its history with the received history
    // This assumes the client sending 'historyChange' has the most authoritative history.
    // In a highly concurrent system, this might need more sophisticated merging/conflict resolution.
    roomsHistory[room] = data.history;

    // Broadcast the updated history to all others in the room
    socket.to(room).emit('updateHistory', {
      history: roomsHistory[room],
      index: data.index,
      username: data.username
    });
    console.log(`SERVER: History changed for room ${room} by ${data.username}.`);
  });


  // Chat message
  socket.on('chatMessage', (data) => {
    const room = socket.data.room;
    if (!room) return;

    io.to(room).emit('message', data);
  });

  // Quick Match (Find Partner)
  socket.on('findPartner', (name) => {
    socket.data.username = name || socket.data.username || 'Anonymous';

    if (waitingQueue.find(u => u.socket.id === socket.id)) return;

    const partner = waitingQueue.find(u => u.socket.id !== socket.id);
    if (partner) {
      waitingQueue.splice(waitingQueue.indexOf(partner), 1);

      const room = generateRoomCode();
      socket.data.room = room;
      partner.socket.data.room = room;

      socket.join(room);
      partner.socket.join(room);

      if (!roomsUsers[room]) roomsUsers[room] = {};
      roomsUsers[room][socket.id] = socket.data.username;
      roomsUsers[room][partner.socket.id] = partner.username;

      emitUserCount(room);

      socket.emit('partnerFound', { room, partner: partner.username });
      partner.socket.emit('partnerFound', { room, partner: socket.data.username });
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

  function generateRoomCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }
});

// Start the server
server.listen(PORT, () => {
  console.log(`✅ Drawmance server running on port ${PORT}`);
});
