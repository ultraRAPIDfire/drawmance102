const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mysql = require('mysql2/promise'); // Using promise-based version

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*', // Adjust this for your production environment (e.g., 'http://your-domain.com')
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// --- MySQL Database Configuration ---
const dbConfig = {
    host: "localhost",
    user: "your_db_user",      // <--- IMPORTANT: Replace with your MySQL username
    password: "your_db_password",  // <--- IMPORTANT: Replace with your MySQL password
    database: "drawmance_db"
};

let pool; // Connection pool for MySQL

async function initializeDatabase() {
    try {
        pool = mysql.createPool(dbConfig);
        console.log('MySQL connection pool created successfully.');
        await pool.getConnection(); // Test connection
        console.log('Successfully connected to MySQL database.');
    } catch (error) {
        console.error('Failed to connect to MySQL database:', error);
        process.exit(1); // Exit if DB connection fails
    }
}

// In-memory data (primarily for active users/rooms, history is now in DB)
const roomsUsers = {}; // { roomCode: { socketId: username } }
const waitingQueue = []; // [{ socket, username }]

// Socket.IO connection handler
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    // Store username and (dummy) user_id for DB operations
    socket.on('username', (name) => {
        socket.data.username = name || 'Anonymous';
        // IMPORTANT: Replace this with logic to get actual user_id from your authentication
        socket.data.user_id = 1; // Dummy user_id for now
    });

    // Join a room
    socket.on('joinRoom', async (room) => {
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

        if (!roomsUsers[room]) roomsUsers[room] = {};
        roomsUsers[room][socket.id] = socket.data.username;

        emitUserCount(room);
        console.log(`${socket.data.username || 'Unknown User'} joined room ${room}`);

        // --- Fetch history from DB for the room ---
        try {
            const [rows] = await pool.execute(
                `SELECT id, type, data, color, size, created_at, updated_at
                 FROM strokes
                 WHERE room = ?
                 ORDER BY created_at ASC`, // Order by creation time to reconstruct correctly
                [room]
            );

            // Reconstruct commands from DB format
            const history = rows.map(row => {
                const command = {
                    id: row.id,
                    type: row.type,
                    color: row.color,
                    size: row.size,
                    username: 'Unknown User' // Client can infer or get from a separate user lookup
                };
                Object.assign(command, JSON.parse(row.data)); // Merge type-specific data (points, text, x, y)
                return command;
            });
            socket.emit('initialHistory', history);
            console.log(`Sent initial history for room ${room} to ${socket.data.username}. ${history.length} commands.`);
        } catch (error) {
            console.error(`Error fetching initial history for room ${room}:`, error);
            socket.emit('error', 'Failed to load canvas history.');
        }
    });

    // Handle new drawing commands (e.g., on mouse up or text commit)
    socket.on('sendDrawingCommand', async (command) => {
        const room = socket.data.room;
        const userId = socket.data.user_id;
        if (!room || !command || !command.id || !command.type || !command.color || command.size === undefined) {
            console.warn('Invalid drawing command received:', command);
            return;
        }

        try {
            // Extract common properties and serialize specific data for DB
            const commandData = {
                x: command.x,
                y: command.y,
                points: command.points,
                text: command.text,
                fontStyle: command.fontStyle
            };

            await pool.execute(
                `INSERT INTO strokes (id, room, user_id, type, data, color, size)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [command.id, room, userId, command.type, JSON.stringify(commandData), command.color, command.size]
            );

            // Add username for client-side display if not stored in DB
            command.username = socket.data.username;
            // Broadcast the command to all clients in the room
            io.to(room).emit('receiveDrawingCommand', command);
            console.log(`Drawing command ${command.id} saved and broadcast for room ${room}.`);
        } catch (error) {
            console.error(`Error saving drawing command ${command.id} to DB:`, error);
        }
    });

    // Real-time partial drawing (for smooth live strokes) - Not persisted to DB immediately
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

    // Handle live movement of selected elements (during drag) - Not persisted to DB immediately
    socket.on('moveCommand', (data) => {
        const room = socket.data.room;
        if (!room || !data.movedCommands) return;
        // Broadcast the moved commands to all *other* users in the room for live visual updates
        socket.to(room).emit('remoteMoveCommand', data.movedCommands);
    });

    // Handle final position update of selected elements (after drag ends)
    socket.on('sendFinalMove', async (data) => {
        const room = socket.data.room;
        if (!room || !data.finalMovedCommands || data.finalMovedCommands.length === 0) {
            console.log("sendFinalMove: No commands to process or invalid data.");
            return;
        }

        let historyModified = false;
        try {
            for (const finalCmd of data.finalMovedCommands) {
                if (!finalCmd.id || !finalCmd.type || !finalCmd.color || finalCmd.size === undefined) {
                    console.warn('sendFinalMove: Skipping malformed command:', finalCmd);
                    continue;
                }

                const commandData = { // Data to be stored as JSON
                    x: finalCmd.x,
                    y: finalCmd.y,
                    points: finalCmd.points,
                    text: finalCmd.text,
                    fontStyle: finalCmd.fontStyle
                };

                const [result] = await pool.execute(
                    `UPDATE strokes
                     SET data = ?, color = ?, size = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND room = ?`,
                    [JSON.stringify(commandData), finalCmd.color, finalCmd.size, finalCmd.id, room]
                );

                if (result.affectedRows > 0) {
                    historyModified = true;
                } else {
                    console.warn(`SERVER: sendFinalMove: Command with ID ${finalCmd.id} not found for update in room ${room}.`);
                }
            }

            if (historyModified) {
                // After all updates, re-fetch the entire current history from the DB
                // and broadcast it to ensure all clients have the most accurate state.
                const [rows] = await pool.execute(
                    `SELECT id, type, data, color, size, created_at, updated_at
                     FROM strokes
                     WHERE room = ?
                     ORDER BY created_at ASC`,
                    [room]
                );
                const updatedHistory = rows.map(row => {
                    const command = {
                        id: row.id, type: row.type, color: row.color, size: row.size, username: socket.data.username
                    };
                    Object.assign(command, JSON.parse(row.data));
                    return command;
                });

                io.to(room).emit('updateHistory', {
                    history: updatedHistory,
                    username: socket.data.username // Indicate who initiated for client-side filtering
                });
                console.log(`SERVER: Final move committed for room ${room}. Database history updated.`);
            }
        } catch (error) {
            console.error(`Error processing sendFinalMove for room ${room}:`, error);
        }
    });

    // Clear canvas
    socket.on('clearCanvas', async () => {
        const room = socket.data.room;
        if (!room) return;

        try {
            await pool.execute('DELETE FROM strokes WHERE room = ?', [room]);
            io.to(room).emit('clearCanvas', { username: socket.data.username }); // Send username to allow client to ignore echo
            console.log(`Canvas cleared for room ${room} in DB.`);
        } catch (error) {
            console.error(`Error clearing canvas for room ${room} in DB:`, error);
        }
    });

    // Handle full history updates (e.g., after cut/delete/undo/redo from a client)
    socket.on('updateHistory', async (data) => {
        const room = socket.data.room;
        const userId = socket.data.user_id;
        if (!room || !data.history || !Array.isArray(data.history)) {
            console.warn('updateHistory: Invalid data received.', data);
            return;
        }

        try {
            // Delete all existing strokes for this room in the DB
            await pool.execute('DELETE FROM strokes WHERE room = ?', [room]);

            // Then, insert the new complete history received from the client
            const insertPromises = data.history.map(command => {
                const commandData = { // Data to be stored as JSON
                    x: command.x, y: command.y, points: command.points, text: command.text, fontStyle: command.fontStyle
                };
                return pool.execute(
                    `INSERT INTO strokes (id, room, user_id, type, data, color, size)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [command.id, room, userId, command.type, JSON.stringify(commandData), command.color, command.size]
                );
            });
            await Promise.all(insertPromises);

            // Broadcast the updated history to all clients in the room
            io.to(room).emit('updateHistory', {
                history: data.history, // Send back the history as received
                username: socket.data.username
            });
            console.log(`SERVER: Full history for room ${room} updated in DB and broadcasted by ${socket.data.username}.`);
        } catch (error) {
            console.error(`Error processing updateHistory for room ${room}:`, error);
        }
    });

    // Chat message (remains unchanged)
    socket.on('chatMessage', (data) => {
        const room = socket.data.room;
        if (!room) return;
        io.to(room).emit('message', data);
    });

    // Quick Match (remains unchanged)
    socket.on('findPartner', (name) => { /* ... existing logic ... */ });
    socket.on('cancelMatch', () => { /* ... existing logic ... */ });

    // Disconnect handling
    socket.on('disconnect', async () => {
        const room = socket.data.room;

        // Clean up user from waiting queue
        const queueIndex = waitingQueue.findIndex(u => u.socket.id === socket.id);
        if (queueIndex !== -1) waitingQueue.splice(queueIndex, 1);

        if (room && roomsUsers[room]) {
            delete roomsUsers[room][socket.id];
            emitUserCount(room);
            // If the room becomes empty, history remains in DB unless explicitly cleared
            if (Object.keys(roomsUsers[room]).length === 0) {
                delete roomsUsers[room];
                console.log(`Room ${room} is now empty. History persists in DB.`);
            }
        }
        console.log(`Socket disconnected: ${socket.id}`);
    });

    function emitUserCount(room) {
        const count = roomsUsers[room] ? Object.keys(roomsUsers[room]).length : 0;
        io.to(room).emit('updateUsers', count);
    }
});

// Start the server and initialize database connection
initializeDatabase().then(() => {
    server.listen(PORT, () => {
        console.log(`✅ Drawmance server running on port ${PORT}`);
    });
});