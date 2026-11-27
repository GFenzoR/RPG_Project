// Installable web client (PWA, T5.6): registers the service worker built as /sw.js
// (src/sw.ts). The worker caches only the static shell; the API and the WebSocket never
// go through it (src/sw/policy.ts). Pages import this module once (see main.tsx).
import { isTauri } from "@tauri-apps/api/core";
import { UPDATE_EVENT, isAppUpdate } from "./state/install.ts";

/** Where the worker is served and what it controls (the website at / and the game at /play/). */
export const SERVICE_WORKER_URL = "/sw.js";
export const SERVICE_WORKER_SCOPE = "/";

export interface RegistrationEnv {
  /** A production build (`import.meta.env.PROD`): Vite's dev server has no /sw.js. */
  prod: boolean;
  /** `navigator.serviceWorker` exists. */
  supported: boolean;
  /** `window.isSecureContext` (https, or localhost). */
  secure: boolean;
  /** Inside the Tauri app: its tauri:// pages cannot use a worker and do not need one. */
  desktop: boolean;
  /** `location.protocol`. */
  protocol: string;
}

/** Whether this page should register the service worker. Pure, for tests. */
export function shouldRegisterServiceWorker(env: RegistrationEnv): boolean {
  if (!env.prod || !env.supported || !env.secure || env.desktop) return false;
  return env.protocol === "https:" || env.protocol === "http:";
}

/** Registers the worker after the page has loaded, so it never competes with the game. */
export function registerServiceWorker(): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;
  const env: RegistrationEnv = {
    prod: import.meta.env.PROD,
    supported: "serviceWorker" in navigator,
    secure: window.isSecureContext,
    desktop: isTauri(),
    protocol: window.location.protocol,
  };
  if (!shouldRegisterServiceWorker(env)) return;
  const register = (): void => {
    navigator.serviceWorker
      .register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE })
      .then(watchUpdates)
      .catch((err: unknown) => console.warn("[pwa] service worker not registered", err));
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

/**
 * The update flow (lote 21, docs/15): an installed app is never "reloaded" by its player, so
 * a new worker taking over (sw.ts skips waiting and claims the page) is announced on
 * `window` and the UI offers "new version, reload" (ui/AppMode.tsx). The browser looks for
 * a new worker on each navigation; an app left open looks again when it comes back to the
 * foreground.
 */
function watchUpdates(reg: ServiceWorkerRegistration): void {
  reg.addEventListener("updatefound", () => {
    const worker = reg.installing;
    const hadController = navigator.serviceWorker.controller !== null;
    worker?.addEventListener("statechange", () => {
      if (isAppUpdate(worker.state, hadController)) window.dispatchEvent(new Event(UPDATE_EVENT));
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reg.update().catch(() => undefined);
  });
}

registerServiceWorker();
