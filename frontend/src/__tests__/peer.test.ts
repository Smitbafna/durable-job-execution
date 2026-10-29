import { describe, expect, it, vi } from "vitest";
import { Peer } from "../lib/peer";
import type { IceCandidate, PeerConnectionState, Sdp } from "../lib/peer";
import { FakePeerConnection, FakeDataChannel } from "./fakes";

function makeFactory(capture: FakePeerConnection[]) {
  return () => {
    const pc = new FakePeerConnection();
    capture.push(pc);
    return pc;
  };
}

function makeEvents() {
  return {
    onSignal: vi.fn(),
    onIce: vi.fn(),
    onDataChannelOpen: vi.fn(),
    onDataChannelMessage: vi.fn(),
    onDataChannelClosed: vi.fn(),
    onState: vi.fn<(s: PeerConnectionState) => void>(),
    onError: vi.fn<(m: string) => void>(),
  };
}

describe("Peer — ICE buffering & offer/answer sequencing", () => {
  it("buffers ICE candidates before the remote description is installed", async () => {
    const events = makeEvents();
    const pcs: FakePeerConnection[] = [];
    const peer = new Peer("worker", "worker-1", makeFactory(pcs), events);

    const remoteOffer: Sdp = { type: "offer", sdp: "remote-offer" };
    const earlyIce: IceCandidate = { candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 };

    // No peer connection exists yet: candidate must be buffered, not dropped.
    peer.handleIceCandidate(earlyIce);
    expect(pcs.length).toBe(0);

    await peer.handleOffer("coord-1", remoteOffer);

    expect(pcs.length).toBe(1);
    expect(pcs[0].remoteDesc).toEqual(remoteOffer);
    expect(pcs[0].candidates).toHaveLength(1);
    expect(pcs[0].candidates[0].candidate).toBe("c1");
    expect(pcs[0].answers).toHaveLength(1);
    expect(events.onSignal).toHaveBeenCalledTimes(1);
    expect(events.onSignal).toHaveBeenCalledWith(
      expect.objectContaining({ type: "answer", sdp: "fake-answer" }),
      "answer",
    );
  });
});

describe("Peer — coordinator initiator flow", () => {
  it("creates an offer + data channel and signals the offer", async () => {
    const events = makeEvents();
    const pcs: FakePeerConnection[] = [];
    const peer = new Peer("coordinator", "coord-1", makeFactory(pcs), events);

    await peer.initiate("worker-1");

    expect(peer.peerClientId).toBe("worker-1");
    expect(pcs.length).toBe(1);
    expect(pcs[0].offers).toHaveLength(1);
    expect(pcs[0].localDesc?.type).toBe("offer");
    expect(pcs[0].createdChannels).toHaveLength(1);
    expect(pcs[0].createdChannels[0].label).toBe("resumedrop");
    expect(events.onSignal).toHaveBeenCalledWith(
      expect.objectContaining({ type: "offer", sdp: "fake-offer" }),
      "offer",
    );
  });

  it("applies the remote answer", async () => {
    const events = makeEvents();
    const pcs: FakePeerConnection[] = [];
    const peer = new Peer("coordinator", "coord-1", makeFactory(pcs), events);
    await peer.initiate("worker-1");

    await peer.handleAnswer("worker-1", { type: "answer", sdp: "remote-answer" });
    expect(pcs[0].remoteDesc?.type).toBe("answer");
    expect(pcs[0].remoteDesc?.sdp).toBe("remote-answer");
  });
});

describe("Peer — data channel send / receive / cleanup", () => {
  it("refuses to send before a data channel exists", () => {
    const events = makeEvents();
    const pcs: FakePeerConnection[] = [];
    const peer = new Peer("coordinator", "coord-1", makeFactory(pcs), events);

    expect(peer.sendMessage("hi")).toBe(false);
    expect(events.onError).toHaveBeenCalledWith("No data channel");
  });

  it("forwards inbound data-channel messages to the owner", async () => {
    const events = makeEvents();
    const pcs: FakePeerConnection[] = [];
    const peer = new Peer("coordinator", "coord-1", makeFactory(pcs), events);
    await peer.initiate("worker-1");

    const dc = pcs[0].createdChannels[0] as unknown as FakeDataChannel;
    dc.fireMessage("HELLO");
    expect(events.onDataChannelMessage).toHaveBeenCalledWith("HELLO");
  });

  it("sends when open and reports an error otherwise", async () => {
    const events = makeEvents();
    const pcs: FakePeerConnection[] = [];
    const peer = new Peer("coordinator", "coord-1", makeFactory(pcs), events);
    await peer.initiate("worker-1");
    const dc = pcs[0].createdChannels[0] as unknown as FakeDataChannel;

    expect(peer.sendMessage("x")).toBe(false);
    expect(events.onError).toHaveBeenCalledWith(expect.stringContaining("not open"));

    dc.fireOpen();
    expect(peer.sendMessage("hi")).toBe(true);
    expect(dc.sent).toContain("hi");
  });

  it("close() tears the peer down and blocks further sends", async () => {
    const events = makeEvents();
    const pcs: FakePeerConnection[] = [];
    const peer = new Peer("coordinator", "coord-1", makeFactory(pcs), events);
    await peer.initiate("worker-1");

    peer.close();
    expect(pcs[0].closed).toBe(true);
    expect(peer.connectionState).toBe("closed");
    expect(() => peer.close()).not.toThrow();
    expect(peer.sendMessage("late")).toBe(false);
  });
});

describe("Peer — worker data channel delivery", () => {
  it("delivers a remote-created data channel and forwards messages", async () => {
    const events = makeEvents();
    const pcs: FakePeerConnection[] = [];
    const peer = new Peer("worker", "worker-1", makeFactory(pcs), events);

    await peer.handleOffer("coord-1", { type: "offer", sdp: "o" });
    const dc = new FakeDataChannel("resumedrop");
    pcs[0].fireDataChannel(dc);
    dc.fireOpen();

    expect(peer.dataChannelState).toBe("open");
    expect(events.onDataChannelOpen).toHaveBeenCalled();
    dc.fireMessage("PING");
    expect(events.onDataChannelMessage).toHaveBeenCalledWith("PING");
  });
});

describe("Peer — connection-state transitions", () => {
  it("reports connection-state changes via onState", async () => {
    const events = makeEvents();
    const pcs: FakePeerConnection[] = [];
    const peer = new Peer("worker", "worker-1", makeFactory(pcs), events);
    await peer.handleOffer("coord-1", { type: "offer", sdp: "o" });

    pcs[0].setConnectionState("connected" as PeerConnectionState);
    expect(events.onState).toHaveBeenLastCalledWith("connected");
  });
});
