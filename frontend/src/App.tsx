import { ChangeEvent, FormEvent, useCallback, useState } from "react";
import type { PeerInfo, Role } from "@resumedrop/shared";
import { useOrchestrator } from "./hooks/useOrchestrator";
import "./App.css";

const ROLES: Role[] = ["coordinator", "worker"];

function StatusBadge({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      aria-label={label}
      title={label}
      className={ok ? "badge badge-ok" : "badge badge-bad"}
    >
      {label}
    </span>
  );
}

export default function App() {
  const {
    state,
    clientId,
    setRole,
    connect,
    disconnect,
    connectTo,
    send,
    resetId,
  } = useOrchestrator();

  const [draft, setDraft] = useState("");
  const connected = state.wsStatus === "open";
  const peerReady = state.dataChannelState === "open";
  const suggested = state.role === "coordinator" ? "HI" : state.role === "worker" ? "REPLY" : "";

  const onPickRole = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setRole(e.target.value as Role),
    [setRole],
  );
  const onStart = useCallback(() => connect(), [connect]);
  const onStop = useCallback(() => disconnect(), [disconnect]);
  const onConnectWorker = useCallback((w: PeerInfo) => connectTo(w.clientId), []);
  const onSend = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const text = draft.trim();
      if (text && peerReady) {
        send(text);
        setDraft("");
      }
    },
    [draft, peerReady, send],
  );

  return (
    <div className="app">
      <header className="panel">
        <h1>ResumeDrop</h1>
        <div className="row">
          <code className="mono" title="This browser tab’s identifier">
            {clientId}
          </code>
          <button type="button" className="ghost" onClick={resetId}>
            Reset ID
          </button>
        </div>
      </header>

      <section className="panel">
        <h2>Role</h2>
        <div className="row">
          {ROLES.map((r) => (
            <label key={r} className="radio">
              <input
                type="radio"
                name="role"
                value={r}
                checked={state.role === r}
                onChange={onPickRole}
                disabled={connected}
              />
              {r}
            </label>
          ))}
        </div>
        <p className="hint">
          Pick <strong>coordinator</strong> on one tab and <strong>worker</strong>
          on another, then connect each to the signaling server.
        </p>
      </section>

      <section className="panel">
        <h2>Signaling</h2>
        <div className="row">
          <StatusBadge label={state.wsStatus} ok={connected} />
          <StatusBadge
            label={state.registered ? "registered" : "not registered"}
            ok={state.registered}
          />
          {state.wsStatus === "disconnected" && (
            <button type="button" onClick={onStart} disabled={!state.role}>
              Connect
            </button>
          )}
          {state.wsStatus !== "disconnected" && (
            <button type="button" className="ghost" onClick={onStop}>
              Disconnect
            </button>
          )}
        </div>
      </section>

      {state.role === "coordinator" && state.registered && (
        <section className="panel">
          <h2>Workers</h2>
          {state.workers.length === 0 ? (
            <p className="hint">No workers registered yet.</p>
          ) : (
            <ul className="workers">
              {state.workers.map((w) => (
                <li key={w.clientId}>
                  <code className="mono">{w.clientId}</code>
                  <button type="button" onClick={() => onConnectWorker(w)}>
                    Connect
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="panel">
        <h2>Peer link</h2>
        <div className="row">
          <StatusBadge
            label={"PC: " + state.peerConnectionState}
            ok={state.peerConnectionState === "connected"}
          />
          <StatusBadge
            label={"DC: " + state.dataChannelState}
            ok={peerReady}
          />
        </div>
      </section>

      <section className="panel">
        <h2>Say hello</h2>
        <form onSubmit={onSend} className="row">
          <input
            value={draft || suggested}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={suggested || "type a message"}
            disabled={!peerReady}
          />
          <button type="submit" disabled={!peerReady}>
            Send
          </button>
        </form>
      </section>

      <section className="panel">
        <h2>Received ({state.received.length})</h2>
        {state.received.length === 0 ? (
          <p className="hint">Nothing yet.</p>
        ) : (
          <ul className="messages">
            {state.received.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Sent ({state.sent.length})</h2>
        {state.sent.length === 0 ? (
          <p className="hint">Nothing yet.</p>
        ) : (
          <ul className="messages">
            {state.sent.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        )}
      </section>

      {state.error && (
        <section className="panel panel-error">
          <strong>Error:</strong> {state.error}
        </section>
      )}
    </div>
  );
}
