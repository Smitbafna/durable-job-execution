/**
 * ResumeDrop shared protocol package.
 *
 * Re-exports the protocol message types (with a `MessageType` discriminator),
 * runtime validators, and type guards used by both the signaling server and the
 * browser clients. Keeping these definitions in one place guarantees the server
 * and the clients share an identical view of the wire protocol.
 */

export * from "./messages.js";
export * from "./validators.js";
