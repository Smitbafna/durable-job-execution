import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * ResumeDrop frontend.
 *
 * The signaling server is a separate local service (default ws://localhost:4000/ws).
 * Override with the VITE_SIGNALING_URL env var when the server runs elsewhere.
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
