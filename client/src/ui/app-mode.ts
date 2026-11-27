// The page's one app-mode store (owner, 2026-11-24; docs/15 "Pantalla completa e instalar
// como app"): the browser glue around the pure rules of state/install.ts. It is imported
// by main.tsx at startup, because Chromium fires `beforeinstallprompt` once, early, and
// the event must be kept to call prompt() from the button later. Components read it with
// useAppMode (ui/AppMode.tsx).
import { isTauri } from "@tauri-apps/api/core";
import {
  UPDATE_EVENT,
  appModeReduce,
  displayStandalone,
  initialAppMode,
} from "../state/install.ts";
import type { AppModeEvent, AppModeState, PlatformEnv } from "../state/install.ts";
import { optionStorage } from "../state/option-storage.ts";
import { loadAppMode, saveAppMode } from "../state/touch-controls.ts";

/** Chromium's install event (not in lib.dom). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** WebKit's prefixed fullscreen (iPadOS Safari before 16.4). */
interface WebkitDocument {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}
interface WebkitElement {
  webkitRequestFullscreen?: () => void;
}

function matches(query: string): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia(query).matches;
  } catch {
    return false;
  }
}

function readEnv(): PlatformEnv {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const doc = typeof document === "undefined" ? undefined : document;
  const wdoc = doc as (Document & WebkitDocument) | undefined;
  let tauri: boolean;
  try {
    tauri = isTauri();
  } catch {
    tauri = false;
  }
  return {
    userAgent: nav?.userAgent ?? "",
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    iosStandalone: (nav as { standalone?: boolean } | undefined)?.standalone === true,
    displayStandalone: displayStandalone(matches),
    fullscreenApi: (doc?.fullscreenEnabled ?? wdoc?.webkitFullscreenEnabled) === true,
    tauri,
  };
}

function fullscreenElement(): Element | null {
  const d = document as Document & WebkitDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

let state: AppModeState | undefined;
let deferred: InstallPromptEvent | undefined;
let updateReady = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function dispatch(e: AppModeEvent): void {
  const before = current();
  const next = appModeReduce(before, e);
  state = next;
  if (next.memory !== before.memory) saveAppMode(next.memory, optionStorage());
  emit();
}

function start(): AppModeState {
  const s = initialAppMode(readEnv(), loadAppMode(optionStorage()));
  if (typeof window === "undefined") return s;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // no mini-infobar: the game's own button prompts
    deferred = e as InstallPromptEvent;
    dispatch({ kind: "beforeinstallprompt" });
  });
  window.addEventListener("appinstalled", () => {
    deferred = undefined;
    dispatch({ kind: "appinstalled" });
  });
  const changed = (): void =>
    dispatch({ kind: "fullscreenchange", active: fullscreenElement() !== null });
  document.addEventListener("fullscreenchange", changed);
  document.addEventListener("webkitfullscreenchange", changed);
  // pwa.ts announces a new version of the app taking over (an installed app has no reload
  // button: ui/AppMode.tsx offers one).
  window.addEventListener(UPDATE_EVENT, () => {
    updateReady = true;
    emit();
  });
  return { ...s, fullscreen: fullscreenElement() !== null };
}

function current(): AppModeState {
  state ??= start();
  return state;
}

export function appMode(): AppModeState {
  return current();
}

export function appUpdateReady(): boolean {
  current();
  return updateReady;
}

export function subscribeAppMode(fn: () => void): () => void {
  current();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Enters fullscreen. Must run inside a user gesture (the button's click). The browser's
 * own navigation UI is asked to hide; a refusal (no gesture, a policy) changes nothing.
 */
export function enterFullscreen(): void {
  dispatch({ kind: "fullscreenAsked", on: true });
  const el = document.documentElement as HTMLElement & WebkitElement;
  try {
    if (typeof el.requestFullscreen === "function")
      el.requestFullscreen({ navigationUI: "hide" }).catch(() => undefined);
    else el.webkitRequestFullscreen?.();
  } catch {
    // Refused: fullscreenchange never comes and the button stays as it was.
  }
}

export function exitFullscreen(): void {
  dispatch({ kind: "fullscreenAsked", on: false });
  const d = document as Document & WebkitDocument;
  try {
    if (typeof d.exitFullscreen === "function") d.exitFullscreen().catch(() => undefined);
    else d.webkitExitFullscreen?.();
  } catch {
    // Already out of it.
  }
}

/** The player closed the fullscreen re-offer: it is not offered again until asked for. */
export function forgetFullscreen(): void {
  dispatch({ kind: "fullscreenAsked", on: false });
}

/** Shows Chromium's install prompt (from the button's click). */
export function promptInstall(): void {
  const e = deferred;
  if (!e) return;
  deferred = undefined;
  void e
    .prompt()
    .then(() => e.userChoice)
    .then((choice) => dispatch({ kind: "prompted", accepted: choice.outcome === "accepted" }))
    .catch(() => dispatch({ kind: "prompted", accepted: false }));
}

export function dismissInstall(): void {
  dispatch({ kind: "dismissInstall" });
}

// ---- wake lock: the screen stays on while playing -------------------------------------

interface WakeLockSentinelLike {
  release(): Promise<void>;
}
let wanted = false;
let sentinel: WakeLockSentinelLike | undefined;

function acquire(): void {
  const lock = (
    navigator as { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } }
  ).wakeLock;
  if (!wanted || sentinel || !lock || document.visibilityState !== "visible") return;
  lock
    .request("screen")
    .then((s) => {
      if (wanted) sentinel = s;
      else void s.release().catch(() => undefined);
    })
    .catch(() => undefined); // low battery, no permission: the game plays on
}

let watching = false;

/** Keeps the screen awake while `on` (in the game); the lock is taken again when the tab comes back. */
export function keepAwake(on: boolean): void {
  wanted = on;
  if (typeof document === "undefined" || typeof navigator === "undefined") return;
  if (!watching) {
    watching = true;
    document.addEventListener("visibilitychange", () => {
      // The browser drops the lock when the page is hidden.
      if (document.visibilityState !== "visible") sentinel = undefined;
      else acquire();
    });
  }
  if (on) acquire();
  else {
    const s = sentinel;
    sentinel = undefined;
    void s?.release().catch(() => undefined);
  }
}
