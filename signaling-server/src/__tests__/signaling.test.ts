import { describe, it, expect, beforeEach } from "vitest";
import { WebSocket } from "ws";
import { SignalingHub, ErrorCode } from "../signaling.js";
import { MessageType } from "@resumedrop/shared";
import type { ClientMessage } from "@resumedrop/shared";

const VALID_UUID = "123e4567-e89b-41d4-a716-446655440000";
const OTHER_UUID = "919c5e67-7a3b-4d01-9b76-221100998877";

const WS_OPEN = 1;
const WS_CLOSED = 3;

/**
 * Minimal stand-in for a `ws` socket: records outbound frames as parsed
 * payloads and tracks socket state. `messages` is a *live* reference to the
 * internal buffer (not a snapshot copy), so `clear()` actually resets state
 * between sub-steps of a single assertion — mirroring the reset semantics a
 * real client would observe on a fresh socket.
 */
function makeSocket() {
  const sent: unknown[] = [];
  const sock = {
    readyState: WS_OPEN,
    OPEN: WS_OPEN,
    CLOSING: 2 as number,
    CLOSED: WS_CLOSED,
    CONNECTING: 0 as number,
    send(data: unknown) {
      // The hub sends JSON strings; parse them so assertions compare structured
      // payloads, exactly as a real WebSocket client would receive.
      sent.push(typeof data === "string" ? JSON.parse(data) : data);
    },
    close() {
      sock.readyState = WS_CLOSED;
    },
    /** Drops every recorded outbound message (resets `messages` and `last`). */
    clear() {
      sent.length = 0;
    },
    get last(): unknown {
      return sent[sent.length - 1];
    },
    get messages(): unknown[] {
      return sent;
    },
  };
  return sock;
}

function base(type: string, extra: Record<string, unknown> = {}): unknown {
  return { type, timestamp: Date.now(), ...extra };
}

const reg = (role: "coordinator" | "worker", clientId = VALID_UUID) =>
  base(
    role === "coordinator" ? MessageType.CoordinatorRegister : MessageType.WorkerRegister,
    { clientId, role },
  ) as ClientMessage;

describe("SignalingHub — registration", () => {
  let hub: SignalingHub;

  beforeEach(() => {
    hub = new SignalingHub();
  });

  it("registers a coordinator and replies with success + empty worker roster", () => {
    const ws = makeSocket();
    expect(hub.register(ws as never, reg("coordinator"))).toBe(true);
    const msgs = ws.messages;
    expect(msgs[0]).toMatchObject({ type: MessageType.RegistrationSuccess, clientId: VALID_UUID, role: "coordinator" });
    expect(msgs[1]).toMatchObject({ type: MessageType.WorkerDiscoveryResponse, workers: [] });
    expect(hub.has(VALID_UUID)).toBe(true);
    expect(hub.getClient(VALID_UUID)?.role).toBe("coordinator");
  });

  it("registers a worker and pushes the new roster to coordinators", () => {
    const coord = makeSocket();
    // Coordinator and worker must use distinct clientIds; sharing an id would
    // trigger takeover semantics and silently evict the coordinator.
    hub.register(coord as never, reg("coordinator", OTHER_UUID));
    coord.clear(); // reset (drop the initial push)

    const worker = makeSocket();
    hub.register(worker as never, reg("worker"));

    expect(worker.messages[0]).toMatchObject({ type: MessageType.RegistrationSuccess, role: "worker" });
    expect(coord.messages[0]).toMatchObject({
      type: MessageType.WorkerDiscoveryResponse,
      workers: [{ clientId: VALID_UUID, role: "worker" }],
    });
    expect(hub.getWorkers()).toHaveLength(1);
  });

  it("rejects a socket that already registered on the same socket", () => {
    const ws = makeSocket();
    expect(hub.register(ws as never, reg("coordinator"))).toBe(true);
    const ok = hub.register(ws as never, reg("worker", OTHER_UUID));
    expect(ok).toBe(false);
    expect(ws.last).toMatchObject({ type: MessageType.Error, code: ErrorCode.AlreadyRegistered });
  });

  it("rejects an invalid registration message", () => {
    const ws = makeSocket();
    expect(hub.register(ws as never, base(MessageType.CoordinatorRegister, { role: "coordinator" }))).toBe(false);
    expect(ws.last).toMatchObject({ code: ErrorCode.ValidationError });
    expect(hub.size).toBe(0);
  });

  it("rejects a role/type mismatch", () => {
    const ws = makeSocket();
    // type says coordinator but role is worker
    const msg = base(MessageType.CoordinatorRegister, { clientId: VALID_UUID, role: "worker" });
    expect(hub.register(ws as never, msg)).toBe(false);
    expect(ws.last).toMatchObject({ code: ErrorCode.ValidationError });
  });
});

