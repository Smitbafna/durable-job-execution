import { WebSocket } from "ws";
import { createServer } from "./signaling-server/src/index.ts";

const { server, close } = createServer({ port: 0 });
await new Promise<void>((resolve) => server.on("listening", resolve));
const port = (server.address() as { port: number }).port;
const client = new WebSocket(`ws://localhost:${port}/ws`);
const received: unknown[] = [];
client.on("message", (d) => received.push(JSON.parse(d.toString())));
client.on("error", (e) => console.log("CLIENT ERROR:", e.message));
await new Promise<void>((resolve) => client.on("open", resolve));
console.log("sending coordinator registration to port", port);
client.send(
  JSON.stringify({
    type: "COORDINATOR_REGISTER",
    timestamp: Date.now(),
    clientId: "123e4567-e89b-41d4-a716-446655440000",
    role: "coordinator",
  }),
);
await new Promise((r) => setTimeout(r, 400));
console.log("received count:", received.length);
console.log("received:", JSON.stringify(received, null, 2));
client.close();
await close();
