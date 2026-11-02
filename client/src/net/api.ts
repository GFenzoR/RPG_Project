// HTTP API of the game server (docs/05-network-protocol.md, "API HTTP"). The web client
// authenticates with the HttpOnly session cookie set by /api/auth/login: it never asks for
// the token in the body, so a script on the page cannot read it.

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

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  if (res.status === 204) return undefined as T;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: unknown } } | undefined)?.error;
    throw new ApiError(res.status, typeof err?.code === "string" ? err.code : "internal");
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
