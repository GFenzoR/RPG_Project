// The real dev server config (vite.config.ts): other local origins get no CORS approval
// and /@fs/ serves nothing outside the editor's own code.
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Vite's /@fs/ URLs take a forward-slash absolute path: the repo's file URL pathname is
// exactly that (/home/me/repo/ on POSIX, /C:/me/repo/ on Windows, where a native path
// would give /@fsC:\... and never reach /@fs/ at all).
const repo = new URL("../../", import.meta.url).pathname;
const fsUrl = (rel: string): string => `${base}/@fs${repo}${rel}`;
let server: ViteDevServer;
let base = "";

beforeAll(async () => {
  server = await createServer({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("../", import.meta.url)),
    logLevel: "silent",
    server: { port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  base = `http://localhost:${(server.httpServer?.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await server?.close();
});

const foreign = "http://localhost:9999";

describe("editor dev server", () => {
  it("does not approve a preflight for the API header from another local origin", async () => {
    const res = await fetch(`${base}/api/save`, {
      method: "OPTIONS",
      headers: {
        origin: foreign,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-rpg-editor",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });

  it("does not let another origin read files through /@fs/", async () => {
    const res = await fetch(fsUrl("editor/package.json"), {
      headers: { origin: foreign },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves the editor but nothing outside it through /@fs/, even to itself", async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    // Control: the URL really reaches /@fs/ (the SPA fallback would answer 200 text/html).
    const own = await fetch(fsUrl("editor/package.json"));
    expect(own.status).toBe(200);
    expect(((await own.json()) as { name?: string }).name).toBe("@rpg/editor");
    expect((await fetch(fsUrl("world/world.yaml"))).status).toBe(403);
    expect((await fetch(fsUrl("package.json"))).status).toBe(403);
  });
});
