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