describe("SignalingHub — message dispatch", () => {
  let hub: SignalingHub;
  let coord: ReturnType<typeof makeSocket>;
  let worker: ReturnType<typeof makeSocket>;

  beforeEach(() => {
    hub = new SignalingHub();
    coord = makeSocket();
    worker = makeSocket();
    hub.register(coord as never, reg("coordinator"));
    hub.register(worker as never, reg("worker", OTHER_UUID));
    coord.clear();
    worker.clear();
  });

  it("rejects messages from a socket that is not registered", () => {
    const rogue = makeSocket();
    hub.handleMessage(rogue as never, base(MessageType.WebrtcOffer, { sdp: "s" }));
    expect(rogue.last).toMatchObject({ code: ErrorCode.NotRegistered });
  });

  it("forbids a registered socket from spoofing another clientId", () => {
    hub.handleMessage(
      coord as never,
      base(MessageType.WorkerDiscoveryRequest, { clientId: OTHER_UUID }),
    );
    expect(coord.last).toMatchObject({ code: ErrorCode.Forbidden });
  });

  it("rejects unknown message types", () => {
    hub.handleMessage(coord as never, base("NOPE", { clientId: VALID_UUID }));
    expect(coord.last).toMatchObject({ code: ErrorCode.UnknownMessageType });
  });

  it("returns the current worker roster on discovery request", () => {
    hub.handleMessage(
      coord as never,
      base(MessageType.WorkerDiscoveryRequest, { clientId: VALID_UUID }),
    );
    expect(coord.messages[0]).toMatchObject({
      type: MessageType.WorkerDiscoveryResponse,
      workers: [{ clientId: OTHER_UUID, role: "worker" }],
    });
    // Coordinators never appear in the worker roster.
    expect(coord.messages[0]).not.toHaveProperty(["workers", 1]);
  });

  it("rejects a malformed discovery request", () => {
    hub.handleMessage(coord as never, { type: MessageType.WorkerDiscoveryRequest });
    expect(coord.last).toMatchObject({ code: ErrorCode.ValidationError });
  });
});

describe("SignalingHub — WebRTC signaling routing", () => {
  let hub: SignalingHub;
  let sender: ReturnType<typeof makeSocket>;
  let receiver: ReturnType<typeof makeSocket>;

  beforeEach(() => {
    hub = new SignalingHub();
    // Route signaling through two workers.
    sender = makeSocket();
    receiver = makeSocket();
    hub.register(sender as never, reg("worker"));
    hub.register(receiver as never, reg("worker", OTHER_UUID));
    sender.clear();
    receiver.clear();
  });

  it("routes an offer only to the addressed receiver, stamped with the sender", () => {
    hub.handleMessage(
      sender as never,
      base(MessageType.WebrtcOffer, {
        clientId: VALID_UUID,
        senderId: VALID_UUID,
        receiverId: OTHER_UUID,
        sdp: "v=0",
      }),
    );
    expect(receiver.messages).toHaveLength(1);
    expect(sender.messages).toHaveLength(0);
    expect(receiver.messages[0]).toMatchObject({
      type: MessageType.WebrtcOffer,
      senderId: VALID_UUID,
      sdp: "v=0",
      receiverId: OTHER_UUID,
    });
  });

  it("routes an answer only to the addressed receiver", () => {
    hub.handleMessage(
      sender as never,
      base(MessageType.WebrtcAnswer, {
        clientId: VALID_UUID,
        senderId: VALID_UUID,
        receiverId: OTHER_UUID,
        sdp: "v=0",
      }),
    );
    expect(receiver.messages[0]).toMatchObject({
      type: MessageType.WebrtcAnswer,
      senderId: VALID_UUID,
      sdp: "v=0",
    });
  });

  it("forwards ICE candidates verbatim, including the candidate object", () => {
    const candidate = { candidate: "candidate:0 1 UDP 1234", sdpMid: "0", sdpMLineIndex: 0 };
    hub.handleMessage(
      sender as never,
      base(MessageType.WebrtcIceCandidate, {
        clientId: VALID_UUID,
        senderId: VALID_UUID,
        receiverId: OTHER_UUID,
        candidate,
        sdpMid: "0",
        sdpMLineIndex: 0,
      }),
    );
    expect(receiver.messages[0]).toMatchObject({
      type: MessageType.WebrtcIceCandidate,
      senderId: VALID_UUID,
      candidate,
      sdpMid: "0",
    });
  });

  it("reports RecipientOffline when the receiver is unknown", () => {
    hub.handleMessage(
      sender as never,
      base(MessageType.WebrtcOffer, {
        clientId: VALID_UUID,
        senderId: VALID_UUID,
        receiverId: "deadbeef-dead-dead-dead-deadbeefdead",
        sdp: "v=0",
      }),
    );
    expect(sender.last).toMatchObject({ code: ErrorCode.RecipientOffline });
  });

  it("rejects a malformed offer without forwarding it", () => {
    hub.handleMessage(
      sender as never,
      base(MessageType.WebrtcOffer, {
        clientId: VALID_UUID,
        senderId: VALID_UUID,
        receiverId: OTHER_UUID,
        // missing sdp
      }),
    );
    expect(sender.last).toMatchObject({ code: ErrorCode.ValidationError });
    expect(receiver.messages).toHaveLength(0);
  });
});

