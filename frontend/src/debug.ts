/**
 * ResumeDrop — browser-side debug hook.
 *
 * When the URL contains `?debug=1`, this attaches `window.__resumeDebug`,
 * which exposes a small imperative API (snapshot / setRole / connect /
 * connectTo / send / init / disconnect). The Playwright test suite uses it to
 * drive the real browser client end-to-end; it stays inert in normal use.
 */
import type { Role } from "@resumedrop/shared";
import type { WebRTCOrchestrator } from "./lib/orchestrator";
import type { OrchestratorState } from "./lib/orchestrator";

export interface DebugSnapshot extends OrchestratorState {
  workers: PeerInfoLite[];
  sent: string[];
  received: string[];
}
interface PeerInfoLite {
  clientId: string;
  role: Role;
}
type DebugApi = {
  snapshot: () => DebugSnapshot;
  setRole: (role: Role) => void;
  connect: () => void;
  disconnect: () => void;
  init: (role: Role) => void;
  connectTo: (id: string) => void;
  send: (text: string) => void;
  clientId: string;
};
type WindowWithDebug = Window & {
  __resumeDebug?: DebugApi;
};

export default function attachDebug(orch: WebRTCOrchestrator): void {
  if (typeof window === "undefined") return;
  if (!new URLSearchParams(window.location.search).has("debug")) return;
  const api: DebugApi = {
    clientId: orch.clientId,
    snapshot: () => ({
      ...orch.state,
      workers: orch.state.workers.map((w) => ({ clientId: w.clientId, role: w.role })),
      sent: [...orch.state.sent],
      received: [...orch.state.received],
    }),
    setRole: (role) => orch.setRole(role),
    connect: () => orch.connect(),
    disconnect: () => orch.disconnect(),
    init: (role) => {
      orch.setRole(role);
      orch.connect();
    },
    connectTo: (id) => orch.connectTo(id),
    send: (text) => orch.send(text),
  };
  (window as unknown as WindowWithDebug).__resumeDebug = api;
}
