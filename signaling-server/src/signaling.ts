import { WebSocket } from "ws";
import {
  MessageType,
  validateRegistrationMsg,
  validateDiscoveryRequestMsg,
  validateWebrtcOfferMsg,
  validateWebrtcAnswerMsg,
  validateWebrtcIceCandidateMsg,
  validateDisconnectMsg,
} from "@resumedrop/shared";
import type {
  Role,
  PeerInfo,
  RegistrationSuccessMsg,
  WorkerDiscoveryResponseMsg,
} from "@resumedrop/shared";

/** Result codes surfaced to clients over the `ERROR` message channel. */
export enum ErrorCode {
  ValidationError = "VALIDATION_ERROR",
  NotRegistered = "NOT_REGISTERED",
  AlreadyRegistered = "ALREADY_REGISTERED",
  Forbidden = "FORBIDDEN",
  RecipientOffline = "RECIPIENT_OFFLINE",
  UnknownMessageType = "UNKNOWN_MESSAGE_TYPE",
  InternalError = "INTERNAL_ERROR",
}

/** A socket that has completed the registration handshake. */
export interface RegisteredClient {
  clientId: string;
  role: Role;
  ws: WebSocket;
}

/** Builds a JSON-serializable payload of the given `type` and `data`. */
function buildPayload(type: string, data: unknown): unknown {
  return { type, ...(data as object) };
}

/**
 * In-memory, in-process signaling hub. It owns no I/O of its own: it receives
 * already-parsed messages from the transport layer and pushes JSON payloads
 * back through the owning socket. One live registration per `clientId` is
 * enforced; a reconnecting socket takes ownership of its id, and an obsolete
 * socket can never unregister a newer session (the disconnect path compares
 * socket identity before mutating state).
 */
export class SignalingHub {
  private readonly clients: Map<string, RegisteredClient> = new Map();
  private readonly socketClientId: WeakMap<WebSocket, string> = new WeakMap();

  /** `true` when there is a registered, open socket for `clientId`. */
  has(clientId: string): boolean {
    const client = this.clients.get(clientId);
    return !!client && client.ws.readyState === client.ws.OPEN;
  }

