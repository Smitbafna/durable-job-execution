/**
 * ResumeDrop — shared protocol validator tests.
 *
 * Exercises the runtime validators against well-formed and malformed inputs,
 * covering each message kind relevant to Milestone 01 (registration, discovery,
 * WebRTC offer/answer/ICE candidate, disconnect) plus the base/client helpers.
 */
import { describe, it, expect } from "vitest";
import {
  MessageType,
  validateBaseMessage,
  validateClientMessage,
  validateRegistrationMsg,
  validateDiscoveryRequestMsg,
  validateDiscoveryResponseMsg,
  validateWebrtcOfferMsg,
  validateWebrtcAnswerMsg,
  validateWebrtcIceCandidateMsg,
  validateDisconnectMsg,
} from "../index";

const VALID_UUID = "123e4567-e89b-41d4-a716-446655440000";
const now = () => 1_700_000_000_000;

function base(t: string, extra: Record<string, unknown> = {}) {
  return { type: t, timestamp: now(), ...extra };
}

describe("base + client message validation", () => {
  it("accepts a well-formed base message", () => {
    expect(validateBaseMessage(base(MessageType.Error))).toBe(true);
  });

  it("rejects non-objects, null, arrays", () => {
    expect(validateBaseMessage(null)).toBe(false);
    expect(validateBaseMessage("string")).toBe(false);
    expect(validateBaseMessage([1, 2, 3])).toBe(false);
  });

  it("rejects missing/empty type or bad timestamp", () => {
    expect(validateBaseMessage({ timestamp: now() })).toBe(false);
    expect(validateBaseMessage({ type: "", timestamp: now() })).toBe(false);
    expect(validateBaseMessage({ type: MessageType.Error, timestamp: "nope" })).toBe(false);
    expect(validateBaseMessage({ type: MessageType.Error, timestamp: -1 })).toBe(false);
    expect(validateBaseMessage({ type: MessageType.Error, timestamp: NaN })).toBe(false);
  });

  it("accepts a client message with a valid UUID clientId", () => {
    expect(validateClientMessage(base(MessageType.Error, { clientId: VALID_UUID }))).toBe(true);
  });

  it("rejects a client message with a malformed clientId", () => {
    expect(validateClientMessage(base(MessageType.Error, { clientId: "not-a-uuid" }))).toBe(false);
    expect(validateClientMessage(base(MessageType.Error, { clientId: "" }))).toBe(false);
    expect(validateClientMessage(base(MessageType.Error, {}))).toBe(false);
  });
});

describe("registration validation", () => {
  it("accepts a valid coordinator registration", () => {
    expect(
      validateRegistrationMsg(
        base(MessageType.CoordinatorRegister, { clientId: VALID_UUID, role: "coordinator" }),
      ),
    ).toBe(true);
  });

  it("accepts a valid worker registration with capabilities", () => {
    expect(
      validateRegistrationMsg(
        base(MessageType.WorkerRegister, {
          clientId: VALID_UUID,
          role: "worker",
          capabilities: ["compute"],
        }),
      ),
    ).toBe(true);
  });

  it("rejects role/type mismatch", () => {
    expect(
      validateRegistrationMsg(
        base(MessageType.CoordinatorRegister, { clientId: VALID_UUID, role: "worker" }),
      ),
    ).toBe(false);
    expect(
      validateRegistrationMsg(
        base(MessageType.WorkerRegister, { clientId: VALID_UUID, role: "coordinator" }),
      ),
    ).toBe(false);
  });

  it("rejects bad capabilities", () => {
    expect(
      validateRegistrationMsg(
        base(MessageType.WorkerRegister, {
          clientId: VALID_UUID,
          role: "worker",
          capabilities: [123],
        }),
      ),
    ).toBe(false);
  });

  it("rejects missing clientId", () => {
    expect(validateRegistrationMsg(base(MessageType.WorkerRegister, { role: "worker" }))).toBe(false);
  });
});

// === ResumeDrop validators test part 2 (discovery, signaling, control) ===

describe("discovery validation", () => {
  it("accepts a discovery request", () => {
    expect(
      validateDiscoveryRequestMsg(
        base(MessageType.WorkerDiscoveryRequest, { clientId: VALID_UUID }),
      ),
    ).toBe(true);
  });

  it("rejects a non-discovery type as a discovery request", () => {
    expect(validateDiscoveryRequestMsg(base(MessageType.Error, { clientId: VALID_UUID }))).toBe(false);
  });

  it("accepts a well-formed discovery response", () => {
    expect(
      validateDiscoveryResponseMsg(
        base(MessageType.WorkerDiscoveryResponse, {
          workers: [{ clientId: VALID_UUID, role: "worker" }],
        }),
      ),
    ).toBe(true);
  });

  it("rejects a discovery response with malformed workers", () => {
    expect(
      validateDiscoveryResponseMsg(
        base(MessageType.WorkerDiscoveryResponse, {
          workers: [{ clientId: "", role: "worker" }],
        }),
      ),
    ).toBe(false);
    expect(
      validateDiscoveryResponseMsg(base(MessageType.WorkerDiscoveryResponse, { workers: "nope" })),
    ).toBe(false);
  });
});

describe("webrtc signaling validation", () => {
  const candidate = {
    candidate: "candidate:0 1 udp 1 1.2.3.4 1234 typ host",
    sdpMid: "0",
  };

  it("accepts an offer with sender/receiver/sdp", () => {
    expect(
      validateWebrtcOfferMsg(
        base(MessageType.WebrtcOffer, {
          clientId: VALID_UUID,
          senderId: "sender",
          receiverId: "receiver",
          sdp: "v=0...",
        }),
      ),
    ).toBe(true);
  });

  it("rejects an offer missing receiverId or sdp", () => {
    expect(
      validateWebrtcOfferMsg(
        base(MessageType.WebrtcOffer, { clientId: VALID_UUID, senderId: "s", sdp: "x" }),
      ),
    ).toBe(false);
    expect(
      validateWebrtcOfferMsg(
        base(MessageType.WebrtcOffer, {
          clientId: VALID_UUID,
          senderId: "s",
          receiverId: "r",
        }),
      ),
    ).toBe(false);
  });

  it("accepts an answer", () => {
    expect(
      validateWebrtcAnswerMsg(
        base(MessageType.WebrtcAnswer, {
          clientId: VALID_UUID,
          senderId: "s",
          receiverId: "r",
          sdp: "v=0...",
        }),
      ),
    ).toBe(true);
  });

  it("accepts a valid ICE candidate and rejects a null candidate", () => {
    expect(
      validateWebrtcIceCandidateMsg(
        base(MessageType.WebrtcIceCandidate, {
          clientId: VALID_UUID,
          senderId: "s",
          receiverId: "r",
          candidate,
        }),
      ),
    ).toBe(true);
    expect(
      validateWebrtcIceCandidateMsg(
        base(MessageType.WebrtcIceCandidate, {
          clientId: VALID_UUID,
          senderId: "s",
          receiverId: "r",
          candidate: null,
        }),
      ),
    ).toBe(false);
  });
});

describe("disconnect validation", () => {
  it("accepts a valid disconnect reason", () => {
    expect(
      validateDisconnectMsg(
        base(MessageType.Disconnect, { clientId: VALID_UUID, reason: "normal" }),
      ),
    ).toBe(true);
  });

  it("rejects an invalid reason", () => {
    expect(
      validateDisconnectMsg(
        base(MessageType.Disconnect, { clientId: VALID_UUID, reason: "bye" }),
      ),
    ).toBe(false);
  });
});

