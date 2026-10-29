import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureClientId, getClientId, clearClientId } from "../lib/clientId";

describe("clientId", () => {
  let store: Record<string, string>;
  let calls: number;

  beforeEach(() => {
    store = {};
    calls = 0;
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = String(v);
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        for (const k in store) delete store[k];
      },
    });
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        calls += 1;
        return "00000000-0000-4000-0000-" + String(calls).padStart(12, "0");
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates and persists a valid UUID v4", () => {
    const id = ensureClientId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(getClientId()).toBe(id);
    expect(calls).toBe(1);
  });

  it("reuses the stored id across reloads of the same tab", () => {
    const first = ensureClientId();
    const second = ensureClientId();
    expect(first).toBe(second);
    expect(calls).toBe(1);
  });

  it("issues a fresh id in a new tab (empty session storage)", () => {
    const first = ensureClientId();
    // A brand-new tab gets a fresh sessionStorage session.
    for (const k in store) delete store[k];
    const second = ensureClientId();
    expect(second).not.toBe(first);
    expect(calls).toBe(2);
    expect(getClientId()).toBe(second);
  });

  it("returns null when storage is empty or holds a non-UUID", () => {
    expect(getClientId()).toBeNull();
    store["resumedrop.clientId"] = "not-a-uuid";
    expect(getClientId()).toBeNull();
  });

  it("clearClientId removes the stored id", () => {
    ensureClientId();
    expect(getClientId()).not.toBeNull();
    clearClientId();
    expect(getClientId()).toBeNull();
  });
});
