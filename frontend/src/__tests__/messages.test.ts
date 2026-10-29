import { describe, expect, it } from "vitest";
import { MessageType } from "@resumedrop/shared";
import type { WorkerDiscoveryResponseMsg } from "@resumedrop/shared";
import {
  registrationFor,
  offerMessage,
  answerMessage,
  iceMessage,
  extractWorkers,
  isOffer,
  isAnswer,
  isIce,
  isRegistrationSuccess,
  isServerError,
  isDiscoveryResponse,
} from "../lib/messages";

describe("registrationFor", () => {
  it("builds a coordinator registration", () => {
    const m = registrationFor("coordinator", "abc");
    expect(m.type).toBe(MessageType.CoordinatorRegister);
    expect(m.role).toBe("coordinator");
    expect(m.clientId).toBe("abc");
    expect(typeof m.timestamp).toBe("number");
  });

  it("builds a worker registration", () => {
    const m = registrationFor("worker", "xyz");
    expect(m.type).toBe(MessageType.WorkerRegister);
    expect(m.role).toBe("worker");
    expect(m.clientId).toBe("xyz");
  });
});

describe("offer/answer/ice messages", () => {
  it("offerMessage is recognised as an offer", () => {
    const m = offerMessage("c1", "w1", "sdp-x");
    expect(isOffer(m)).toBe(true);
    expect(m.senderId).toBe("c1");
    expect(m.receiverId).toBe("w1");
    expect(m.sdp).toBe("sdp-x");
  });

  it("answerMessage is recognised as an answer", () => {
    const m = answerMessage("w1", "c1", "sdp-y");
    expect(isAnswer(m)).toBe(true);
    expect(m.senderId).toBe("w1");
    expect(m.receiverId).toBe("c1");
    expect(m.sdp).toBe("sdp-y");
  });

  it("iceMessage carries candidate fields", () => {
    const m = iceMessage("c1", "w1", {
      candidate: "cand",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "ufrag",
    });
    expect(isIce(m)).toBe(true);
    expect(m.candidate.candidate).toBe("cand");
    expect(m.candidate.sdpMid).toBe("0");
    expect(m.candidate.sdpMLineIndex).toBe(0);
    expect(m.candidate.usernameFragment).toBe("ufrag");
  });

  it("iceMessage tolerates missing candidate fields", () => {
    const m = iceMessage("c1", "w1", {});
    expect(isIce(m)).toBe(true);
    expect(m.candidate.candidate).toBeUndefined();
  });
});

describe("discovery + dispatch predicates", () => {
  it("extractWorkers returns the worker list", () => {
    const resp: WorkerDiscoveryResponseMsg = {
      type: MessageType.WorkerDiscoveryResponse,
      timestamp: 0,
      workers: [{ clientId: "w1", role: "worker" }],
    };
    expect(isDiscoveryResponse(resp)).toBe(true);
    expect(extractWorkers(resp).map((w) => w.clientId)).toEqual(["w1"]);
  });

  it("predicates discriminate by type", () => {
    expect(
      isRegistrationSuccess({
        type: MessageType.RegistrationSuccess,
        timestamp: 0,
        clientId: "x",
        role: "coordinator",
      }),
    ).toBe(true);
    expect(
      isServerError({ type: MessageType.Error, timestamp: 0, code: "E", message: "m" }),
    ).toBe(true);
    expect(
      isOffer({
        type: MessageType.WebrtcOffer,
        timestamp: 0,
        clientId: "a",
        senderId: "a",
        receiverId: "b",
        sdp: "s",
      }),
    ).toBe(true);
    expect(
      isAnswer({
        type: MessageType.WebrtcAnswer,
        timestamp: 0,
        clientId: "a",
        senderId: "a",
        receiverId: "b",
        sdp: "s",
      }),
    ).toBe(true);
    expect(
      isIce({
        type: MessageType.WebrtcIceCandidate,
        timestamp: 0,
        clientId: "a",
        senderId: "a",
        receiverId: "b",
        candidate: {},
      }),
    ).toBe(true);
  });

  it("rejects non-objects and mismatched types", () => {
    expect(isOffer(null)).toBe(false);
    expect(isOffer(undefined)).toBe(false);
    expect(isOffer({})).toBe(false);
    expect(isOffer({ type: MessageType.WebrtcAnswer })).toBe(false);
    expect(
      extractWorkers(
        {
          type: MessageType.WorkerDiscoveryResponse,
          timestamp: 0,
          workers: [],
        } as WorkerDiscoveryResponseMsg,
      ).map((w) => w.clientId),
    ).toEqual([]);
  });
});
