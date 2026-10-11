import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PERZIAN_PORT points the dev proxy at a daemon on another port (same variable the daemon reads).
const daemon = `127.0.0.1:${process.env.PERZIAN_PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 4318, proxy: { "/ws": { target: `ws://${daemon}`, ws: true }, "/api": `http://${daemon}` } },
});
