import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const server = createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const rooms = new Map();
const userRooms = new Map();

// Hardcoded word list for the prototype
const WORDS = ["apple", "dog", "house", "car", "tree", "computer", "pizza"];
const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

io.on('connection', (socket) => {
    console.log(`[+] User connected: ${socket.id}`);

    // 1. Create Room (Updated with Game State)
    socket.on('create_room', () => {
        const roomCode = generateRoomCode();
        rooms.set(roomCode, {
            players: [socket.id], // Changed to Array to easily pick drawers by index
            state: 'WAITING',
            currentDrawerIndex: 0,
            currentWord: '',
            timerId: null, // Critical: Holds the setInterval ID
            timeLeft: 0
        });
        userRooms.set(socket.id, roomCode);
        socket.join(roomCode);
        socket.emit('room_created', { roomCode });
    });

    // 2. Join Room (Updated for Array)
    socket.on('join_room', (data) => {
        const { roomCode } = data;
        if (!rooms.has(roomCode)) return socket.emit('error', { message: 'Room not found' });
        
        const room = rooms.get(roomCode);
        if (room.state !== 'WAITING') return socket.emit('error', { message: 'Game already in progress' });
        if (room.players.length >= 5) return socket.emit('error', { message: 'Room is full' });

        room.players.push(socket.id);
        userRooms.set(socket.id, roomCode);
        socket.join(roomCode);

        socket.emit('room_joined', { roomCode });
        socket.to(roomCode).emit('player_joined', { playerId: socket.id, playerCount: room.players.length });
    });

    // 3. Start Game Logic
    socket.on('start_game', () => {
        const roomCode = userRooms.get(socket.id);
        const room = rooms.get(roomCode);

        if (!room) return;
        if (room.players.length < 2) {
            return socket.emit('error', { message: 'Need at least 2 players to start' });
        }
        
        room.state = 'PLAYING';
        startRound(roomCode, room);
    });

    socket.on('send_message', (data) => {
        const roomCode = userRooms.get(socket.id);
        if (roomCode) io.to(roomCode).emit('receive_message', { sender: socket.id, text: data.text });
    });

    // 4. Disconnect Cleanup (Updated to clear timer)
    socket.on('disconnect', () => {
        const roomCode = userRooms.get(socket.id);
        if (roomCode) {
            const room = rooms.get(roomCode);
            room.players = room.players.filter(id => id !== socket.id);
            userRooms.delete(socket.id);

            io.to(roomCode).emit('player_left', { playerId: socket.id, playerCount: room.players.length });

            if (room.players.length === 0) {
                if (room.timerId) clearInterval(room.timerId); // Prevent memory leak
                rooms.delete(roomCode);
            }
        }
        console.log(`[-] User disconnected: ${socket.id}`);
    });
});

// The Server-Side Game Loop
function startRound(roomCode, room) {
    // Pick drawer and word
    const drawerId = room.players[room.currentDrawerIndex];
    room.currentWord = WORDS[Math.floor(Math.random() * WORDS.length)];
    room.timeLeft = 60; // 60 seconds per round

    // Notify everyone a new round is starting
    io.to(roomCode).emit('round_start', { 
        drawerId: drawerId,
        wordLength: room.currentWord.length 
    });

    // Send the actual word ONLY to the drawer
    io.to(drawerId).emit('drawer_word', { word: room.currentWord });

    // Start the synchronized timer
    if (room.timerId) clearInterval(room.timerId);
    
    room.timerId = setInterval(() => {
        room.timeLeft--;
        io.to(roomCode).emit('time_update', { timeLeft: room.timeLeft });

        if (room.timeLeft <= 0) {
            clearInterval(room.timerId);
            io.to(roomCode).emit('round_end', { word: room.currentWord });
            
            // Move to next drawer (simplified loop)
            room.currentDrawerIndex = (room.currentDrawerIndex + 1) % room.players.length;
            setTimeout(() => startRound(roomCode, room), 5000); // Wait 5 seconds before next round
        }
    }, 1000);
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));