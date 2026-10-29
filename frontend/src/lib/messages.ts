/**
 * ResumeDrop — signaling message construction + discrimination helpers.
 *
 * Builds the typed envelopes the browser sends over the WebSocket (using the
 * shared protocol types from `@resumedrop/shared`) and provides lightweight
 * `unknown`-accepting predicates so the receiving side can safely dispatch
 * untrusted inbound messages field-by-field.
 */
import type {
  CoordinatorRegisterMsg,
  WorkerRegisterMsg,
  WebrtcOfferMsg,
  WebrtcAnswerMsg,
  WebrtcIceCandidateMsg,
  Role,
  PeerInfo,
  ICECandidateInit,
  RegistrationSuccessMsg,
  WorkerDiscoveryResponseMsg,
  ErrorMsg,
} from "@resumedrop/shared";
import { MessageType } from "@resumedrop/shared";

/** Registration payload for the chosen role. */
export function registrationFor(
  role: Role,
  clientId: string,
): CoordinatorRegisterMsg | WorkerRegisterMsg {
  const timestamp = Date.now();
  return role === "coordinator"
    ? { type: MessageType.CoordinatorRegister, timestamp, clientId, role }
    : { type: MessageType.WorkerRegister, timestamp, clientId, role };
}

export function offerMessage(
  senderId: string,
  receiverId: string,
  sdp: string,
): WebrtcOfferMsg {
  return {
    type: MessageType.WebrtcOffer,
    timestamp: Date.now(),
    clientId: senderId,
    senderId,
    receiverId,
    sdp,
  };
}

export function answerMessage(
  senderId: string,
  receiverId: string,
  sdp: string,
): WebrtcAnswerMsg {
  return {
    type: MessageType.WebrtcAnswer,
    timestamp: Date.now(),
    clientId: senderId,
    senderId,
    receiverId,
    sdp,
  };
}

/** Minimal subset of RTCIceCandidateInit we forward over the wire. */
export interface IceSignal {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export function iceMessage(
  senderId: string,
  receiverId: string,
  ice: IceSignal,
): WebrtcIceCandidateMsg {
  const candidate: ICECandidateInit = {
    candidate: ice.candidate,
    sdpMid: ice.sdpMid ?? null,
    sdpMLineIndex: ice.sdpMLineIndex ?? null,
    usernameFragment: ice.usernameFragment ?? undefined,
  };
  return {
    type: MessageType.WebrtcIceCandidate,
    timestamp: Date.now(),
    clientId: senderId,
    senderId,
    receiverId,
    candidate,
    sdpMid: ice.sdpMid ?? undefined,
    sdpMLineIndex: ice.sdpMLineIndex ?? undefined,
  };
}

function field(msg: unknown, key: string): unknown {
  return typeof msg === "object" && msg !== null
    ? (msg as Record<string, unknown>)[key]
    : undefined;
}

export function isRegistrationSuccess(msg: unknown): msg is RegistrationSuccessMsg {
  return field(msg, "type") === MessageType.RegistrationSuccess;
}
export function isDiscoveryResponse(msg: unknown): msg is WorkerDiscoveryResponseMsg {
  return field(msg, "type") === MessageType.WorkerDiscoveryResponse;
}
export function isOffer(msg: unknown): msg is WebrtcOfferMsg {
  return field(msg, "type") === MessageType.WebrtcOffer;
}
export function isAnswer(msg: unknown): msg is WebrtcAnswerMsg {
  return field(msg, "type") === MessageType.WebrtcAnswer;
}
export function isIce(msg: unknown): msg is WebrtcIceCandidateMsg {
  return field(msg, "type") === MessageType.WebrtcIceCandidate;
}
export function isServerError(msg: unknown): msg is ErrorMsg {
  return field(msg, "type") === MessageType.Error;
}

export function extractWorkers(response: WorkerDiscoveryResponseMsg): PeerInfo[] {
  return Array.isArray(response.workers) ? response.workers : [];
}
