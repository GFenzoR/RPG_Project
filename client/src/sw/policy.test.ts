import { describe, expect, it } from "vitest";
import {
  CACHE_PREFIX,
  cacheName,
  isCacheableResponse,
  offlineFallback,
  SHELL_PAGES,
  staleCaches,
  strategyFor,
} from "./policy.ts";
import type { RequestInfo } from "./policy.ts";

const ORIGIN = "https://juego.example.com";
const get = (path: string, extra: Partial<RequestInfo> = {}): RequestInfo => ({
  method: "GET",
  url: path.startsWith("http") ? path : `${ORIGIN}${path}`,
  mode: "no-cors",
  ...extra,
});

describe("strategyFor", () => {
  it("never handles the API, the WebSocket, health or Grafana", () => {
    for (const path of [
      "/api",
      "/api/characters",
      "/api/auth/login?x=1",
      "/ws",
      "/ws/",
      "/healthz",
      "/grafana/",
      "/grafana",
    ]) {
      expect(strategyFor(get(path), ORIGIN), path).toBe("network");
      expect(strategyFor(get(path, { mode: "navigate" }), ORIGIN), path).toBe("network");
    }
  });

  it("does not confuse lookalike static paths with the backend", () => {
    expect(strategyFor(get("/apiary.png"), ORIGIN)).toBe("stale-while-revalidate");
    expect(strategyFor(get("/wsx/a.png"), ORIGIN)).toBe("stale-while-revalidate");
  });

  it("never handles other origins, other methods or other schemes", () => {
    expect(strategyFor(get("https://cdn.example.com/assets/a.js"), ORIGIN)).toBe("network");
    expect(strategyFor(get("http://juego.example.com/assets/a.js"), ORIGIN)).toBe("network");
    expect(strategyFor(get("/assets/a.js", { method: "POST" }), ORIGIN)).toBe("network");
    expect(strategyFor(get("/assets/a.js", { method: "HEAD" }), ORIGIN)).toBe("network");
    expect(strategyFor(get("not a url"), ORIGIN)).toBe("network");
  });

  it("leaves the worker script and range requests to the browser", () => {
    expect(strategyFor(get("/sw.js"), ORIGIN)).toBe("network");
    expect(strategyFor(get("/audio/music.ogg", { range: "bytes=0-" }), ORIGIN)).toBe("network");
  });

  it("pages are network-first, hashed assets cache-first, the rest revalidated", () => {
    expect(strategyFor(get("/play/?lang=es", { mode: "navigate" }), ORIGIN)).toBe("network-first");
    expect(strategyFor(get("/highscores", { mode: "navigate" }), ORIGIN)).toBe("network-first");
    expect(strategyFor(get("/assets/main-abc123.js"), ORIGIN)).toBe("cache-first");
    expect(strategyFor(get("/atlas/atlas.png"), ORIGIN)).toBe("stale-while-revalidate");
    expect(strategyFor(get("/audio/ui/click.ogg", { range: null }), ORIGIN)).toBe(
      "stale-while-revalidate",
    );
    expect(strategyFor(get("/manifest.webmanifest"), ORIGIN)).toBe("stale-while-revalidate");
  });

  it("works on a plain-http home server too", () => {
    const origin = "http://192.168.1.20";
    expect(strategyFor(get(`${origin}/assets/a.js`), origin)).toBe("cache-first");
    expect(strategyFor(get(`${origin}/ws`), origin)).toBe("network");
  });
});

describe("caches", () => {
  it("names caches by version and drops only this worker's old ones", () => {
    expect(cacheName("7")).toBe(`${CACHE_PREFIX}7`);
    expect(staleCaches([cacheName("6"), cacheName("7"), "other-app", cacheName("5")], "7")).toEqual(
      [cacheName("6"), cacheName("5")],
    );
  });

  it("stores only complete same-origin successes", () => {
    expect(isCacheableResponse({ status: 200, type: "basic" })).toBe(true);
    expect(isCacheableResponse({ status: 206, type: "basic" })).toBe(false);
    expect(isCacheableResponse({ status: 404, type: "basic" })).toBe(false);
    expect(isCacheableResponse({ status: 200, type: "opaque" })).toBe(false);
    expect(isCacheableResponse({ status: 200, type: "cors" })).toBe(false);
  });

  it("precaches the two pages and no backend path", () => {
    expect(SHELL_PAGES).toContain("/");
    expect(SHELL_PAGES).toContain("/play/");
    for (const p of SHELL_PAGES) expect(strategyFor(get(p), ORIGIN)).not.toBe("network");
  });
});

describe("offlineFallback", () => {
  it("serves the game page under /play and the website elsewhere", () => {
    expect(offlineFallback(`${ORIGIN}/play`)).toBe("/play/");
    expect(offlineFallback(`${ORIGIN}/play/?lang=en`)).toBe("/play/");
    expect(offlineFallback(`${ORIGIN}/playground`)).toBe("/");
    expect(offlineFallback(`${ORIGIN}/news/hello`)).toBe("/");
    expect(offlineFallback("nope")).toBe("/");
  });
});
