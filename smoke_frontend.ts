/**
 * Scratch integration smoke test (run with: npx tsx smoke_frontend.ts).
 *
 * Boots the REAL signaling server in-process and runs the REAL frontend
 * `SignalingClient` + `WebRTCOrchestrator` against it over real WebSockets.
 * Only the browser `RTCPeerConnection` is substituted with a synchronous fake,
 * so this validates transport + orchestrator + server routing, including:
 *   - worker discovery pushed to the coordinator
 *   - offer/answer handshake routed by the server
 *   - ICE candidates routed
 *   - data-channel messages echoed in both directions
 *   - graceful teardown on disconnect
 *
 * Not a browser test: a real browser `RTCPeerConnection` is exercised by
 * running the dev server + app in two browser tabs (see docs).
 */
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { WebSocket as NodeWS } from "ws";
import { createServer } from "./signaling-server/src/index.ts";
import { SignalingClient } from "./frontend/src/lib/signaling.ts";
import { WebRTCOrchestrator } from "./frontend/src/lib/orchestrator.ts";
import { FakePeerConnection, FakeDataChannel, flush } from "./frontend/src/__tests__/fakes.ts";
import { MessageType } from "@resumedrop/shared";

const COORD_ID = randomUUID();
const WORKER_ID = randomUUID();

/** Browser-compatible WebSocket shim over Node's `ws` EventEmitter. */
class NodeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  private ws: NodeWS;
  constructor(url: string) {
    this.ws = new NodeWS(url);
    this.ws.on("open", () => this.onopen?.());
    this.ws.on("message", (data) => this.onmessage?.({ data: data.toString() }));
    this.ws.on("close", () => this.onclose?.());
    this.ws.on("error", (e) => this.onerror?.(e));
  }
  get readyState(): number {
    return this.ws.readyState;
  }
  send(data: string | Uint8Array): void {
    this.ws.send(data);
  }
  close(): void {
    this.ws.close();
  }
}
// Bind the shim to the global so the browser-targeted transport resolves the
// ready-state constants (`WebSocket.OPEN` / `WebSocket.CLOSED`).
(globalThis as { WebSocket: unknown }).WebSocket = NodeWebSocket;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(get: () => T, predicate: (v: T) => boolean, timeout = 3000): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < timeout) {
    last = get();
    if (predicate(last)) return last;
    await sleep(30);
  }
  console.error("[smoke] waitFor last value:", last);
  throw new Error("timed out waiting for condition");
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}
function sent(o: WebRTCOrchestrator): unknown[] {
  return (o as unknown as { transport: { sent: unknown[] } }).transport.sent;
}
function hasType(o: WebRTCOrchestrator, type: MessageType): boolean {
  return sent(o).some((m) => typeof m === "object" && m !== null && (m as { type?: unknown }).type === type);
}

// Wrap the real SignalingClient to capture an outgoing `sent` log (the real
// transport has none, unlike the test fake) for assertions. `register()`
// internally calls `send()`, which routes through the override below, so
// registrations are captured automatically.
const makeClient = (id: string, url: string) => {
  const c = new SignalingClient(url, id);
  const sent: unknown[] = [];
  (c as unknown as { sent: unknown[] }).sent = sent;
  const origSend = c.send.bind(c);
  (c as unknown as { send(m: object): void }).send = (msg: object) => {
    sent.push(msg);
    origSend(msg);
  };
  return c;
};

