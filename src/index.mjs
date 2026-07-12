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
            timeLeft: 0,
            scores: { [socket.id]: 0 },
            guessedThisRound: new Set()
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
        room.scores[socket.id] = 0;
        io.to(roomCode).emit('update_scores', room.scores);
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
        if (!roomCode) return;
        const room = rooms.get(roomCode);
        const text = data.text.trim().toLowerCase();

        if (room.state === 'PLAYING') {
            const drawerId = room.players[room.currentDrawerIndex];
            const targetWord = room.currentWord.toLowerCase();

            // Prevent the drawer from leaking the word
            if (socket.id === drawerId) {
                if (text.includes(targetWord)) {
                    return socket.emit('system_message', { text: "Warning: You cannot type the word while drawing!", type: 'error' });
                }
            } else {
                // Ignore if this player already guessed correctly
                if (room.guessedThisRound.has(socket.id)) {
                    return socket.emit('system_message', { text: "You already guessed the word!", type: 'error' });
                }

                // Exact Match
                if (text === targetWord) {
                    room.guessedThisRound.add(socket.id);
                    
                    // Score = Base 100 + Time Bonus (up to 500)
                    const points = Math.floor((room.timeLeft / 60) * 500) + 100;
                    room.scores[socket.id] += points;
                    
                    // Give the drawer 50 points for a successful drawing
                    room.scores[drawerId] += 50;

                    io.to(roomCode).emit('system_message', { 
                        text: `Player ${socket.id.substring(0,5)} guessed the word!`, 
                        type: 'room' 
                    });
                    io.to(roomCode).emit('update_scores', room.scores);

                    // End round early if all guessers got it right
                    if (room.guessedThisRound.size === room.players.length - 1) {
                        endRound(roomCode, room);
                    }
                    return; // EXIT EARLY: Do not broadcast the actual word to the chat
                }

                // Close Match (Typo catching)
                const distance = getEditDistance(text, targetWord);
                if (distance === 1 || (distance === 2 && targetWord.length >= 6)) {
                    socket.emit('system_message', { text: `'${data.text}' is very close!`, type: 'error' });
                    // Do not return here; let the close guess show in chat so others see they are struggling.
                }
            }
        }

        // Standard broadcast for incorrect guesses or normal chat
        io.to(roomCode).emit('receive_message', { sender: socket.id, text: data.text });
    });
    // 5. Canvas Data Routing
    socket.on('draw_data', (batch) => {
        const roomCode = userRooms.get(socket.id);
        if (roomCode) {
            // socket.to() sends to everyone in the room EXCEPT the sender.
            // This is correct because the sender already drew the line locally.
            socket.to(roomCode).emit('draw_data', batch);
        }
    });

    socket.on('clear_canvas', () => {
        const roomCode = userRooms.get(socket.id);
        if (roomCode) socket.to(roomCode).emit('clear_canvas');
    });

    // 4. Disconnect Cleanup (Updated to clear timer)
    // 4. Disconnect Cleanup (Hardened)
    socket.on('disconnect', () => {
        const roomCode = userRooms.get(socket.id);
        if (roomCode) {
            const room = rooms.get(roomCode);
            
            // Remove from player list and delete their score
            room.players = room.players.filter(id => id !== socket.id);
            delete room.scores[socket.id];
            userRooms.delete(socket.id);

            io.to(roomCode).emit('player_left', { playerId: socket.id, playerCount: room.players.length });
            io.to(roomCode).emit('update_scores', room.scores); // Sync the removed score

            if (room.players.length === 0) {
                // Nuke the room if empty
                if (room.timerId) clearInterval(room.timerId);
                rooms.delete(roomCode);
                console.log(`Room ${roomCode} deleted`);
            } else if (room.state === 'PLAYING') {
                // If game is active, check if we need to abort
                if (room.players.length < 2) {
                    // Not enough players to continue the game
                    if (room.timerId) clearInterval(room.timerId);
                    room.state = 'WAITING';
                    io.to(roomCode).emit('system_message', { text: "Game ended: Not enough players.", type: 'error' });
                } else {
                    // Did the CURRENT DRAWER disconnect? 
                    // If so, the index is now out of bounds or pointing to the wrong person.
                    // We must abort this round instantly.
                    if (room.currentDrawerIndex >= room.players.length) {
                         room.currentDrawerIndex = 0; // Reset to 0 safely
                         endRound(roomCode, room); // Force end the round
                    }
                }
            }
        }
        console.log(`[-] User disconnected: ${socket.id}`);
    });
});

// Helper to calculate string similarity (Levenshtein distance)
function getEditDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = Array(a.length + 1).fill(null).map(() => Array(b.length + 1).fill(null));
    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i][j - 1] + 1,
                matrix[i - 1][j] + 1,
                matrix[i - 1][j - 1] + indicator
            );
        }
    }
    return matrix[a.length][b.length];
}

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
    io.to(roomCode).emit('clear_canvas');

    // Send the actual word ONLY to the drawer
    io.to(drawerId).emit('drawer_word', { word: room.currentWord });

    // Start the synchronized timer
    if (room.timerId) clearInterval(room.timerId);
    room.guessedThisRound.clear();
    
    room.timerId = setInterval(() => {
        room.timeLeft--;
        io.to(roomCode).emit('time_update', { timeLeft: room.timeLeft });

        if (room.timeLeft <= 0) {
            // clearInterval(room.timerId);
            // io.to(roomCode).emit('round_end', { word: room.currentWord });
            endRound(roomCode, room);
            
            // Move to next drawer (simplified loop)
            // room.currentDrawerIndex = (room.currentDrawerIndex + 1) % room.players.length;
            // setTimeout(() => startRound(roomCode, room), 5000); // Wait 5 seconds before next round
        }
    }, 1000);
}

function endRound(roomCode, room) {
    if (room.timerId) clearInterval(room.timerId);
    room.state = 'ROUND_END';
    
    io.to(roomCode).emit('round_end', { word: room.currentWord });
    
    // Move to next drawer
    room.currentDrawerIndex++;

    // Check if everyone has had a turn
    if (room.currentDrawerIndex >= room.players.length) {
        // GAME OVER
        io.to(roomCode).emit('system_message', { text: "Game Over! Check the leaderboard for the winner.", type: 'room' });
        
        // Reset room state so they can play again
        room.state = 'WAITING';
        room.currentDrawerIndex = 0;
        room.currentRound = 1;
        
        // Show the start button again for the host
        io.to(roomCode).emit('game_over'); 
    } else {
        // Continue to next round
        setTimeout(() => {
            if (rooms.has(roomCode)) startRound(roomCode, room);
        }, 5000);
    }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));