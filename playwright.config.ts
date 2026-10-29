/**
 * Playwright configuration for ResumeDrop's real-browser end-to-end tests.
 *
 * Strategy: drive the *real* app in a real Chrome/Chromium browser (launched from
 * a system binary via `executablePath`) with *real* WebRTC — no fakes. Two
 * browser contexts give each peer its own localStorage so they register with
 * distinct, stable client IDs.
 *
 * The config lives at the repo root (Playwright's default discovery) and scans
 * `./e2e` for tests, so `testDir: "e2e"` resolves against the repo root.
 *
 * The two `webServer` entries are managed by Playwright: the signaling server is
 * started first, then the Vite dev server (which imports `@resumedrop/shared`
 * from its built `dist`, so `npm run -w shared build` runs first in `test:e2e`).
 *
 * Run with: `npm run test:e2e` (or: `npx playwright test`).
 */
import { defineConfig } from "@playwright/test";

const SIG_PORT = Number(process.env.SIG_PORT ?? 4010);
const FE_PORT = Number(process.env.FE_PORT ?? 5183);
const CHROME_PATH = process.env.PLAYWRIGHT_CHROME_PATH ?? "/usr/bin/google-chrome";
// Anchor paths to the repo root (the `test:e2e` script runs from here) so the
// webServer commands resolve `node_modules/.bin/*` and Vite serves `frontend/`.
const ROOT = process.cwd();

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "dot" : "list",
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: {
      executablePath: CHROME_PATH,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--use-fake-ui-for-media-stream",
        "--hide-scrollbars",
      ],
    },
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    baseURL: `http://127.0.0.1:${FE_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      name: "signaling-server",
      command: `PORT=${SIG_PORT} node_modules/.bin/tsx signaling-server/src/index.ts`,
      url: `http://127.0.0.1:${SIG_PORT}/health`,
      timeout: 30_000,
      reuseOnNextRetry: true,
      cwd: ROOT,
      shell: "/bin/bash",
    },
    {
      name: "frontend-dev",
      // `vite dev` has no `--root` flag (root comes from cwd), so run it with
      // `cwd` set to `frontend/` and reference the vite binary by absolute path
      // (node_modules/.bin is hoisted to the repo root, not into frontend/).
      command: `VITE_SIGNALING_URL=ws://127.0.0.1:${SIG_PORT}/ws ${ROOT}/node_modules/.bin/vite dev --port ${FE_PORT} --strictPort`,
      url: `http://127.0.0.1:${FE_PORT}/`,
      timeout: 60_000,
      reuseOnNextRetry: true,
      cwd: `${ROOT}/frontend`,
      shell: "/bin/bash",
    },
  ],
});
