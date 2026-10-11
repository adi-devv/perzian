import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

// PERZIAN_PORT points the dev proxy at a daemon on another port (same variable the daemon reads);
// PERZIAN_WEB_PORT moves this server off 4318 (the daemon trusts that port too), for a second dev stack.
const daemon = `127.0.0.1:${process.env.PERZIAN_PORT ?? 4317}`;
const port = Number(process.env.PERZIAN_WEB_PORT ?? 4318);

export default defineConfig({
  plugins: [react()],
  define: { __PERZIAN_VERSION__: JSON.stringify(version) },
  base: "./",
  // strictPort: fail loudly if 4318 is taken instead of drifting to 4319, which the README URL and the
  // daemon's trusted origins wouldn't match.
  server: { port, strictPort: true, proxy: { "/ws": { target: `ws://${daemon}`, ws: true }, "/api": `http://${daemon}` } },
});
