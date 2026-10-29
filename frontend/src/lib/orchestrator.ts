/**
 * ResumeDrop — high-level coordinator/worker orchestration.
 *
 * `WebRTCOrchestrator` binds three concerns together:
 *  1. the signaling transport (send/recv JSON envelopes),
 *  2. a `Peer` (offer/answer, ICE, data channel),
 *  3. a serializable `state` snapshot consumed by the UI (and by the automated
 *     browser tests) plus an `onChange` callback that triggers re-renders.
 *
 * It is transport-agnostic and connection-factory agnostic, so the entire
 * message-routing state machine is covered by synchronous unit tests with
 * fakes, while the browser runs the same code against the real WebSocket and
 * real `RTCPeerConnection`.
 */
import type { Role, PeerInfo, AllMessages } from "@resumedrop/shared";
import type { PeerConnectionLike } from "./peer";
import {
  Peer,
  defaultPeerConnectionFactory,
  type PeerEvents,
  type PeerConnectionState,
} from "./peer";
import type { SignalingTransport, SignalingStatus } from "./signaling";
import {
  offerMessage,
  answerMessage,
  iceMessage,
  isAnswer,
  isIce,
  isOffer,
  isRegistrationSuccess,
  isServerError,
  isDiscoveryResponse,
  extractWorkers,
} from "./messages";

export interface OrchestratorState {
  clientId: string;
  role: Role | null;
  wsStatus: SignalingStatus;
  registered: boolean;
  workers: PeerInfo[];
  peerConnectionState: string;
  dataChannelState: string;
  sent: string[];
  received: string[];
  error: string | null;
}

export type { PeerConnectionState };

const blankPeerStates = (): { peerConnectionState: string; dataChannelState: string } => ({
  peerConnectionState: "closed",
  dataChannelState: "closed",
});

/** Minimal shape we forward into `setRemoteDescription`. */
interface SdpLike {
  type: "offer" | "answer";
  sdp: string;
}
function toSdp(sdpString: string, type: "offer" | "answer"): SdpLike {
  return { type, sdp: sdpString ?? "" };
}

export class WebRTCOrchestrator {
  readonly clientId: string;
  state: OrchestratorState;
  private peer: Peer | null = null;
  private onChangeHandler: (() => void) | null = null;
  private readonly createConnection: () => PeerConnectionLike;
  private readonly transport: SignalingTransport;

  constructor(
    clientId: string,
    transport: SignalingTransport,
    createConnection: () => PeerConnectionLike = defaultPeerConnectionFactory(),
  ) {
    this.clientId = clientId;
    this.createConnection = createConnection;
    this.transport = transport;
    this.state = {
      clientId,
      role: null,
      wsStatus: transport.status,
      registered: false,
      workers: [],
      ...blankPeerStates(),
      sent: [],
      received: [],
      error: null,
    };

    this.transport.onMessage = (msg: unknown) => this.handleMessage(msg as AllMessages);
    this.transport.onStatus = (status: SignalingStatus) => {
      this.state.wsStatus = status;
      if (status === "open" && this.state.role) {
        // Re-register on every (re)connect so the server re-binds this tab ID.
        this.transport.register?.(this.state.role);
      }
      if (status !== "open" && status !== "connecting") {
        this.teardownPeer();
      }
      this.render();
    };
    this.transport.onError = (message: string) => {
      this.state.error = message;
      this.render();
    };
  }

  set onChange(fn: (() => void) | null) {
    this.onChangeHandler = fn;
  }
  get onChange(): (() => void) | null {
    return this.onChangeHandler;
  }

  private render(): void {
    this.onChangeHandler?.();
  }

  setRole(role: Role): void {
    if (this.state.role && this.state.role !== role) {
      this.teardownPeer();
    }
    this.state.role = role;
    this.state.workers = [];
    this.state.registered = false;
    this.state.error = null;
    this.render();
  }

  /** Open the signaling socket (the transport auto-registers on open). */
  connect(): void {
    if (!this.state.role) {
      this.state.error = "Select a role before connecting";
      this.render();
      return;
    }
    this.teardownPeer();
    this.transport.connect();
    this.render();
  }

  /** Stop the signaling socket and tear the WebRTC peer down. */
  disconnect(): void {
    this.transport.stop?.();
    this.teardownPeer();
    this.state.registered = false;
    this.render();
  }

  /** Send a text frame over the established data channel. */
  send(text: string): boolean {
    if (!this.peer) {
      this.state.error = "No peer connection";
      this.render();
      return false;
    }
    const ok = this.peer.sendMessage(text);
    if (ok) {
      this.state.sent.push(text);
    }
    this.render();
    return ok;
  }

