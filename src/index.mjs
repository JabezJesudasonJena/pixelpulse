import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Centralized In-Memory State
// rooms maps roomCode -> { players: Set(socket.ids), state: 'WAITING' }
const rooms = new Map(); 
// userRooms maps socket.id -> roomCode (Crucial for handling disconnects instantly)
const userRooms = new Map(); 

// Helper function to generate a 6-character room code
const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

io.on('connection', (socket) => {
    console.log(`[+] User connected: ${socket.id}`);

    // 1. Create a Room
    socket.on('create_room', (data) => {
        const roomCode = generateRoomCode();
        
        // Initialize the room state
        rooms.set(roomCode, {
            players: new Set([socket.id]),
            state: 'WAITING_FOR_PLAYERS'
        });
        userRooms.set(socket.id, roomCode);

        socket.join(roomCode);
        
        // Send the code back to the creator
        socket.emit('room_created', { roomCode });
        console.log(`Room ${roomCode} created by ${socket.id}`);
    });

    // 2. Join a Room
    socket.on('join_room', (data) => {
        const { roomCode } = data;

        if (!rooms.has(roomCode)) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        const room = rooms.get(roomCode);
        
        // Enforce the 5-player limit
        if (room.players.size >= 5) {
            socket.emit('error', { message: 'Room is full' });
            return;
        }

        room.players.add(socket.id);
        userRooms.set(socket.id, roomCode);
        socket.join(roomCode);

        // Notify the user they joined successfully
        socket.emit('room_joined', { roomCode });
        
        // Broadcast to EVERYONE ELSE in the room that a new player joined
        socket.to(roomCode).emit('player_joined', { 
            playerId: socket.id, 
            playerCount: room.players.size 
        });
    });

    // 3. Room-Specific Chat
    socket.on('send_message', (data) => {
        const roomCode = userRooms.get(socket.id);
        if (roomCode) {
            // io.to(roomCode).emit sends to ALL players in that specific room
            io.to(roomCode).emit('receive_message', {
                sender: socket.id,
                text: data.text
            });
        }
    });

    // 4. Handle Disconnects (The cleanup phase)
    socket.on('disconnect', () => {
        const roomCode = userRooms.get(socket.id);
        if (roomCode) {
            const room = rooms.get(roomCode);
            room.players.delete(socket.id);
            userRooms.delete(socket.id);

            // Notify remaining players
            io.to(roomCode).emit('player_left', { 
                playerId: socket.id, 
                playerCount: room.players.size 
            });

            // Prevent memory leaks: delete the room if empty
            if (room.players.size === 0) {
                rooms.delete(roomCode);
                console.log(`Room ${roomCode} deleted (empty)`);
            }
        }
        console.log(`[-] User disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});