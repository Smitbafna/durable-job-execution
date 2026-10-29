import { describe, expect, it } from "vitest";
import { MessageType } from "@resumedrop/shared";
import { WebRTCOrchestrator } from "../lib/orchestrator";
import { FakePeerConnection, FakeDataChannel, FakeTransport, flush, isOfType } from "./fakes";

const COORD_ID = "coord-1";
const WORKER_ID = "worker-1";

function wire(a: FakeTransport, b: FakeTransport): void {
  a.toPeer = (msg) => b.emit(msg);
  b.toPeer = (msg) => a.emit(msg);
}

function makePair() {
  const coordPc: FakePeerConnection[] = [];
  const workerPc: FakePeerConnection[] = [];
  const coordT = new FakeTransport(COORD_ID);
  const workerT = new FakeTransport(WORKER_ID);
  wire(coordT, workerT);

  const coord = new WebRTCOrchestrator(COORD_ID, coordT, () => {
    const pc = new FakePeerConnection();
    coordPc.push(pc);
    return pc;
  });
  const worker = new WebRTCOrchestrator(WORKER_ID, workerT, () => {
    const pc = new FakePeerConnection();
    workerPc.push(pc);
    return pc;
  });
  coord.onChange = () => {};
  worker.onChange = () => {};
  return { coord, worker, coordT, workerT, coordPc, workerPc };
}

const isOffer = isOfType(MessageType.WebrtcOffer);
const isAnswer = isOfType(MessageType.WebrtcAnswer);

function regSuccess(id: string, role: "coordinator" | "worker") {
  return {
    type: MessageType.RegistrationSuccess,
    timestamp: Date.now(),
    clientId: id,
    role,
  };
}
function discovery(ids: string[]) {
  return {
    type: MessageType.WorkerDiscoveryResponse,
    timestamp: Date.now(),
    workers: ids.map((clientId) => ({ clientId, role: "worker" as const })),
  };
}
async function connectBoth(coord: WebRTCOrchestrator, worker: WebRTCOrchestrator) {
  coord.setRole("coordinator");
  worker.setRole("worker");
  coord.connect();
  worker.connect();
  await flush();
}

