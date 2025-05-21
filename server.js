const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",  // Change this to your frontend domain in production
    methods: ["GET", "POST"]
  }
});

const rooms = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('joinRoom', (room) => {
    socket.join(room);
    rooms[room] = rooms[room] || new Set();
    rooms[room].add(socket.id);
    console.log(`Socket ${socket.id} joined room ${room}`);
  });

  socket.on('draw', (data) => {
    const { room, x, y, color, size } = data;
    socket.to(room).emit('draw', { x, y, color, size });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const room in rooms) {
      rooms[room].delete(socket.id);
      if (rooms[room].size === 0) {
        delete rooms[room];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
