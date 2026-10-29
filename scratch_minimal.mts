import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const server = http.createServer();
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    console.log(
      "SERVER typeof:", typeof data,
      "isBuffer:", Buffer.isBuffer(data),
      "len:", typeof data === "string" ? data.length : data.length,
    );
  });
});
server.listen(0, () => {
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  ws.on("open", () =>
    ws.send(JSON.stringify({ type: "X", timestamp: 1 })),
  );
});
setTimeout(() => {
  server.close();
  process.exit(0);
}, 800);