  /** Returns the registered client for `clientId`, or `undefined`. */
  getClient(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  /**
   * All currently-registered workers with an open socket, as `PeerInfo`
   * objects suitable for inclusion in a discovery response.
   */
  getWorkers(): PeerInfo[] {
    const workers: PeerInfo[] = [];
    for (const client of this.clients.values()) {
      if (client.role !== "worker") continue;
      if (client.ws.readyState !== client.ws.OPEN) continue;
      workers.push({ clientId: client.clientId, role: client.role });
    }
    return workers;
  }

  /** All currently-registered coordinators with an open socket. */
  private getCoordinators(): RegisteredClient[] {
    const coords: RegisteredClient[] = [];
    for (const client of this.clients.values()) {
      if (client.role !== "coordinator") continue;
      if (client.ws.readyState !== client.ws.OPEN) continue;
      coords.push(client);
    }
    return coords;
  }

  /** Pushes the current worker roster to every open coordinator. */
  private notifyCoordinators(): void {
    const payload = buildPayload(MessageType.WorkerDiscoveryResponse, {
      workers: this.getWorkers(),
    }) as WorkerDiscoveryResponseMsg;
    for (const coord of this.getCoordinators()) {
      this.send(coord.ws, payload);
    }
  }

  /** Sends a single JSON payload to a socket, ignoring closed clients. */
  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  /** Sends an `ERROR` message to `ws`. */
  private sendError(ws: WebSocket, code: ErrorCode, message: string): void {
    this.send(ws, buildPayload(MessageType.Error, { code, message }));
  }

  /**
   * Runs the registration handshake for `ws`. Sends a `REGISTRATION_SUCCESS`
   * on success or an `ERROR` on failure. Returns `true` on success.
   */
  register(ws: WebSocket, message: unknown): boolean {
    if (!ws) return false;
    if (this.socketClientId.has(ws)) {
      this.sendError(ws, ErrorCode.AlreadyRegistered, "Socket already registered");
      return false;
    }
    if (!validateRegistrationMsg(message)) {
      this.sendError(ws, ErrorCode.ValidationError, "Invalid registration message");
      return false;
    }

    const { clientId, role, capabilities } =
      message as { clientId: string; role: Role; capabilities?: string[] };

    // Takeover semantics: a different socket that previously owned this id is
    // silently superseded. Its later cleanup is guarded by an identity check.
    this.clients.set(clientId, { clientId, role, ws });
    this.socketClientId.set(ws, clientId);

    this.send(ws, buildPayload(MessageType.RegistrationSuccess, {
      clientId,
      role,
      capabilities: capabilities ?? [],
    }) as RegistrationSuccessMsg);

    if (role === "coordinator") {
      // Give a freshly-registered coordinator its current view of the world.
      this.send(ws, buildPayload(MessageType.WorkerDiscoveryResponse, {
        workers: this.getWorkers(),
      }) as WorkerDiscoveryResponseMsg);
    } else if (role === "worker") {
      this.notifyCoordinators();
    }
    return true;
  }

  /**
   * Processes an inbound, already-parsed message from `ws`.
   */
  handleMessage(ws: WebSocket, message: unknown): void {
    try {
      if (!ws || typeof message !== "object" || message === null) {
        this.sendError(ws as WebSocket, ErrorCode.ValidationError, "Malformed message");
        return;
      }

      const m = message as { type?: unknown; clientId?: unknown; [k: string]: unknown };

      if (m.type === MessageType.CoordinatorRegister || m.type === MessageType.WorkerRegister) {
        this.register(ws, message);
        return;
      }

      // Everything else requires an existing, open registration for this socket.
      const clientId = this.socketClientId.get(ws);
      const client =
        clientId !== undefined ? this.clients.get(clientId) : undefined;
      if (!client || client.ws !== ws || client.ws.readyState !== client.ws.OPEN) {
        this.sendError(ws, ErrorCode.NotRegistered, "Not registered");
        return;
      }

      // A client may only speak as itself.
      if (typeof m.clientId === "string" && m.clientId !== client.clientId) {
        this.sendError(ws, ErrorCode.Forbidden, "clientId mismatch");
        return;
      }

      switch (m.type) {
        case MessageType.WorkerDiscoveryRequest:
          if (!validateDiscoveryRequestMsg(message)) {
            this.sendError(ws, ErrorCode.ValidationError, "Invalid discovery request");
            return;
          }
          this.handleDiscoveryRequest(client);
          return;
        case MessageType.WebrtcOffer:
          this.handleTargetedMessage(client, message, validateWebrtcOfferMsg);
          return;
        case MessageType.WebrtcAnswer:
          this.handleTargetedMessage(client, message, validateWebrtcAnswerMsg);
          return;
        case MessageType.WebrtcIceCandidate:
          this.handleTargetedMessage(client, message, validateWebrtcIceCandidateMsg);
          return;
        case MessageType.Disconnect:
          this.handleGracefulDisconnect(client, message);
          return;
        default:
          this.sendError(ws, ErrorCode.UnknownMessageType, "Unknown message type");
          return;
      }
    } catch {
      // Never let an unexpected throw take down the connection.
      this.sendError(ws, ErrorCode.InternalError, "Internal server error");
    }
  }

  private handleDiscoveryRequest(client: RegisteredClient): void {
    const payload = buildPayload(MessageType.WorkerDiscoveryResponse, {
      workers: this.getWorkers(),
    }) as WorkerDiscoveryResponseMsg;
    this.send(client.ws, payload);
  }

  private handleTargetedMessage(
    sender: RegisteredClient,
    message: unknown,
    validate: (msg: unknown) => boolean,
  ): void {
    const m = message as { receiverId?: unknown; senderId?: string; [k: string]: unknown };

    if (!validate(message)) {
      this.sendError(sender.ws, ErrorCode.ValidationError, "Invalid message");
      return;
    }
    if (typeof m.receiverId !== "string" || m.receiverId.trim().length === 0) {
      this.sendError(sender.ws, ErrorCode.ValidationError, "Missing receiverId");
      return;
    }
    if (typeof m.senderId === "string" && m.senderId !== sender.clientId) {
      this.sendError(sender.ws, ErrorCode.Forbidden, "senderId mismatch");
      return;
    }

    const recipient = this.clients.get(m.receiverId);
    if (!recipient || recipient.ws.readyState !== recipient.ws.OPEN) {
      this.sendError(sender.ws, ErrorCode.RecipientOffline, "Recipient offline");
      return;
    }

    // Forward verbatim, stamping the true sender identity server-side.
    const forwarded = { ...(message as object) } as { [k: string]: unknown };
    forwarded.senderId = sender.clientId;
    this.send(recipient.ws, forwarded);
  }

  private handleGracefulDisconnect(client: RegisteredClient, message: unknown): void {
    const m = message as { reason?: string };
    if (!validateDisconnectMsg(message)) {
      this.sendError(client.ws, ErrorCode.ValidationError, "Invalid disconnect");
      return;
    }
    const reason = m.reason ?? "normal";
    this.unregister(client, reason);
    client.ws.close();
  }

  /**
   * Removes `client` from the store. A newer session that has since taken over
   * this `clientId` makes the stale socket a no-op.
   */
  private unregister(client: RegisteredClient, reason?: string): void {
    const { clientId, ws } = client;
    const current = this.clients.get(clientId);
    if (current && current.ws === ws) {
      this.clients.delete(clientId);
      this.socketClientId.delete(ws);
    }
    void reason;
  }

  /**
   * Transport-level close handler. Cleans up only the registration owned by
   * `ws`, and never evicts a newer session that took over the id.
   */
  handleDisconnect(ws: WebSocket): void {
    const clientId = this.socketClientId.get(ws);
    if (clientId === undefined) return;
    const current = this.clients.get(clientId);
    if (current && current.ws === ws) {
      this.clients.delete(clientId);
    }
    this.socketClientId.delete(ws);
    if (current?.role === "worker") {
      this.notifyCoordinators();
    }
  }

  /** Forcefully closes every connected socket (e.g. on server shutdown). */
  close(): void {
    for (const client of this.clients.values()) {
      this.sendError(client.ws, ErrorCode.InternalError, "Server shutting down");
      client.ws.close();
    }
    this.clients.clear();
  }

  /** Number of currently-known registrations (any state). */
  get size(): number {
    return this.clients.size;
  }
}

