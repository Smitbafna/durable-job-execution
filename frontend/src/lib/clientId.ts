/**
 * ResumeDrop — client identity persistence.
 *
 * The client ID is an identifier only (never trusted as authentication).
 * It is generated once per browser tab and persisted in `sessionStorage` so
 * that a same-tab reload keeps the same identity, while a different tab (a
 * separate session) obtains a fresh ID. The validator on the server requires
 * a canonical UUID v4 string, so we use `crypto.randomUUID`.
 */
const STORAGE_KEY = "resumedrop.clientId";

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function getClientId(): string | null {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    return value && isUuid(value) ? value : null;
  } catch {
    return null;
  }
}

export function ensureClientId(): string {
  const existing = getClientId();
  if (existing) return existing;
  const id = crypto.randomUUID();
  try {
    sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage unavailable — fall back to the in-memory id */
  }
  return id;
}

export function clearClientId(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
