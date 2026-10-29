/**
 * ResumeDrop — WebSocket signaling transport.
 *
 * `SignalingClient` is the concrete transport used in the browser. It owns the
 * WebSocket lifecycle (connect, reconnect, stop), parses inbound JSON, and
 * dispatches status/message/error callbacks. The orchestrator is given any
 * object implementing `SignalingTransport`, which makes the orchestration
 * logic fully testable without a real socket.
 *
 * Reconnect semantics: on close we back off and reconnect; once open we
 * re-register the existing tab ID + role so the server re-binds the client.
 */
import type { Role } from "@resumedrop/shared";
import { registrationFor } from "./messages";

export type SignalingStatus = "disconnected" | "connecting" | "open";

export interface SignalingTransport {
  readonly status: SignalingStatus;
  onMessage: ((msg: unknown) => void) | null;
  onStatus: ((status: SignalingStatus) => void) | null;
  onError: ((message: string) => void) | null;
  connect(): void;
  send(msg: object): void;
  stop?(): void;
  register?(role: Role): void;
}

const RECONNECT_MS = 1000;

export class SignalingClient implements SignalingTransport {
  status: SignalingStatus = "disconnected";
  onMessage: ((msg: unknown) => void) | null = null;
  onStatus: ((status: SignalingStatus) => void) | null = null;
  onError: ((message: string) => void) | null = null;

  private readonly url: string;
  private readonly clientId: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pendingRole: Role | null = null;
  private readonly wsCtor: (url: string) => WebSocket;

  constructor(
    url: string,
    clientId: string,
    opts: { wsCtor?: (url: string) => WebSocket } = {},
  ) {
    this.url = url;
    this.clientId = clientId;
    this.wsCtor = opts.wsCtor ?? ((u) => new WebSocket(u));
  }

  connect(): void {
    // Already alive — nothing to do.
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    this.stopped = false;
    this.setStatus("connecting");
    const ws = this.wsCtor(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus("open");
      if (this.pendingRole) this.register(this.pendingRole);
    };
    ws.onclose = () => {
      this.setStatus("disconnected");
      if (!this.stopped) this.scheduleReconnect();
    };
    ws.onerror = (_ev: Event) => {
      this.onError?.("WebSocket error");
    };
    ws.onmessage = (ev: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        this.onError?.("Malformed message from signaling server");
        return;
      }
      this.onMessage?.(parsed);
    };
  }

  /**
   * Send the role registration for this tab.
   *
   * When the socket is already open we send immediately and clear any queued
   * role — a queued re-send is NOT needed here because the orchestrator also
   * re-registers on every (re)connect. Leaving `pendingRole` set would make
   * `onopen` fire a duplicate registration on the same socket, which the server
   * rejects with `ALREADY_REGISTERED` (flipping `registered` back to false).
   *
   * When the socket is not yet open we queue the role so the `onopen` handler
   * sends it exactly once after the handshake completes.
   */
  register(role: Role): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.pendingRole = null;
      this.send(registrationFor(role, this.clientId));
    } else {
      this.pendingRole = role;
    }
  }

  send(msg: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.onError?.("Cannot send: signaling socket not open");
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  private setStatus(next: SignalingStatus): void {
    this.status = next;
    this.onStatus?.(next);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, RECONNECT_MS);
  }
}