describe("orchestrator", () => {
  it("registers both sides with the existing tab ID", () => {
    const { coord, worker, coordT, workerT } = makePair();
    coord.setRole("coordinator");
    worker.setRole("worker");
    coord.connect();
    worker.connect();

    expect(coord.state.wsStatus).toBe("open");
    expect(worker.state.wsStatus).toBe("open");
    expect(coordT.registerArg).toBe("coordinator");
    expect(workerT.registerArg).toBe("worker");
    const coordReg = coordT.sent[0] as { clientId: string };
    expect(coordReg.clientId).toBe(COORD_ID);
  });

  it("exposes discovered workers to the coordinator", () => {
    const { coord, coordT } = makePair();
    coord.setRole("coordinator");
    coord.connect();
    coordT.emit(discovery([WORKER_ID]));
    expect(coord.state.workers.map((w) => w.clientId)).toEqual([WORKER_ID]);
  });

  it("completes the offer/answer handshake and opens a data channel", async () => {
    const { coord, worker, coordT, workerT, coordPc, workerPc } = makePair();
    await connectBoth(coord, worker);
    coordT.emit(regSuccess(COORD_ID, "coordinator"));
    workerT.emit(regSuccess(WORKER_ID, "worker"));
    coordT.emit(discovery([WORKER_ID]));
    expect(coord.state.registered).toBe(true);

    coord.connectTo(WORKER_ID);
    await flush(3);

    expect(coordT.sent.some(isOffer)).toBe(true);
    expect(workerPc.length).toBe(1);
    expect(workerT.sent.some(isAnswer)).toBe(true);
    expect(coordPc[0].remoteDesc?.type).toBe("answer");

    const coordChannel = coordPc[0].createdChannels[0] as unknown as FakeDataChannel;
    const workerChannel = new FakeDataChannel("resumedrop");
    coordChannel.linkTo(workerChannel);
    workerPc[0].fireDataChannel(workerChannel);
    coordPc[0].setConnectionState("connected");
    workerPc[0].setConnectionState("connected");
    coordChannel.fireOpen();
    workerChannel.fireOpen();

    expect(coord.state.dataChannelState).toBe("open");
    expect(worker.state.dataChannelState).toBe("open");
    expect(coord.state.peerConnectionState).toBe("connected");
  });

  it("echoes messages both directions and routes ICE", async () => {
    const { coord, worker, coordT, workerPc, coordPc } = makePair();
    await connectBoth(coord, worker);
    coordT.emit(regSuccess(COORD_ID, "coordinator"));
    coordT.emit(discovery([WORKER_ID]));
    expect(coord.state.registered).toBe(true);

    coord.connectTo(WORKER_ID);
    await flush(3);
    expect(coordT.sent.some(isOffer)).toBe(true);
    expect(workerPc[0].remoteDesc?.type).toBe("offer");

    const coordChannel = coordPc[0].createdChannels[0] as unknown as FakeDataChannel;
    const workerChannel = new FakeDataChannel("resumedrop");
    coordChannel.linkTo(workerChannel);
    workerPc[0].fireDataChannel(workerChannel);
    coordPc[0].setConnectionState("connected");
    workerPc[0].setConnectionState("connected");
    coordChannel.fireOpen();
    workerChannel.fireOpen();

    expect(coord.send("HI")).toBe(true);
    expect(worker.state.received).toContain("HI");

    expect(worker.send("REPLY")).toBe(true);
    expect(coord.state.received).toContain("REPLY");

    coordPc[0].fireIceCandidate({ candidate: "cand-1", sdpMid: "0", sdpMLineIndex: 0 });
    await flush();
    expect(workerPc[0].candidates[0].candidate).toBe("cand-1");
  });

  it("gives the worker a fresh peer when it receives a second offer", async () => {
    const { coord, worker, coordT, workerPc } = makePair();
    await connectBoth(coord, worker);
    coordT.emit(regSuccess(COORD_ID, "coordinator"));

    // First offer -> the worker builds its first Peer.
    coord.connectTo(WORKER_ID);
    await flush(3);
    expect(workerPc.length).toBe(1);

    // Second offer (coordinator re-initiates, e.g. after a reload) -> the worker
    // must discard the prior connection rather than call setRemoteDescription on
    // an already-described peer connection (which the browser rejects).
    coord.connectTo(WORKER_ID);
    await flush(3);
    expect(workerPc.length).toBe(2);
    expect(workerPc[0].closed).toBe(true);
    // The second offer must be applied to the fresh pc, not the torn-down one.
    expect(workerPc[1].remoteDesc?.type).toBe("offer");
  });

  it("tears down the peer and stops the socket on disconnect", async () => {
    const { coord, worker, coordT } = makePair();
    await connectBoth(coord, worker);
    coordT.emit(regSuccess(COORD_ID, "coordinator"));
    coordT.emit(discovery([WORKER_ID]));
    coord.connectTo(WORKER_ID);
    await flush(3);

    coord.disconnect();
    expect(coord.state.peerConnectionState).toBe("closed");
    expect(coord.state.dataChannelState).toBe("closed");
    expect(coord.state.wsStatus).toBe("disconnected");
  });

  it("reconnects and re-registers with the existing tab ID", () => {
    const { coord, coordT } = makePair();
    coord.setRole("coordinator");
    coord.connect();
    expect(coordT.registerArg).toBe("coordinator");
    // Simulate a drop then a reconnection.
    coordT.setStatus("disconnected");
    coordT.setStatus("open");
    // Every (re)connect re-registers with the same tab ID.
    expect(coordT.registerArg).toBe("coordinator");
    const lastReg = coordT.sent[coordT.sent.length - 1] as { clientId: string };
    expect(lastReg.clientId).toBe(COORD_ID);
  });

  it("rejects a worker attempting to initiate a connection", () => {
    const { worker, coordT } = makePair();
    coordT.emit(regSuccess(COORD_ID, "coordinator"));
    worker.setRole("worker");
    worker.connect();
    coordT.emit(regSuccess(WORKER_ID, "worker"));

    worker.connectTo(WORKER_ID);
    expect(worker.state.error).toMatch(/Only the coordinator/);
  });
});
