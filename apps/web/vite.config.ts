import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 4318, proxy: { "/ws": { target: "ws://127.0.0.1:4317", ws: true }, "/api": "http://127.0.0.1:4317" } },
});
