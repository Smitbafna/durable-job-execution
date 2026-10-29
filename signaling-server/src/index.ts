/**
 * ResumeDrop signaling server.
 *
 * Exposes a thin HTTP layer (health check) alongside a WebSocket endpoint that
 * routes WebRTC signaling messages between peers and enforces the shared
 * wire protocol defined in `@resumedrop/shared`.
 *
 * Run directly with `npx tsx watch src/index.ts` (dev) or
 * `node dist/index.js` (after `npm run build`).
 */

import http from "node:http";
import express, { type Express } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { SignalingHub } from "./signaling.js";

export type { SignalingHub } from "./signaling";
export type { RegisteredClient, ErrorCode } from "./signaling";

export interface SignalingServer {
  app: Express;
  server: http.Server;
  wss: WebSocketServer;
  hub: SignalingHub;
  close: () => Promise<void>;
}

export interface ServerOptions {
  port?: number;
}

const DEFAULT_PORT = 4000;

/**
 * Creates an Express application with the HTTP routes for the signaling
 * server. The WebSocket lifecycle wiring is attached by {@link createServer}.
 */
export function createApp(hub: SignalingHub): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  return app;
}

/**
 * Builds a complete signaling server (HTTP + WebSocket) around a fresh
 * {@link SignalingHub}. Pass `{ port }` to bind immediately.
 */
export function createServer(options: ServerOptions = {}): SignalingServer {
  const hub = new SignalingHub();
  const app = createApp(hub);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    if (process.env.SIGNALING_DEBUG) {
      // eslint-disable-next-line no-console
      console.log("[signaling] socket connected");
    }
    ws.on("message", (data: unknown) => {
      let parsed: unknown;
      try {
        // `ws` may deliver a frame as a string (text frame, the normal browser
        // path) or as a Buffer (Node client / binary delivery). Normalize to
        // text before parsing so the server is robust to either encoding.
        const text =
          typeof data === "string"
            ? data
            : Buffer.isBuffer(data)
              ? data.toString()
              : String(data);
        parsed = JSON.parse(text);
      } catch {
        hub.handleMessage(ws, undefined);
        return;
      }
      hub.handleMessage(ws, parsed);
    });
    ws.on("close", () => hub.handleDisconnect(ws));
  });

  const close = async (): Promise<void> => {
    hub.close();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  if (options.port !== undefined) {
    server.listen(options.port);
  }

  return { app, server, wss, hub, close };
}

const PORT = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;

// Start only when executed directly (not when imported by tests).
const isMainModule =
  process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMainModule) {
  const { server } = createServer({ port: PORT });
  server.on("listening", () => {
    // eslint-disable-next-line no-console
    console.log(`signaling server listening on port ${PORT}`);
  });
}
