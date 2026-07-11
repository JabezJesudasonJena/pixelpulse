import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*", // Keep open for local testing; restrict this in production
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log(`[+] User connected: ${socket.id}`);

    // 1. Listen for a basic chat message from this specific client
    socket.on('send_message', (data) => {
        console.log(`[Message] ${socket.id}: ${data.text}`);
        
        // 2. Broadcast that message to ALL connected clients
        io.emit('receive_message', {
            sender: socket.id, 
            text: data.text
        });
    });
    // 3. Handle the disconnect event natively
    socket.on('disconnect', () => {
        console.log(`[-] User disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});