  /** Coordinator only: connect to a specific worker ID. */
  connectTo(workerId: string): void {
    if (this.state.role !== "coordinator") {
      this.state.error = "Only the coordinator can start a connection";
      this.render();
      return;
    }
    if (!this.state.registered) {
      this.state.error = "Wait until registration succeeds";
      this.render();
      return;
    }
    this.teardownPeer();
    const peer = new Peer("coordinator", this.clientId, this.createConnection, this.peerEvents);
    this.peer = peer;
    this.state.peerConnectionState = "connecting";
    this.state.dataChannelState = "connecting";
    this.state.error = null;
    this.render();
    void peer.initiate(workerId).catch((e: unknown) => this.reportPeerError(e));
  }

  private handleOfferLocally(fromClientId: string, sdp: SdpLike): void {
    if (this.state.role !== "worker") {
      this.state.error = "Offer received but role is not worker";
      this.render();
      return;
    }
    if (!this.peer) {
      this.peer = new Peer("worker", this.clientId, this.createConnection, this.peerEvents);
    }
    this.state.peerConnectionState = "connecting";
    this.state.dataChannelState = "connecting";
    this.render();
    void this.peer.handleOffer(fromClientId, sdp).catch((e: unknown) => this.reportPeerError(e));
  }

  private handleAnswerLocally(fromClientId: string, sdp: SdpLike): void {
    if (!this.peer) {
      this.state.error = "Answer received with no pending connection";
      this.render();
      return;
    }
    this.state.peerConnectionState = "connecting";
    this.render();
    void this.peer.handleAnswer(fromClientId, sdp).catch((e: unknown) => this.reportPeerError(e));
  }

  private teardownPeer(): void {
    if (this.peer) {
      this.peer.close();
      this.peer = null;
    }
    Object.assign(this.state, blankPeerStates());
    this.render();
  }

  private reportPeerError(e: unknown): void {
    this.state.error = (e as Error)?.message ?? String(e);
    this.render();
  }

  /** Wire a freshly created Peer so its events flow into state + transport. */
  private peerEvents: PeerEvents = {
    onSignal: (sdp, kind) => {
      if (!this.peer) return;
      const to = this.peer.peerClientId;
      if (!to) return;
      if (kind === "offer") {
        this.transport.send(offerMessage(this.clientId, to, sdp.sdp));
      } else {
        this.transport.send(answerMessage(this.clientId, to, sdp.sdp));
      }
      this.render();
    },
    onIce: (cand) => {
      if (!this.peer) return;
      const to = this.peer.peerClientId;
      if (!to) return;
      this.transport.send(
        iceMessage(this.clientId, to, {
          candidate: cand.candidate,
          sdpMid: cand.sdpMid,
          sdpMLineIndex: cand.sdpMLineIndex,
          usernameFragment: cand.usernameFragment,
        }),
      );
    },
    onDataChannelOpen: () => {
      this.state.dataChannelState = "open";
      this.state.peerConnectionState = this.peer?.connectionState ?? "connected";
      this.state.error = null;
      this.render();
    },
    onDataChannelMessage: (data) => {
      this.state.received.push(data);
      this.render();
    },
    onDataChannelClosed: () => {
      this.state.dataChannelState = "closed";
      this.render();
    },
    onState: (state: PeerConnectionState) => {
      this.state.peerConnectionState = state;
      this.state.dataChannelState = this.peer?.dataChannelState ?? "closed";
      this.render();
    },
    onError: (message) => {
      this.state.error = message;
      this.render();
    },
  };

  private handleMessage(msg: AllMessages): void {
    if (isRegistrationSuccess(msg)) {
      this.state.registered = true;
      this.state.role = msg.role;
      this.state.error = null;
      this.render();
      return;
    }
    if (isServerError(msg)) {
      this.state.registered = false;
      this.state.error = "Server error " + msg.code + ": " + msg.message;
      this.render();
      return;
    }
    if (isDiscoveryResponse(msg)) {
      this.state.workers = extractWorkers(msg);
      this.render();
      return;
    }
    if (isOffer(msg)) {
      this.handleOfferLocally(msg.senderId, toSdp(msg.sdp, "offer"));
      return;
    }
    if (isAnswer(msg)) {
      this.handleAnswerLocally(msg.senderId, toSdp(msg.sdp, "answer"));
      return;
    }
    if (isIce(msg)) {
      if (this.peer) {
        this.peer.handleIceCandidate({
          candidate: msg.candidate?.candidate,
          sdpMid: msg.candidate?.sdpMid ?? null,
          sdpMLineIndex: msg.candidate?.sdpMLineIndex ?? null,
          usernameFragment: msg.candidate?.usernameFragment,
        });
      }
      return;
    }
    // Unknown/unhandled message type — ignore silently.
  }
}
