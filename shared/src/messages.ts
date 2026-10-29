/**
 * ResumeDrop — shared protocol message types.
 *
 * Defines the typed message shapes exchanged between browser clients and the
 * WebSocket signaling server. Each message carries a `type` discriminator and a
 * `timestamp`. Client-originated messages additionally carry a `clientId`
 * (an identifier only — not authentication). Signaling messages (offer /
 * answer / ICE) are always addressed to a specific `receiverId`; the server
 * routes them point-to-point and never broadcasts them to every client.
 */

// --- Message type discriminator ------------------------------------------------

export enum MessageType {
  // Registration
  CoordinatorRegister = "COORDINATOR_REGISTER",
  WorkerRegister = "WORKER_REGISTER",
  RegistrationSuccess = "REGISTRATION_SUCCESS",

  // Discovery
  WorkerDiscoveryRequest = "WORKER_DISCOVERY_REQUEST",
  WorkerDiscoveryResponse = "WORKER_DISCOVERY_RESPONSE",

  // WebRTC signaling
  WebrtcOffer = "WEBRTC_OFFER",
  WebrtcAnswer = "WEBRTC_ANSWER",
  WebrtcIceCandidate = "WEBRTC_ICE_CANDIDATE",

  // Control / error
  Error = "ERROR",
  Disconnect = "DISCONNECT",
}

// --- Base fields --------------------------------------------------------------

export interface BaseMessage {
  type: MessageType;
  timestamp: number;
}

/** Alias retained for compatibility with callers that validate base fields. */
export type BaseMessageFields = BaseMessage;

/** Server-originated message (no clientId required). */
export interface ServerMessage extends BaseMessage {}

/** Client-originated message (includes the sender's clientId). */
export interface ClientMessage extends BaseMessage {
  clientId: string;
}

// --- Registration -------------------------------------------------------------

export const VALID_ROLES = ["coordinator", "worker"] as const;
export type Role = (typeof VALID_ROLES)[number];

export interface CoordinatorRegisterMsg extends ClientMessage {
  type: MessageType.CoordinatorRegister;
  role: "coordinator";
  /** Optional worker capabilities (not used in Milestone 01). */
  capabilities?: string[];
}

export interface WorkerRegisterMsg extends ClientMessage {
  type: MessageType.WorkerRegister;
  role: "worker";
  capabilities?: string[];
}

/** Acknowledgement sent by the server after a successful registration. */
export interface RegistrationSuccessMsg extends BaseMessage {
  type: MessageType.RegistrationSuccess;
  clientId: string;
  role: Role;
}

// --- Discovery ----------------------------------------------------------------

export interface PeerInfo {
  clientId: string;
  role: Role;
}

/** Sent by a coordinator to request the current set of registered workers. */
export interface WorkerDiscoveryRequestMsg extends ClientMessage {
  type: MessageType.WorkerDiscoveryRequest;
}

/** Sent by the server (in response to a request, or as a push to coordinators). */
export interface WorkerDiscoveryResponseMsg extends BaseMessage {
  type: MessageType.WorkerDiscoveryResponse;
  workers: PeerInfo[];
}

// --- WebRTC signaling ---------------------------------------------------------

export interface WebrtcOfferMsg extends ClientMessage {
  type: MessageType.WebrtcOffer;
  senderId: string;
  receiverId: string;
  sdp: string;
}

export interface WebrtcAnswerMsg extends ClientMessage {
  type: MessageType.WebrtcAnswer;
  senderId: string;
  receiverId: string;
  sdp: string;
}

/**
 * Portable subset of the browser's `RTCIceCandidateInit`. Declared locally so
 * the shared package type-checks under both Node (signaling server, no DOM lib)
 * and the browser (which has the full DOM type). The shapes are structurally
 * identical, so a value of this type is assignable to the DOM overload of
 * `RTCPeerConnection.addIceCandidate`.
 */
export interface ICECandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string;
}

export interface WebrtcIceCandidateMsg extends ClientMessage {
  type: MessageType.WebrtcIceCandidate;
  senderId: string;
  receiverId: string;
  candidate: ICECandidateInit;
  sdpMid?: string;
  sdpMLineIndex?: number | null;
}

// --- Control / error ----------------------------------------------------------

export interface ErrorMsg extends BaseMessage {
  type: MessageType.Error;
  code: string;
  message: string;
}

export interface DisconnectMsg extends BaseMessage {
  type: MessageType.Disconnect;
  reason: "normal" | "timeout" | "error";
}

// --- Union --------------------------------------------------------------------

export type AllMessages =
  | CoordinatorRegisterMsg
  | WorkerRegisterMsg
  | RegistrationSuccessMsg
  | WorkerDiscoveryRequestMsg
  | WorkerDiscoveryResponseMsg
  | WebrtcOfferMsg
  | WebrtcAnswerMsg
  | WebrtcIceCandidateMsg
  | ErrorMsg
  | DisconnectMsg;

/** Narrowed union of messages that may be routed between peers. */
export type RoutedMessage =
  | WebrtcOfferMsg
  | WebrtcAnswerMsg
  | WebrtcIceCandidateMsg;

// --- Type guards --------------------------------------------------------------

export function isCoordinatorRegisterMsg(
  msg: BaseMessage,
): msg is CoordinatorRegisterMsg {
  return msg.type === MessageType.CoordinatorRegister;
}

export function isWorkerRegisterMsg(msg: BaseMessage): msg is WorkerRegisterMsg {
  return msg.type === MessageType.WorkerRegister;
}

export function isRegistrationSuccessMsg(
  msg: BaseMessage,
): msg is RegistrationSuccessMsg {
  return msg.type === MessageType.RegistrationSuccess;
}

export function isWorkerDiscoveryRequestMsg(
  msg: BaseMessage,
): msg is WorkerDiscoveryRequestMsg {
  return msg.type === MessageType.WorkerDiscoveryRequest;
}

export function isWorkerDiscoveryResponseMsg(
  msg: BaseMessage,
): msg is WorkerDiscoveryResponseMsg {
  return msg.type === MessageType.WorkerDiscoveryResponse;
}

export function isWebrtcOfferMsg(msg: BaseMessage): msg is WebrtcOfferMsg {
  return msg.type === MessageType.WebrtcOffer;
}

export function isWebrtcAnswerMsg(msg: BaseMessage): msg is WebrtcAnswerMsg {
  return msg.type === MessageType.WebrtcAnswer;
}

export function isWebrtcIceCandidateMsg(
  msg: BaseMessage,
): msg is WebrtcIceCandidateMsg {
  return msg.type === MessageType.WebrtcIceCandidate;
}

export function isErrorMsg(msg: BaseMessage): msg is ErrorMsg {
  return msg.type === MessageType.Error;
}

export function isDisconnectMsg(msg: BaseMessage): msg is DisconnectMsg {
  return msg.type === MessageType.Disconnect;
}
