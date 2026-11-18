// What the service worker (src/sw.ts, T5.6) does with each request. Pure: no DOM, no
// caches, so it runs under Vitest. Only the static shell of the client build is cached:
// the pages, the hashed Vite assets, the atlas, the sounds, the icons and the manifest.
// The game API, the WebSocket, the music and anything cross-origin always go straight to
// the network.
//
// This module must only be imported by src/sw.ts (and tests): if the page imported it too,
// the bundler would move it to a shared chunk and sw.js would need an ES `import`, which a
// classic service worker cannot do.

/** Prefix of every cache this worker owns; activate deletes the ones of other versions. */
export const CACHE_PREFIX = "rpg-shell-";

/** Pages cached on install, so the game opens offline-first after the first visit. */
export const SHELL_PAGES: readonly string[] = ["/", "/play/", "/manifest.webmanifest"];

/**
 * - `network`: not handled (the browser does a normal request; nothing is stored); the
 *   music too: whole tracks of ~1 MB (13 MiB in all) that the audio engine fetches once per
 *   session and keeps itself (docs/07 "Audio");
 * - `network-first`: pages, so a deploy is picked up on the next load; the cache is only the
 *   offline fallback;
 * - `cache-first`: Vite's hashed files under /assets/ (immutable, like Caddy says);
 * - `stale-while-revalidate`: other static files (atlas, sounds, icons, manifest).
 */
export type Strategy = "network" | "network-first" | "cache-first" | "stale-while-revalidate";

/** The parts of a Request the decision needs. */
export interface RequestInfo {
  method: string;
  url: string;
  /** Request.mode: "navigate" for page loads. */
  mode: string;
  /** Value of the Range header, if any (media elements ask for byte ranges). */
  range?: string | null;
}

/** Paths that belong to the game server or to operations, never to the shell. */
const BACKEND = [/^\/api(\/|$)/, /^\/ws(\/|$)/, /^\/healthz$/, /^\/grafana(\/|$)/];

/**
 * The music (assets/sounds/music/, served under /audio/). Stored by the worker, a PWA would
 * keep every track it ever played and write a whole one into its cache at each zone change.
 */
const MUSIC = /^\/audio\/sounds\/music\//;

/** The worker script itself: the browser revalidates it on its own. */
const SELF = "/sw.js";

export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/** Caches of this worker that are not the current version (to delete on activate). */
export function staleCaches(names: readonly string[], version: string): string[] {
  const current = cacheName(version);
  return names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== current);
}

export function strategyFor(req: RequestInfo, origin: string): Strategy {
  if (req.method !== "GET") return "network";
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return "network";
  }
  if (url.origin !== origin) return "network";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "network";
  const path = url.pathname;
  if (BACKEND.some((re) => re.test(path))) return "network";
  if (path === SELF) return "network";
  // Partial responses (206) cannot be stored whole; let the browser stream audio itself.
  if (req.range) return "network";
  if (MUSIC.test(path)) return "network";
  if (req.mode === "navigate") return "network-first";
  if (path.startsWith("/assets/")) return "cache-first";
  return "stale-while-revalidate";
}

/** Only complete, same-origin, successful responses are stored. */
export function isCacheableResponse(res: { status: number; type: string }): boolean {
  return res.status === 200 && res.type === "basic";
}

/**
 * The cached page to show when a navigation fails offline: the game page for /play and
 * anything under it, the website page for every other route (the website is a SPA).
 */
export function offlineFallback(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "/";
  }
  return path === "/play" || path.startsWith("/play/") ? "/play/" : "/";
}
