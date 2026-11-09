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
  /** More precise reason of some codes (invalid_patch: the patch check's code). */
  readonly detail: string | undefined;
  constructor(status: number, code: string, detail?: string) {
    super(`api ${status} ${code}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
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
    const err = (data as { error?: { code?: unknown; detail?: unknown } } | undefined)?.error;
    throw new ApiError(
      status,
      typeof err?.code === "string" ? err.code : "internal",
      typeof err?.detail === "string" ? err.detail : undefined,
    );
  }
  return data as T;
}

/** A provider identity linked to the account (T2.1). */
export interface Identity {
  provider: string;
  /** The email the provider reported when it was linked. */
  email: string;
  linked_at: string;
}

/** The signed-in account (T2.1). */
export interface Account {
  email: string;
  email_verified: boolean;
  /** The server sends emails: verifying is possible and asked for. */
  email_enabled: boolean;
  has_password: boolean;
  identities: Identity[];
}

/** What the server offers for accounts (GET /api/auth/config, T2.1). */
export interface AuthConfig {
  /** The server sends emails (verification, password reset). */
  email: boolean;
  /** OAuth providers with keys ("google", "discord"); never their secrets. */
  providers: string[];
}

const KNOWN_PROVIDERS = ["google", "discord"];
let authConfigCache: Promise<AuthConfig> | undefined;

/**
 * The server's account features, asked once per page. A server older than T2.1 answers
 * 404 (or fails), which means none.
 */
export function authConfig(): Promise<AuthConfig> {
  authConfigCache ??= call<{ email?: unknown; providers?: unknown }>(
    "GET",
    "/api/auth/config",
  ).then(
    (c) => ({
      email: c.email === true,
      providers: Array.isArray(c.providers)
        ? KNOWN_PROVIDERS.filter((p) => (c.providers as unknown[]).includes(p))
        : [],
    }),
    () => ({ email: false, providers: [] }),
  );
  return authConfigCache;
}

/** Whether the server sends emails (T2.1). */
export const emailEnabled = async (): Promise<boolean> => (await authConfig()).email;

/** Tests: forget the cached answer of authConfig. */
export function forgetEmailConfig(): void {
  authConfigCache = undefined;
}

/**
 * Body of POST /api/auth/register. `lang` only goes to a server that sends emails:
 * servers older than T2.1 reject unknown fields, and a desktop app may talk to one.
 */
export function registerBody(
  email: string,
  password: string,
  lang: string | undefined,
  emailOn: boolean,
): { email: string; password: string; lang?: string } {
  return lang && emailOn ? { email, password, lang } : { email, password };
}

export const api = {
  /** `lang` is the language of the verification email (T2.1), when the server sends one. */
  register: async (
    email: string,
    password: string,
    lang?: string,
  ): Promise<{ account_id: number }> =>
    call(
      "POST",
      "/api/auth/register",
      registerBody(email, password, lang, lang ? await emailEnabled() : false),
    ),
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

/** Email verification and password reset (T2.1, docs/05). Tokens go in POST bodies. */
export const accountApi = {
  account: (): Promise<Account> => call("GET", "/api/account"),
  verify: (token: string): Promise<void> => call("POST", "/api/auth/verify", { token }),
  resend: (lang: string): Promise<void> => call("POST", "/api/auth/verify/resend", { lang }),
  /** Answers the same whether or not the account exists. */
  forgot: (email: string, lang: string): Promise<void> =>
    call("POST", "/api/auth/password/forgot", { email, lang }),
  reset: (token: string, password: string): Promise<void> =>
    call("POST", "/api/auth/password/reset", { token, password }),
};

/** OAuth login and linked identities (T2.1, docs/05 "OAuth"). */
export const oauthApi = {
  /** Where to send the browser to log in with provider; `ret` is where it comes back. */
  start: (provider: string, ret: string): Promise<{ url: string }> =>
    call("POST", `/api/auth/oauth/${encodeURIComponent(provider)}/start`, { return: ret }),
  /** Linking needs the password of an account that has one (recent re-authentication). */
  link: (provider: string, password: string): Promise<{ url: string }> =>
    call(
      "POST",
      `/api/auth/oauth/${encodeURIComponent(provider)}/link`,
      password ? { password } : {},
    ),
  pending: (): Promise<{ provider: string; email: string }> =>
    call("GET", "/api/auth/oauth/pending"),
  confirm: (password: string): Promise<{ return: string }> =>
    call("POST", "/api/auth/oauth/pending/confirm", { password }),
  create: (email: string): Promise<{ return: string }> =>
    call("POST", "/api/auth/oauth/pending/create", { email }),
  unlink: (provider: string): Promise<void> => call("POST", "/api/account/unlink", { provider }),
};

/** A map submission of the portal (T4.5, docs/05 "Envío de mapas"). */
export interface MapSubmission {
  id: number;
  title: string;
  description: string;
  author: string;
  license: string;
  status: "pending" | "approved" | "rejected" | "pr_opened" | "failed";
  sha256: string;
  size: number;
  base_ref: string;
  files: { path: string; action: "create" | "modify" | "delete" }[];
  created_at: string;
  updated_at: string;
  reviewed_at?: string;
  reason?: string;
  failure?: string;
  pr_url?: string;
  pr_number?: number;
  /** False once the patch bytes were dropped (retention): no download. */
  has_patch: boolean;
}

export interface MySubmissions {
  submissions: MapSubmission[];
  can_review: boolean;
  /** The account's own email, for "signed in as". */
  email: string;
  license: string;
  /** The worker that opens pull requests runs (otherwise a maintainer does it by hand). */
  pr_worker: boolean;
  max_bytes: number;
  per_day: number;
}

export interface NewSubmission {
  title: string;
  description: string;
  character_id: number;
  license: string;
  /** The text of the .rpgpatch.json file. */
  patch: string;
}

const submissionPath = (id: number): string => `/api/maps/submissions/${String(id)}`;

export const mapsApi = {
  mine: (): Promise<MySubmissions> => call("GET", "/api/maps/submissions/mine"),
  submit: async (s: NewSubmission): Promise<MapSubmission> =>
    (await call<{ submission: MapSubmission }>("POST", "/api/maps/submissions", s)).submission,
  /** A page of the moderation lists; `next` is the cursor of the following page. */
  queue: (status: string, cursor = ""): Promise<{ submissions: MapSubmission[]; next?: string }> =>
    call(
      "GET",
      `/api/maps/submissions?${new URLSearchParams(cursor ? { status, cursor } : { status }).toString()}`,
    ),
  get: async (id: number): Promise<MapSubmission> =>
    (await call<{ submission: MapSubmission }>("GET", submissionPath(id))).submission,
  /** Where the browser downloads the patch (an attachment; the server sets the name). */
  patchUrl: (id: number): string => `${submissionPath(id)}/patch`,
  review: async (
    id: number,
    decision: "approve" | "reject",
    reason: string,
  ): Promise<MapSubmission> =>
    (
      await call<{ submission: MapSubmission }>("POST", `${submissionPath(id)}/review`, {
        decision,
        reason,
      })
    ).submission,
};
