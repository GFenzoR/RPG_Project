// HTTP API of the game server (docs/05-network-protocol.md, "API HTTP"). The web client
// authenticates with the HttpOnly session cookie set by /api/auth/login: it never asks for
// the token in the body, so a script on the page cannot read it. In the desktop app the
// call goes through Rust (net/desktop.ts), which keeps the token in the OS keyring.
import { desktopApi, isDesktop } from "./desktop.ts";

export interface Character {
  id: number;
  name: string;
  vocation: string;
  level: number;
}

/** A failed API call. `code` is the server's error code; the UI shows t(`error.<code>`). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`api ${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

/** Status and parsed JSON body (undefined when empty or not JSON) of one call. */
async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  if (isDesktop()) {
    try {
      const res = await desktopApi(method, path, body);
      return { status: res.status, data: res.body ?? undefined };
    } catch {
      throw new ApiError(0, "network");
    }
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "network");
  }
  if (res.status === 204) return { status: 204, data: undefined };
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  return { status: res.status, data };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { status, data } = await send(method, path, body);
  if (status < 200 || status > 299) {
    const err = (data as { error?: { code?: unknown } } | undefined)?.error;
    throw new ApiError(status, typeof err?.code === "string" ? err.code : "internal");
  }
  return data as T;
}

export const api = {
  register: (email: string, password: string): Promise<{ account_id: number }> =>
    call("POST", "/api/auth/register", { email, password }),
  login: (email: string, password: string): Promise<{ expires_at: string }> =>
    call("POST", "/api/auth/login", { email, password }),
  logout: (): Promise<void> => call("POST", "/api/auth/logout"),
  characters: async (): Promise<Character[]> =>
    (await call<{ characters: Character[] }>("GET", "/api/characters")).characters,
  createCharacter: async (name: string, vocation: string): Promise<Character> =>
    (await call<{ character: Character }>("POST", "/api/characters", { name, vocation })).character,
  play: (characterId: number): Promise<{ session_token: string; expires_at: string }> =>
    call("POST", "/api/play", { character_id: characterId }),
};
