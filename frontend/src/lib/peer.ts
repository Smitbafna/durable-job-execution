/**
 * ResumeDrop — WebRTC peer connection abstraction.
 *
 * The `Peer` class owns a single `RTCPeerConnection` (created via an injected
 * factory) and a single `RTCDataChannel`. It is deliberately decoupled from the
 * DOM globals: production uses `RealPeerConnection` (which wraps the browser
 * `RTCPeerConnection`), while tests inject a synchronous fake. This keeps every
 * piece of orchestration logic — offer/answer sequencing, ICE candidate
 * buffering, data-channel lifecycle, and cleanup — covered by unit tests.
 */

// Minimal, DOM-free type surface so the testable logic lives in Node.
export type SdpType = "offer" | "answer" | "pranswer" | "rollback";
export interface Sdp {
  type: SdpType;
  sdp: string;
}

/** Plain object form of RTCIceCandidateInit used on the wire. */
export interface IceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type PeerConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";
export type DataChannelState = "connecting" | "open" | "closing" | "closed";

export interface DataChannelLike {
  readonly label: string;
  readonly readyState: DataChannelState;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export interface PeerConnectionLike {
  createOffer(): Promise<Sdp>;
  createAnswer(): Promise<Sdp>;
  setLocalDescription(desc: Sdp): Promise<void>;
  setRemoteDescription(desc: Sdp): Promise<void>;
  addIceCandidate(cand: IceCandidate): Promise<void>;
  createDataChannel(label: string): DataChannelLike;
  close(): void;
  readonly connectionState: PeerConnectionState;
  readonly iceConnectionState: string;
  onicecandidate: ((cand: IceCandidate | null) => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
  ondatachannel: ((channel: DataChannelLike) => void) | null;
}

/** STUN-only configuration. Restrictive NATs/firewalls need a TURN server,
 * which is intentionally out of scope for Milestone 01. */
export interface PeerConfig {
  iceServers?: { urls: string | string[] }[];
}

export function defaultIceServers(): { urls: string }[] {
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

export type PeerConnectionFactory = () => PeerConnectionLike;

export function defaultPeerConnectionFactory(
  config: PeerConfig = { iceServers: defaultIceServers() },
): PeerConnectionFactory {
  return () => new RealPeerConnection(config);
}

/** Callback surface the `Peer` reports to its owner (the orchestrator). */
export interface PeerEvents {
  onSignal?: (sdp: Sdp, kind: "offer" | "answer") => void;
  onIce?: (candidate: IceCandidate) => void;
  onDataChannelOpen?: () => void;
  onDataChannelMessage?: (data: string) => void;
  onDataChannelClosed?: () => void;
  onState?: (state: PeerConnectionState) => void;
  onError?: (message: string) => void;
}

/** Adapts the browser `RTCPeerConnection` to `PeerConnectionLike`. */
export class RealPeerConnection implements PeerConnectionLike {
  private pc: RTCPeerConnection;
  onicecandidate: ((cand: IceCandidate | null) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((channel: DataChannelLike) => void) | null = null;
  private readonly dcMap = new WeakMap<RTCDataChannel, DataChannelLike>();

  constructor(config?: PeerConfig) {
    this.pc = new RTCPeerConnection({
      iceServers: config?.iceServers,
    });
    this.pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      const c = ev.candidate;
      this.onicecandidate?.(
        c
          ? {
              candidate: c.candidate,
              sdpMid: c.sdpMid,
              sdpMLineIndex: c.sdpMLineIndex,
              usernameFragment: c.usernameFragment,
            }
          : null,
      );
    };
    this.pc.onconnectionstatechange = () => this.onconnectionstatechange?.();
    this.pc.oniceconnectionstatechange = () => this.oniceconnectionstatechange?.();
    this.pc.ondatachannel = (ev: RTCDataChannelEvent) =>
      this.ondatachannel?.(this.wrapDataChannel(ev.channel));
  }

  private wrapDataChannel(dc: RTCDataChannel): DataChannelLike {
    const existing = this.dcMap.get(dc);
    if (existing) return existing;
    const wrapped: DataChannelLike = {
      get label() {
        return dc.label;
      },
      get readyState() {
        return dc.readyState as DataChannelState;
      },
      send(data: string) {
        dc.send(data);
      },
      close() {
        dc.close();
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    dc.onopen = () => wrapped.onopen?.();
    dc.onmessage = (ev: MessageEvent) => wrapped.onmessage?.(ev.data as string);
    dc.onerror = () => wrapped.onerror?.();
    dc.onclose = () => wrapped.onclose?.();
    this.dcMap.set(dc, wrapped);
    return wrapped;
  }

  async createOffer(): Promise<Sdp> {
    const r = await this.pc.createOffer();
    return { type: r.type as SdpType, sdp: r.sdp ?? "" };
  }
  async createAnswer(): Promise<Sdp> {
    const r = await this.pc.createAnswer();
    return { type: r.type as SdpType, sdp: r.sdp ?? "" };
  }
  async setLocalDescription(desc: Sdp): Promise<void> {
    await this.pc.setLocalDescription(desc);
  }
  async setRemoteDescription(desc: Sdp): Promise<void> {
    await this.pc.setRemoteDescription(desc);
  }
  async addIceCandidate(cand: IceCandidate): Promise<void> {
    await this.pc.addIceCandidate(cand);
  }
  createDataChannel(label: string): DataChannelLike {
    return this.wrapDataChannel(this.pc.createDataChannel(label));
  }
  close(): void {
    this.pc.close();
  }
  get connectionState(): PeerConnectionState {
    return this.pc.connectionState as PeerConnectionState;
  }
  get iceConnectionState(): string {
    return this.pc.iceConnectionState;
  }
}

/**
 * Drives a single peer connection for one remote peer.
 *
 * - Coordinators call `initiate()` (creates the offer + data channel).
 * - Workers receive offers via `handleOffer()` (installs remote desc, answers).
 * - Either side applies answers/ICE via `handleAnswer`/`handleIceCandidate`.
 *
 * ICE candidates that arrive before the remote description is installed are
 * buffered and flushed once `setRemoteDescription` resolves.
 */
export class Peer {
  readonly role: "coordinator" | "worker";
  readonly localClientId: string;
  peerClientId: string | null = null;
  private pc: PeerConnectionLike | null = null;
  private channel: DataChannelLike | null = null;
  private remoteDescriptionSet = false;
  private pendingIce: IceCandidate[] = [];
  private closed = false;
  readonly events: PeerEvents;

  constructor(
    role: "coordinator" | "worker",
    localClientId: string,
    private readonly createConnection: PeerConnectionFactory,
    events: PeerEvents,
  ) {
    this.role = role;
    this.localClientId = localClientId;
    this.events = events;
  }

  get connectionState(): PeerConnectionState {
    return this.pc ? this.pc.connectionState : "closed";
  }
  get dataChannelState(): DataChannelState {
    return this.channel ? this.channel.readyState : "closed";
  }

  private wirePeer(): void {
    if (!this.pc) return;
    this.pc.onconnectionstatechange = () => {
      this.events.onState?.(this.pc!.connectionState);
      const s = this.pc!.connectionState;
      if (s === "failed" || s === "disconnected" || s === "closed") {
        this.events.onError?.("Peer connection " + s);
      }
    };
    this.pc.oniceconnectionstatechange = () => {
      this.events.onState?.(this.pc!.connectionState);
    };
    this.pc.onicecandidate = (cand: IceCandidate | null) => {
      if (cand) this.events.onIce?.(cand);
    };
    if (this.role === "worker") {
      this.pc.ondatachannel = (ch: DataChannelLike) => this.attachChannel(ch);
    }
  }

  attachChannel(ch: DataChannelLike): void {
    this.channel = ch;
    this.channel.onopen = () => {
      this.events.onDataChannelOpen?.();
      this.events.onState?.(this.connectionState);
    };
    this.channel.onmessage = (data: string) => this.events.onDataChannelMessage?.(data);
    this.channel.onclose = () => {
      this.events.onDataChannelClosed?.();
      this.events.onState?.(this.connectionState);
    };
    this.channel.onerror = () => {
      this.events.onError?.("DataChannel error");
    };
  }

  /** Coordinator side: create the data channel + offer. */
  async initiate(peerClientId: string): Promise<void> {
    if (this.closed) {
      this.events.onError?.("Peer closed");
      return;
    }
    this.peerClientId = peerClientId;
    this.pc = this.createConnection();
    this.wirePeer();
    this.channel = this.pc.createDataChannel("resumedrop");
    this.attachChannel(this.channel);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.events.onSignal?.(offer, "offer");
    this.events.onState?.(this.connectionState);
  }

  /** Worker side: install the remote offer and produce an answer. */
  async handleOffer(fromClientId: string, sdp: Sdp): Promise<void> {
    if (this.closed) {
      this.events.onError?.("Peer closed");
      return;
    }
    this.peerClientId = fromClientId;
    if (!this.pc) {
      this.pc = this.createConnection();
      this.wirePeer();
    }
    await this.pc.setRemoteDescription(sdp);
    this.remoteDescriptionSet = true;
    await this.drainPendingIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.events.onSignal?.(answer, "answer");
    this.events.onState?.(this.connectionState);
  }

  /** Coordinator side: install the remote answer. */
  async handleAnswer(fromClientId: string, sdp: Sdp): Promise<void> {
    if (this.closed) {
      this.events.onError?.("Peer closed");
      return;
    }
    if (!this.pc) {
      this.events.onError?.("No peer connection for answer");
      return;
    }
    this.peerClientId = fromClientId;
    await this.pc.setRemoteDescription(sdp);
    this.remoteDescriptionSet = true;
    await this.drainPendingIce();
    this.events.onState?.(this.connectionState);
  }

  /** Remote ICE candidate. Buffered until the remote description is installed. */
  handleIceCandidate(cand: IceCandidate): void {
    if (!this.remoteDescriptionSet) {
      this.pendingIce.push(cand);
      return;
    }
    if (!this.pc) {
      this.pendingIce.push(cand);
      return;
    }
    this.pc.addIceCandidate(cand).catch(() => {
      /* ignore races around close */
    });
  }

  private async drainPendingIce(): Promise<void> {
    if (!this.pc) return;
    const waiting = this.pendingIce;
    this.pendingIce = [];
    for (const cand of waiting) {
      try {
        await this.pc.addIceCandidate(cand);
      } catch {
        /* ignore candidates that fail on a closing/failed pc */
      }
    }
  }

  /** Send data over the data channel. Returns false (and reports an error) if
   * the channel is missing or not OPEN. Never throws across callers. */
  sendMessage(data: string): boolean {
    if (!this.channel) {
      this.events.onError?.("No data channel");
      return false;
    }
    if (this.channel.readyState !== "open") {
      this.events.onError?.("Data channel not open (state=" + this.channel.readyState + ")");
      return false;
    }
    try {
      this.channel.send(data);
      return true;
    } catch (err) {
      this.events.onError?.("Send failed: " + ((err as Error)?.message ?? String(err)));
      return false;
    }
  }

  /** Tear down this peer, closing the data channel and the RTCPeerConnection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingIce = [];
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    this.channel = null;
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.peerClientId = null;
    this.remoteDescriptionSet = false;
  }
}
