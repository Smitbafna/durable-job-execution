/**
 * Real-browser WebRTC end-to-end test for ResumeDrop.
 *
 * Two browser contexts (separate localStorage → distinct client IDs) load the
 * real app, register through the real signaling server, then negotiate a real
 * peer connection and exchange messages through the native RTCDataChannel.
 *
 * This is intentionally a single multi-step test: the peers' state machines are
 * coupled (one creates the offer, the other answers), so running the steps
 * against the same two pages/contexts preserves that coupling.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const roleRadio = (page: Page, role: "coordinator" | "worker") =>
  page.locator(`input[name="role"][value="${role}"]`);

const signalingPanel = (page: Page) =>
  page.locator("section.panel").filter({ hasText: "Signaling" });

const signalConnectBtn = (page: Page) =>
  signalingPanel(page).getByRole("button", { name: "Connect" });

const workerConnectBtn = (page: Page, clientId: string) =>
  page.locator(".workers").locator("li").filter({ hasText: clientId }).getByRole("button", { name: "Connect" });

const receivedPanel = (page: Page) => page.locator("section.panel").filter({ hasText: "Received" });

const ownClientId = (page: Page) => page.locator("header code.mono");

const sayInput = (page: Page) =>
  page.locator("section.panel").filter({ hasText: "Say hello" }).locator("input");
const saySendBtn = (page: Page) => page.getByRole("button", { name: "Send" });

interface Diag {
  pageerrors: string[];
  consoleErrors: string[];
  requestFailed: string[];
}

function attachDiagnostics(page: Page, diag: Diag) {
  page.on("pageerror", (err) =>
    diag.pageerrors.push(`unhandled: ${err.message}\n${err.stack ?? "(no stack)"}`),
  );
  page.on("console", (msg) => {
    if (msg.type() === "error") diag.consoleErrors.push(`[${msg.location().url}] ${msg.text()}`);
  });
  page.on("requestfailed", (req) => {
    const err = req.failure();
    diag.requestFailed.push(`${req.url()} — ${err?.errorText ?? "unknown"}`);
  });
}

test.describe("ResumeDrop real-browser WebRTC", () => {
  test("coordinator and worker exchange messages bidirectionally over a real data channel", async ({
    browser,
  }, testInfo) => {
    const coordDiag: Diag = { pageerrors: [], consoleErrors: [], requestFailed: [] };
    const workerDiag: Diag = { pageerrors: [], consoleErrors: [], requestFailed: [] };

    // Two contexts => independent localStorage => distinct stable client IDs.
    const coordCtx: BrowserContext = await browser.newContext();
    const workerCtx: BrowserContext = await browser.newContext();
    const coord: Page = await coordCtx.newPage();
    const worker: Page = await workerCtx.newPage();
    attachDiagnostics(coord, coordDiag);
    attachDiagnostics(worker, workerDiag);

    let coordId: string;
    let workerId: string;
    try {
      // 1-2. Load the real app in both peers.
      await coord.goto("/", { waitUntil: "networkidle" });
      await worker.goto("/", { waitUntil: "networkidle" });

      // 3. Coordinator registers through the real signaling server.
      await roleRadio(coord, "coordinator").check();
      await expect(signalConnectBtn(coord)).toBeEnabled();
      await signalConnectBtn(coord).click();
      await expect(signalingPanel(coord).getByLabel("open")).toBeVisible({ timeout: 30_000 });
      await expect(coord.getByLabel("registered")).toBeVisible({ timeout: 30_000 });

      // 4. Worker registers.
      await roleRadio(worker, "worker").check();
      await expect(signalConnectBtn(worker)).toBeEnabled();
      await signalConnectBtn(worker).click();
      await expect(signalingPanel(worker).getByLabel("open")).toBeVisible({ timeout: 30_000 });
      await expect(worker.getByLabel("registered")).toBeVisible({ timeout: 30_000 });

      coordId = (await ownClientId(coord).textContent()) || "";
      workerId = (await ownClientId(worker).textContent()) || "";
      expect(coordId).toBeTruthy();
      expect(workerId).toBeTruthy();
      expect(coordId).not.toEqual(workerId);

      // 6. Coordinator discovers the worker (real discovery push).
      await expect(coord.locator(".workers")).toContainText(workerId, { timeout: 30_000 });

      // 7. Coordinator initiates a real offer to the worker.
      await workerConnectBtn(coord, workerId).click();

      // 8-9. Real DTLS/ICE connects + the native data channel opens on both sides.
      await expect(coord.getByLabel("PC: connected")).toBeVisible({ timeout: 30_000 });
      await expect(worker.getByLabel("PC: connected")).toBeVisible({ timeout: 30_000 });
      await expect(coord.getByLabel("DC: open")).toBeVisible({ timeout: 30_000 });
      await expect(worker.getByLabel("DC: open")).toBeVisible({ timeout: 30_000 });

      // 10. Coordinator -> Worker, over the real RTCDataChannel.
      const msgA = `A-msg-${randomUUID().slice(0, 8)}`;
      await expect(sayInput(coord)).toBeEnabled();
      await sayInput(coord).fill(msgA);
      await saySendBtn(coord).click();
      await expect(receivedPanel(worker)).toContainText(msgA, { timeout: 15_000 });

      // 11. Worker -> Coordinator.
      const msgB = `B-msg-${randomUUID().slice(0, 8)}`;
      await sayInput(worker).fill(msgB);
      await saySendBtn(worker).click();
      await expect(receivedPanel(coord)).toContainText(msgB, { timeout: 15_000 });

      // 12. The sender must not echo its own message back (real transport, not loopback).
      await expect(receivedPanel(coord)).not.toContainText(msgA);
      await expect(receivedPanel(worker)).not.toContainText(msgB);

      // 13. Worker reloads (simulates restart / network drop).
      await worker.reload({ waitUntil: "networkidle" });

      // 14. Same client ID is retained (localStorage) and re-registers.
      await expect(ownClientId(worker)).toHaveText(workerId);
      await roleRadio(worker, "worker").check();
      await expect(signalConnectBtn(worker)).toBeEnabled();
      await signalConnectBtn(worker).click();
      await expect(signalingPanel(worker).getByLabel("open")).toBeVisible({ timeout: 30_000 });
      await expect(worker.getByLabel("registered")).toBeVisible({ timeout: 30_000 });
      // Coordinator re-discovers the worker after it re-registers.
      await expect(coord.locator(".workers")).toContainText(workerId, { timeout: 30_000 });

      // 15. Re-establish the real peer connection and exchange again.
      await workerConnectBtn(coord, workerId).click();
      await expect(coord.getByLabel("PC: connected")).toBeVisible({ timeout: 30_000 });
      await expect(worker.getByLabel("PC: connected")).toBeVisible({ timeout: 30_000 });
      await expect(coord.getByLabel("DC: open")).toBeVisible({ timeout: 30_000 });
      await expect(worker.getByLabel("DC: open")).toBeVisible({ timeout: 30_000 });

      const msgA2 = `A2-${randomUUID().slice(0, 8)}`;
      await sayInput(coord).fill(msgA2);
      await saySendBtn(coord).click();
      await expect(receivedPanel(worker)).toContainText(msgA2, { timeout: 15_000 });

      const msgB2 = `B2-${randomUUID().slice(0, 8)}`;
      await sayInput(worker).fill(msgB2);
      await saySendBtn(worker).click();
      await expect(receivedPanel(coord)).toContainText(msgB2, { timeout: 15_000 });
    } finally {
      await testInfo.attach("diagnostics", {
        body: JSON.stringify({ coordinator: coordDiag, worker: workerDiag }, null, 2),
        contentType: "application/json",
      });
      await coordCtx.close().catch(() => undefined);
      await workerCtx.close().catch(() => undefined);
    }

    // Uncaught JS exceptions indicate a real bug -- fail loudly.
    const pageErrors = [...coordDiag.pageerrors, ...workerDiag.pageerrors];
    expect(pageErrors).toEqual([]);
  });
});

