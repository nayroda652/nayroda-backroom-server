
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("Nayroda Backroom Server is running!");
});

const wss = new WebSocket.Server({
    server,
    path: "/ws"
});

wss.on("connection", (socket) => {
    console.log("Client connected");

    socket.send(JSON.stringify({
        type: "connected",
        message: "Connected to Nayroda server"
    }));

    socket.on("message", (message) => {
        console.log("Received:", message.toString());

        socket.send(JSON.stringify({
            type: "echo",
            data: message.toString()
        }));
    });

    socket.on("close", () => {
        console.log("Client disconnected");
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("Server running on port", PORT);
});
