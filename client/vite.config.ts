import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { rpgContent } from "./vite/content.ts";

const dir = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
// The game server (HTTP API + /ws). The dev server proxies both, so the page, the API
// cookie and the WebSocket share one origin, as behind Caddy in production.
const server = process.env["RPG_SERVER"] ?? "http://localhost:8080";

export default defineConfig({
  plugins: [rpgContent()],
  // Two pages (T4.3): the public website at / (index.html: landing, /highscores, /news)
  // and the game at /play/ (play/index.html). The desktop app opens play/index.html.
  build: {
    rollupOptions: {
      input: { site: dir("./index.html"), play: dir("./play/index.html") },
    },
  },
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  server: {
    port: Number(process.env["CLIENT_PORT"] ?? 5173),
    strictPort: true,
    cors: false,
    fs: { strict: true, allow: [dir("./"), dir("../packages/"), dir("../node_modules/")] },
    proxy: {
      "/api": { target: server },
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
});
