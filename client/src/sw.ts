// Service worker of the installable web client (PWA, T5.6). Built by vite.config.ts as
// /sw.js (fixed name, scope "/"). It caches only the static shell; what each request gets
// is decided by sw/policy.ts (pure, with tests). The game API, the WebSocket and anything
// cross-origin are never intercepted.
//
// Only import sw/policy.ts here: a module shared with the pages would end up in a shared
// chunk, and a classic service worker cannot `import` it.
import {
  cacheName,
  isCacheableResponse,
  offlineFallback,
  SHELL_PAGES,
  staleCaches,
  strategyFor,
} from "./sw/policy.ts";

// Set by vite.config.ts at build time: a new value per build, so every deploy installs a new
// worker that drops the caches of the previous one.
declare const __RPG_SW_VERSION__: string;

// The project's tsconfig has the DOM lib, not WebWorker (they conflict): the few worker
// types used here are declared by hand.
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEvent) => void): void;
}

const scope = self as unknown as WorkerScope;
const CACHE = cacheName(__RPG_SW_VERSION__);

scope.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Best effort: a page that fails now is cached on its next visit instead.
      await Promise.all(
        SHELL_PAGES.map(async (path) => {
          try {
            const res = await fetch(path, { cache: "no-cache" });
            if (isCacheableResponse(res)) await cache.put(path, res);
          } catch {
            // offline during install: nothing to cache yet
          }
        }),
      );
      await scope.skipWaiting();
    })(),
  );
});

scope.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(staleCaches(names, __RPG_SW_VERSION__).map((n) => caches.delete(n)));
      await scope.clients.claim();
    })(),
  );
});

scope.addEventListener("fetch", (e) => {
  const req = e.request;
  const strategy = strategyFor(
    { method: req.method, url: req.url, mode: req.mode, range: req.headers.get("range") },
    scope.location.origin,
  );
  switch (strategy) {
    case "network":
      return; // not intercepted
    case "network-first":
      e.respondWith(networkFirst(req));
      return;
    case "cache-first":
      e.respondWith(cacheFirst(req));
      return;
    case "stale-while-revalidate":
      e.respondWith(staleWhileRevalidate(e, req));
      return;
  }
});

async function store(req: Request, res: Response): Promise<void> {
  if (!isCacheableResponse(res)) return;
  const cache = await caches.open(CACHE);
  await cache.put(req, res);
}

async function networkFirst(req: Request): Promise<Response> {
  try {
    const res = await fetch(req);
    await store(req, res.clone());
    return res;
  } catch (err) {
    const cache = await caches.open(CACHE);
    const hit =
      (await cache.match(req, { ignoreSearch: true })) ??
      (await cache.match(offlineFallback(req.url)));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  await store(req, res.clone());
  return res;
}

async function staleWhileRevalidate(e: FetchEvent, req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req).then(async (res) => {
    await store(req, res.clone());
    return res;
  });
  if (hit) {
    e.waitUntil(refresh.catch(() => undefined));
    return hit;
  }
  return refresh;
}
