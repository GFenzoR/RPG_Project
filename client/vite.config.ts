import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { repoRoot, rpgContent } from "./vite/content.ts";
import { rpgFonts } from "./vite/fonts.ts";

const dir = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
// The game server (HTTP API + /ws). The dev server proxies both, so the page, the API
// cookie and the WebSocket share one origin, as behind Caddy in production.
// 127.0.0.1, not localhost: the dev server listens on loopback IPv4 only (Makefile DEV_HTTP_ADDR).
const server = process.env["RPG_SERVER"] ?? "http://127.0.0.1:8080";
// Service worker (PWA, T5.6): a new version per build, so each deploy installs a new worker
// that drops the previous caches (src/sw.ts). RPG_BUILD_ID pins it for reproducible builds.
const swVersion = process.env["RPG_BUILD_ID"] ?? Date.now().toString(36);
// `tauri android dev` / `tauri ios dev` (docs/15-movil.md) set TAURI_DEV_HOST: the device
// loads the dev server over the LAN, so Vite listens there instead of only on localhost.
const tauriDevHost = process.env["TAURI_DEV_HOST"];

export default defineConfig({
  // The UI fonts (docs/17 UI-3) are subset to woff2 and served at /fonts/ (vite/fonts.ts).
  plugins: [rpgContent(), rpgFonts(repoRoot())],
  // Two pages (T4.3): the public website at / (index.html: landing, /highscores, /news)
  // and the game at /play/ (play/index.html). The desktop app opens play/index.html.
  // The service worker (src/sw.ts) is a third entry with a fixed name at the root
  // (/sw.js, scope /); everything else keeps Vite's hashed names under assets/.
  build: {
    rollupOptions: {
      input: {
        site: dir("./index.html"),
        play: dir("./play/index.html"),
        sw: dir("./src/sw.ts"),
        // make ui-preview only (docs/08): the game's DOM with made-up states, never shipped.
        ...(process.env["RPG_UI_PREVIEW"] ? { preview: dir("./preview/index.html") } : {}),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  define: { __RPG_SW_VERSION__: JSON.stringify(swVersion) },
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  server: {
    port: Number(process.env["CLIENT_PORT"] ?? 5173),
    strictPort: true,
    ...(tauriDevHost ? { host: tauriDevHost, hmr: { protocol: "ws", host: tauriDevHost } } : {}),
    cors: false,
    fs: { strict: true, allow: [dir("./"), dir("../packages/"), dir("../node_modules/")] },
    proxy: {
      "/api": { target: server },
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
});