async function main() {
  const server = createServer({ port: 0 });
  const port = (server.server.address() as AddressInfo).port as number;
  const url = `ws://localhost:${port}/ws`;

  const coordPcs: FakePeerConnection[] = [];
  const workerPcs: FakePeerConnection[] = [];

  const coord = new WebRTCOrchestrator(COORD_ID, makeClient(COORD_ID, url), () => {
    const pc = new FakePeerConnection();
    coordPcs.push(pc);
    return pc;
  });
  const worker = new WebRTCOrchestrator(WORKER_ID, makeClient(WORKER_ID, url), () => {
    const pc = new FakePeerConnection();
    workerPcs.push(pc);
    return pc;
  });
  coord.onChange = () => {};
  worker.onChange = () => {};

  coord.setRole("coordinator");
  worker.setRole("worker");
  coord.connect();
  worker.connect();

  await waitFor(() => coord.state.registered, (r) => r === true);
  await waitFor(() => worker.state.registered, (r) => r === true);
  console.log("[smoke] both registered");

  await waitFor(() => coord.state.workers, (w) => w.length === 1 && w[0].clientId === WORKER_ID);
  console.log("[smoke] worker discovered:", coord.state.workers.map((w) => w.clientId));

  // Reconnect the worker with the SAME tab id (stable identity preserved).
  worker.disconnect();
  await waitFor(() => worker.state.wsStatus, (s) => s === "disconnected");
  worker.connect();
  await waitFor(() => worker.state.registered, (r) => r === true);
  assert(coord.state.workers.length === 1, "worker still listed after reconnect");
  console.log("[smoke] worker reconnect OK");

  // Offer/answer handshake over real WebSockets.
  coord.connectTo(WORKER_ID);
  assert(coordPcs.length === 1, "coordinator created a peer");
  assert(coordPcs[0].createdChannels.length === 1, "coordinator created a data channel");
  await waitFor(() => workerPcs.length, (n) => n === 1);
  await waitFor(() => workerPcs[0]?.remoteDesc?.type ?? null, (t) => t === "offer");
  await waitFor(() => coordPcs[0]?.remoteDesc?.type ?? null, (t) => t === "answer");
  assert(hasType(coord, MessageType.WebrtcOffer), "coordinator sent an offer");
  assert(hasType(worker, MessageType.WebrtcAnswer), "worker sent an answer");
  console.log("[smoke] offer/answer handshake complete");

  // Pair the fake data-channel ends and open them (simulating ICE succeeded).
  const coordChannel = coordPcs[0].createdChannels[0] as unknown as FakeDataChannel;
  const workerChannel = new FakeDataChannel("resumedrop");
  coordChannel.linkTo(workerChannel);
  workerPcs[0].fireDataChannel(workerChannel);
  coordPcs[0].setConnectionState("connected");
  workerPcs[0].setConnectionState("connected");
  coordChannel.fireOpen();
  workerChannel.fireOpen();

  await waitFor(() => coord.state.dataChannelState, (s) => s === "open");
  await waitFor(() => worker.state.dataChannelState, (s) => s === "open");
  assert(coord.state.peerConnectionState === "connected", "coordinator pc connected");
  console.log("[smoke] data channel open");

  // Echo: coordinator -> worker -> coordinator
  assert(coord.send("HI") === true, "coordinator send HI");
  await flush();
  assert(worker.state.received.includes("HI"), "worker received HI");
  console.log("[smoke] coordinator -> worker OK");

  assert(worker.send("REPLY") === true, "worker send REPLY");
  await flush();
  assert(coord.state.received.includes("REPLY"), "coordinator received REPLY");
  console.log("[smoke] worker -> coordinator OK");

  // ICE routing.
  coordPcs[0].fireIceCandidate({ candidate: "cand-live-1", sdpMid: "0", sdpMLineIndex: 0 });
  await waitFor(() => workerPcs[0]?.candidates[0]?.candidate ?? null, (c) => c === "cand-live-1");
  console.log("[smoke] ICE routing OK");

  // Teardown.
  coord.disconnect();
  worker.disconnect();
  assert(coord.state.peerConnectionState === "closed", "coordinator pc closed");
  assert(worker.state.peerConnectionState === "closed", "worker pc closed");

  // Let the client close-handshakes propagate to the server so its graceful
  // shutdown doesn't push "Server shutting down" errors to sockets we already
  // disconnected.
  await sleep(50);
  await server.close();
  console.log("[smoke] ALL CHECKS PASSED");
}

main().catch((e) => {
  console.error("[smoke] FAILED:", e);
  process.exit(1);
});