import { createServer } from "../index.js";
import type { AddressInfo } from "node:net";

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.once("open", () => resolve()));
}

function waitFor(predicate: () => boolean, ms = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > ms) {
        return reject(new Error("timed out waiting for condition"));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("SignalingHub — disconnect & takeover safety", () => {
  let hub: SignalingHub;

  beforeEach(() => {
    hub = new SignalingHub();
  });

  it("graceful Disconnect removes only the sender's registration and closes the socket", () => {
    const coord = makeSocket();
    const worker = makeSocket();
    hub.register(coord as never, reg("coordinator"));
    hub.register(worker as never, reg("worker", OTHER_UUID));
    expect(hub.size).toBe(2);

    hub.handleMessage(
      coord as never,
      base(MessageType.Disconnect, { clientId: VALID_UUID, reason: "normal" }),
    );
    expect(hub.has(VALID_UUID)).toBe(false);
    expect(hub.has(OTHER_UUID)).toBe(true); // worker untouched
    expect(coord.readyState).toBe(WS_CLOSED);
    expect(hub.size).toBe(1);
  });

  it("transport-level close cleans up the registering socket", () => {
    const worker = makeSocket();
    hub.register(worker as never, reg("worker"));
    expect(hub.getWorkers()).toHaveLength(1);
    hub.handleDisconnect(worker as never);
    expect(hub.getWorkers()).toHaveLength(0);
    expect(hub.has(VALID_UUID)).toBe(false);
  });

  it("an obsolete socket cannot unregister a session taken over by a newer socket", () => {
    const ws1 = makeSocket();
    const ws2 = makeSocket();
    hub.register(ws1 as never, reg("worker"));
    // New socket takes ownership of the same clientId.
    hub.register(ws2 as never, reg("worker"));
    expect(hub.size).toBe(1);

    // The obsolete socket closing must NOT evict ws2's registration.
    hub.handleDisconnect(ws1 as never);
    expect(hub.has(VALID_UUID)).toBe(true);
    expect(hub.getClient(VALID_UUID)?.ws).toBe(ws2 as never);

    // Only closing the live socket finally unregisters.
    hub.handleDisconnect(ws2 as never);
    expect(hub.has(VALID_UUID)).toBe(false);
    expect(hub.size).toBe(0);
  });

  it("close() evicts everyone and closes every socket", () => {
    const coord = makeSocket();
    const worker = makeSocket();
    hub.register(coord as never, reg("coordinator"));
    hub.register(worker as never, reg("worker", OTHER_UUID));
    hub.close();
    expect(hub.size).toBe(0);
    expect(coord.readyState).toBe(WS_CLOSED);
    expect(worker.readyState).toBe(WS_CLOSED);
  });
});

describe("SignalingHub — real WebSocket integration", () => {
  it("completes the coordinator registration handshake over a real socket", async () => {
    const { server, wss, close } = createServer({ port: 0 });
    // `listen(0)` binds asynchronously; wait for the HTTP server to be ready
    // before attempting a WebSocket connection (avoids a connect race).
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const client = new WebSocket(`ws://localhost:${port}/ws`);
    const received: unknown[] = [];
    client.on("message", (d) => received.push(JSON.parse(d.toString())));
    await onceOpen(client);

    client.send(JSON.stringify(reg("coordinator")));
    await waitFor(() => received.length >= 2, 1000);

    expect(received[0]).toMatchObject({ type: MessageType.RegistrationSuccess, role: "coordinator" });
    expect(received[1]).toMatchObject({ type: MessageType.WorkerDiscoveryResponse });

    client.close();
    await close();
    // The WebSocket close handshake completes shortly after the server closes;
    // wait for the server-side socket set to drain before asserting on it.
    await waitFor(() => wss.clients.size === 0, 1000);
    expect(wss.clients.size).toBe(0);
  });

  it("rejects malformed JSON without crashing the connection", async () => {
    const { server, close } = createServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const client = new WebSocket(`ws://localhost:${port}/ws`);
    const received: unknown[] = [];
    client.on("message", (d) => received.push(JSON.parse(d.toString())));
    await onceOpen(client);

    client.send("{ this is not json");
    await waitFor(() => received.length >= 1, 1000);
    expect(received[0]).toMatchObject({ code: ErrorCode.ValidationError });

    client.close();
    await close();
  });
});