// Desktop app (apps/desktop, Tauri 2). The page is served from tauri://localhost (or
// http://tauri.localhost on Windows), not from the game server, so:
// - the HTTP API goes through the app's `api` command: Rust adds the account token, which
//   lives in the OS keyring and never reaches this page;
// - the WebSocket goes straight to the server the app was configured with (`server_info`).
// In a browser none of this runs: same-origin fetch with the HttpOnly cookie, as before.
import { invoke, isTauri } from "@tauri-apps/api/core";

interface ServerInfo {
  origin: string;
  ws_url: string;
  /** False when RPG_SERVER_URL pins the server for this run. */
  editable: boolean;
}

let server: ServerInfo | undefined;

/** True inside the desktop app. */
export const isDesktop = (): boolean => isTauri();

/** Asks the app which server to use. Call once before the first screen. */
export async function initDesktop(): Promise<void> {
  if (!isDesktop()) return;
  server = await invoke<ServerInfo>("server_info");
}

/** One API call through the app: the HTTP status and the JSON body (null if none). */
export function desktopApi(
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return invoke("api", { method, path, body: body ?? null });
}

/** URL of the game WebSocket: the configured server in the app, the page's host on the web. */
export function gameSocketUrl(
  page: { protocol: string; host: string },
  desktopWsUrl: string | undefined = server?.ws_url,
): string {
  if (desktopWsUrl !== undefined) return desktopWsUrl;
  const scheme = page.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${page.host}/ws`;
}

/** The server the app talks to (undefined on the web). */
export const desktopServer = (): ServerInfo | undefined => server;

/** Why a server URL typed in the app's picker is refused (an i18n key), or undefined. */
export type ServerUrlError = "invalid" | "insecure" | "path";

const privateIPv4 = (host: string): boolean => {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
};

/**
 * Same rules as the app's config.rs (`Server::parse`), checked here only to explain the
 * problem before saving; the app validates again. https://host[:port], or http:// for this
 * machine or a private network; no IPv6 literal, credentials, path, query or fragment.
 */
export function serverUrlError(raw: string): ServerUrlError | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "invalid";
  }
  if (url.hostname === "" || url.hostname.startsWith("[")) return "invalid";
  if (url.username !== "" || url.password !== "") return "invalid";
  if (url.protocol === "http:") {
    const host = url.hostname;
    if (host !== "localhost" && !host.endsWith(".localhost") && !privateIPv4(host))
      return "insecure";
  } else if (url.protocol !== "https:") {
    return "invalid";
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return "path";
  return undefined;
}

/** Saves the server in the app's config.json and restarts the app (it does not return). */
export function setDesktopServer(url: string): Promise<void> {
  return invoke("set_server", { url: url.trim() });
}
