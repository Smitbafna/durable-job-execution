/**
 * ResumeDrop — in-process test doubles for the WebRTC signaling stack.
 *
 * - `FakeDataChannel` / `FakePeerConnection` implement the *exact* interfaces
 *   the production `RealPeerConnection` does, but are synchronous and
 *   inspectable (recorded offers/answers/candidates/created channels).
 * - `FakeTransport` implements `SignalingTransport` so the orchestrator can be
 *   driven without a WebSocket. `toPeer` routes a sent message back into the
 *   paired peer's `emit()`, simulating the signaling server's point-to-point
 *   routing.
 *
 * IMPORTANT: these fakes exercise the *orchestration* and *peer* logic only.
 * They intentionally do not model the browser's ICE connectivity checks — real
 * browser connectivity is validated separately against the live signaling
 * server.
 */
import { MessageType } from "@resumedrop/shared";
import { registrationFor } from "../lib/messages";
import type {
  PeerConnectionLike,
  DataChannelLike,
  PeerConnectionState,
  DataChannelState,
  IceCandidate,
  Sdp,
  SdpType,
  PeerConfig,
} from "../lib/peer";
import type { SignalingTransport, SignalingStatus } from "../lib/signaling";
import type { Role } from "@resumedrop/shared";

export class FakeDataChannel implements DataChannelLike {
  readyState: DataChannelState = "closed";
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  private link: ((data: string) => void) | null = null;

  constructor(public label: string) {}

  /** Connect two channel ends so sends flow in both directions. */
  linkTo(other: FakeDataChannel): void {
    this.link = (data) => other.onmessage?.(data);
    other.link = (data) => this.onmessage?.(data);
  }

  send(data: string): void {
    this.sent.push(data);
    this.link?.(data);
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
  }

  // --- simulation helpers (driver -> channel) ---
  fireOpen(): void {
    this.readyState = "open";
    this.onopen?.();
  }
  fireMessage(data: string): void {
    this.onmessage?.(data);
  }
  fireClose(): void {
    this.readyState = "closed";
    this.onclose?.();
  }
}

export class FakePeerConnection implements PeerConnectionLike {
  connectionState: PeerConnectionState = "new";
  readonly iceConnectionState = "new";
  onicecandidate: ((cand: IceCandidate | null) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((channel: DataChannelLike) => void) | null = null;

  createdChannels: FakeDataChannel[] = [];
  offers: Sdp[] = [];
  answers: Sdp[] = [];
  localDesc: Sdp | null = null;
  remoteDesc: Sdp | null = null;
  candidates: IceCandidate[] = [];
  closed = false;

  constructor(public config?: PeerConfig) {}

  async createOffer(): Promise<Sdp> {
    const o: Sdp = { type: "offer" as SdpType, sdp: "fake-offer" };
    this.offers.push(o);
    return o;
  }
  async createAnswer(): Promise<Sdp> {
    const a: Sdp = { type: "answer" as SdpType, sdp: "fake-answer" };
    this.answers.push(a);
    return a;
  }
  async setLocalDescription(desc: Sdp): Promise<void> {
    this.localDesc = desc;
  }
  async setRemoteDescription(desc: Sdp): Promise<void> {
    this.remoteDesc = desc;
  }
  async addIceCandidate(cand: IceCandidate): Promise<void> {
    this.candidates.push(cand);
  }
  createDataChannel(label: string): DataChannelLike {
    const dc = new FakeDataChannel(label);
    this.createdChannels.push(dc);
    return dc;
  }
  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  // --- simulation helpers ---
  setConnectionState(next: PeerConnectionState): void {
    this.connectionState = next;
    this.onconnectionstatechange?.();
  }
  fireIceCandidate(cand: IceCandidate): void {
    this.onicecandidate?.(cand);
  }
  fireDataChannel(ch: DataChannelLike): void {
    this.ondatachannel?.(ch);
  }
}

export class FakeTransport implements SignalingTransport {
  status: SignalingStatus = "disconnected";
  onMessage: ((msg: unknown) => void) | null = null;
  onStatus: ((status: SignalingStatus) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  sent: unknown[] = [];
  registerArg: Role | null = null;
  toPeer: ((msg: unknown) => void) | null = null;

  constructor(public clientId: string) {}

  connect(): void {
    // Simulates an immediately-open socket (no backoff in tests).
    this.setStatus("open");
  }
  register(role: Role): void {
    this.registerArg = role;
    this.send(registrationFor(role, this.clientId));
  }
  send(msg: object): void {
    this.sent.push(msg);
    this.toPeer?.(msg);
  }
  stop(): void {
    this.setStatus("disconnected");
  }

  setStatus(next: SignalingStatus): void {
    this.status = next;
    this.onStatus?.(next);
  }
  emit(msg: unknown): void {
    this.onMessage?.(msg);
  }
}

/** Drain the microtask queue once (lets awaited fake async methods settle). */
export async function flush(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export function isOfType(t: MessageType) {
  return (m: unknown): boolean =>
    typeof m === "object" && m !== null && (m as { type?: unknown }).type === t;
}
