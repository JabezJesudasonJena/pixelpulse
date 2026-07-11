import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*", // Orgin allow for testing 
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log(`Player joined PixelPulse: ${socket.id}`);

    socket.on('send_message', (data) => {
        console.log(`Message from ${socket.id}:`, data.text);        
        io.emit("receive_message", data);
    });
    
    socket.on("disconnect", () => {
        console.log(`Player left: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log("PixelPulse server is running on port 3001");
});