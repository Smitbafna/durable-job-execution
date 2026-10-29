/**
 * ResumeDrop — runtime message validation.
 *
 * Validates untrusted inbound messages field by field. Malformed input yields a
 * typed failure (`false`) rather than a crash, so the signaling server can
 * reject bad messages and the browser clients can guard incoming data.
 */

import { MessageType } from "./messages.js";
import type {
  BaseMessage,
  BaseMessageFields,
  ClientMessage,
  CoordinatorRegisterMsg,
  WorkerRegisterMsg,
  WorkerDiscoveryRequestMsg,
  WorkerDiscoveryResponseMsg,
  WebrtcOfferMsg,
  WebrtcAnswerMsg,
  WebrtcIceCandidateMsg,
  ICECandidateInit,
  DisconnectMsg,
} from "./messages.js";

function isValidUuid(uuid: unknown): uuid is string {
  // Accepts canonical UUID forms. The clientId is an identifier only — it is
  // never trusted as authentication.
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return typeof uuid === "string" && uuidPattern.test(uuid);
}

function isValidTimestamp(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && ts >= 0;
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

/**
 * Validates a base message: non-empty `type` string and a finite,
 * non-negative `timestamp`.
 */
export function validateBaseMessage(
  msg: unknown,
): msg is BaseMessageFields {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return isNonEmptyString(m.type) && isValidTimestamp(m.timestamp);
}

/**
 * Validates a client-originated message: base fields plus a UUID `clientId`.
 */
export function validateClientMessage(msg: unknown): msg is ClientMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (!validateBaseMessage(msg)) return false;
  if (!isNonEmptyString(m.clientId)) return false;
  if (!isValidUuid(m.clientId)) return false;
  return true;
}

function typeToRole(type: string): "coordinator" | "worker" | null {
  if (type === MessageType.CoordinatorRegister) return "coordinator";
  if (type === MessageType.WorkerRegister) return "worker";
  return null;
}

/**
 * Validates a registration message (`COORDINATOR_REGISTER` / `WORKER_REGISTER`).
 * Requires a valid `clientId`, a `role` matching the message type, and
 * (optionally) a `capabilities` array of non-empty strings.
 */
export function validateRegistrationMsg(
  msg: unknown,
): msg is CoordinatorRegisterMsg | WorkerRegisterMsg {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (!validateClientMessage(msg)) return false;

  const type = m.type as string;
  if (
    type !== MessageType.CoordinatorRegister &&
    type !== MessageType.WorkerRegister
  ) {
    return false;
  }

  if (m.role !== "coordinator" && m.role !== "worker") return false;
  if (m.role !== typeToRole(type)) return false;

  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities)) return false;
    for (const cap of m.capabilities) {
      if (!isNonEmptyString(cap)) return false;
    }
  }
  return true;
}

// === ResumeDrop validators part 2 (discovery, signaling, control) ===

/**
 * Validates a worker-discovery request from a client. Requires a valid
 * `clientId` and the `WORKER_DISCOVERY_REQUEST` type.
 */
export function validateDiscoveryRequestMsg(
  msg: unknown,
): msg is WorkerDiscoveryRequestMsg {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (!validateClientMessage(msg)) return false;
  return m.type === MessageType.WorkerDiscoveryRequest;
}

/**
 * Validates the server-originated discovery response. `workers` must be an
 * array of `{ clientId, role }` pairs.
 */
export function validateDiscoveryResponseMsg(
  msg: unknown,
): msg is WorkerDiscoveryResponseMsg {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (!validateBaseMessage(msg)) return false;
  if (m.type !== MessageType.WorkerDiscoveryResponse) return false;
  if (!Array.isArray(m.workers)) return false;
  for (const w of m.workers) {
    if (typeof w !== "object" || w === null) return false;
    const pw = w as Record<string, unknown>;
    if (!isNonEmptyString(pw.clientId)) return false;
    if (pw.role !== "coordinator" && pw.role !== "worker") return false;
  }
  return true;
}

function isValidPairId(id: unknown): id is string {
  return isNonEmptyString(id);
}

function isValidSdp(sdp: unknown): sdp is string {
  return isNonEmptyString(sdp);
}

function isValidCandidateInit(cand: unknown): cand is ICECandidateInit {
  if (typeof cand !== "object" || cand === null) return false;
  return true;
}

/**
 * Validates a WebRTC offer message: type, valid `clientId`, and
 * non-empty `senderId`, `receiverId`, and `sdp`.
 */
export function validateWebrtcOfferMsg(
  msg: unknown,
): msg is WebrtcOfferMsg {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (!validateClientMessage(msg)) return false;
  if (m.type !== MessageType.WebrtcOffer) return false;
  return (
    isValidPairId(m.senderId) &&
    isValidPairId(m.receiverId) &&
    isValidSdp(m.sdp)
  );
}

/**
 * Validates a WebRTC answer message.
 */
export function validateWebrtcAnswerMsg(
  msg: unknown,
): msg is WebrtcAnswerMsg {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (!validateClientMessage(msg)) return false;
  if (m.type !== MessageType.WebrtcAnswer) return false;
  return (
    isValidPairId(m.senderId) &&
    isValidPairId(m.receiverId) &&
    isValidSdp(m.sdp)
  );
}

/**
 * Validates a WebRTC ICE candidate message. `candidate` must be a non-null
 * object (an `RTCIceCandidateInit` literal).
 */
export function validateWebrtcIceCandidateMsg(
  msg: unknown,
): msg is WebrtcIceCandidateMsg {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (!validateClientMessage(msg)) return false;
  if (m.type !== MessageType.WebrtcIceCandidate) return false;
  if (!isValidPairId(m.senderId) || !isValidPairId(m.receiverId)) return false;
  if (!isValidCandidateInit(m.candidate)) return false;
  return true;
}

/**
 * Validates a `DISCONNECT` message from a client.
 */
export function validateDisconnectMsg(msg: unknown): msg is DisconnectMsg {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (!validateClientMessage(msg)) return false;
  if (m.type !== MessageType.Disconnect) return false;
  const reason = m.reason;
  return reason === "normal" || reason === "timeout" || reason === "error";
}

