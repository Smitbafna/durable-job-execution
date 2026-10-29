import { useCallback, useEffect, useRef, useState } from "react";
import { SignalingClient } from "../lib/signaling";
import { WebRTCOrchestrator } from "../lib/orchestrator";
import type { OrchestratorState } from "../lib/orchestrator";
import { defaultPeerConnectionFactory } from "../lib/peer";
import { ensureClientId, clearClientId } from "../lib/clientId";
import attachDebug from "../debug";

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL || "ws://localhost:4000/ws";

export interface OrchestratorHandle {
  state: OrchestratorState;
  clientId: string;
  setRole: (role: "coordinator" | "worker") => void;
  connect: () => void;
  disconnect: () => void;
  connectTo: (id: string) => void;
  send: (text: string) => void;
  resetId: () => void;
}

export function useOrchestrator(): OrchestratorHandle {
  const [, setTick] = useState(0);
  const orchRef = useRef<WebRTCOrchestrator | null>(null);

  if (orchRef.current === null) {
    const clientId = ensureClientId();
    const transport = new SignalingClient(SIGNALING_URL, clientId);
    const orch = new WebRTCOrchestrator(
      clientId,
      transport,
      defaultPeerConnectionFactory(),
    );
    orch.onChange = () => setTick((t) => t + 1);
    orchRef.current = orch;
  }

  const orch = orchRef.current;
  useEffect(() => {
    attachDebug(orch);
  }, [orch]);

  const setRole = useCallback((role: "coordinator" | "worker") => orch.setRole(role), [orch]);
  const connect = useCallback(() => orch.connect(), [orch]);
  const disconnect = useCallback(() => orch.disconnect(), [orch]);
  const connectTo = useCallback((id: string) => orch.connectTo(id), [orch]);
  const send = useCallback((text: string) => orch.send(text), [orch]);
  const resetId = useCallback(() => {
    clearClientId();
    window.location.reload();
  }, []);

  return {
    state: orch.state,
    clientId: orch.clientId,
    setRole,
    connect,
    disconnect,
    connectTo,
    send,
    resetId,
  };
}

