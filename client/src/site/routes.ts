// Routes and highscore filters of the public website (T4.3). Pure: the page reads and
// writes the URL through these, and the tests check them without a browser.

export type Route =
  | { page: "home" }
  | { page: "highscores" }
  | { page: "news" }
  | { page: "post"; slug: string }
  | { page: "maps_submit" }
  | { page: "maps_mine" }
  | { page: "maps_review"; id?: number }
  | { page: "verify" }
  | { page: "forgot_password" }
  | { page: "reset_password" }
  | { page: "account" }
  | { page: "oauth_confirm" }
  | { page: "oauth_error" }
  | { page: "not_found" };

/** The website's route for a path. The game is /play/ (another page, not routed here). */
export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/index.html") return { page: "home" };
  if (path === "/highscores") return { page: "highscores" };
  if (path === "/news") return { page: "news" };
  const m = /^\/news\/([a-z0-9-]+)$/.exec(path);
  if (m?.[1]) return { page: "post", slug: m[1] };
  if (path === "/maps" || path === "/maps/submit") return { page: "maps_submit" };
  if (path === "/maps/mine") return { page: "maps_mine" };
  if (path === "/verify") return { page: "verify" };
  if (path === "/forgot-password") return { page: "forgot_password" };
  if (path === "/reset-password") return { page: "reset_password" };
  if (path === "/account") return { page: "account" };
  if (path === "/oauth/confirm") return { page: "oauth_confirm" };
  if (path === "/oauth/error") return { page: "oauth_error" };
  if (path === "/maps/review") return { page: "maps_review" };
  const r = /^\/maps\/review\/([1-9][0-9]{0,15})$/.exec(path);
  if (r?.[1]) return { page: "maps_review", id: Number(r[1]) };
  return { page: "not_found" };
}

export const LEVEL = "level";
/** Must match httpapi.HighscoreMaxPages. */
export const MAX_PAGES = 50;

export interface Filters {
  /** "level" or a skill id. */
  category: string;
  /** A vocation id; "" = every vocation. */
  vocation: string;
  page: number;
}

/** Filters from a query string; unknown values fall back to the defaults. */
export function parseFilters(
  search: string,
  skills: readonly string[],
  vocations: readonly string[],
): Filters {
  const q = new URLSearchParams(search);
  const category = q.get("category") ?? LEVEL;
  const vocation = q.get("vocation") ?? "";
  const page = Number(q.get("page") ?? "1");
  return {
    category: category === LEVEL || skills.includes(category) ? category : LEVEL,
    vocation: vocations.includes(vocation) ? vocation : "",
    page: Number.isInteger(page) && page >= 1 && page <= MAX_PAGES ? page : 1,
  };
}

/** The query string of filters (defaults left out), keeping other parameters (lang). */
export function filtersToSearch(f: Filters, current = ""): string {
  const q = new URLSearchParams(current);
  for (const k of ["category", "vocation", "page"]) q.delete(k);
  if (f.category !== LEVEL) q.set("category", f.category);
  if (f.vocation !== "") q.set("vocation", f.vocation);
  if (f.page !== 1) q.set("page", String(f.page));
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

/** GET path of the API for filters. */
export function highscoresPath(f: Filters): string {
  const q = new URLSearchParams({ category: f.category, page: String(f.page) });
  if (f.vocation !== "") q.set("vocation", f.vocation);
  return `/api/highscores?${q.toString()}`;
}

/** i18n key of a category's name. */
export function categoryKey(category: string): string {
  return category === LEVEL ? "site.highscores.level" : `skill.${category}.name`;
}

/**
 * The token of an emailed link (T2.1): it travels in the fragment (#token=…), which the
 * browser never sends to a server, so it cannot end up in an access log. Only what a
 * server token can look like (43 base64url characters) is accepted.
 */
export function linkToken(hash: string): string | undefined {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

/** Codes of /oauth/error?code= (site.oauth.error.<code>); anything else is "internal". */
export const OAUTH_ERRORS = [
  "state",
  "denied",
  "provider",
  "no_email",
  "identity_taken",
  "provider_linked",
  "unknown_provider",
  "account_disabled",
  "account_banned",
  "email_taken",
  "busy",
  "internal",
] as const;

/** i18n key of the error of /oauth/error's query. */
export function oauthErrorKey(search: string): string {
  const code = new URLSearchParams(search).get("code") ?? "";
  return `site.oauth.error.${(OAUTH_ERRORS as readonly string[]).includes(code) ? code : "internal"}`;
}

/**
 * The provider of /account?linked=<provider>, only if it is a known provider that the
 * account really has linked (anything else in the URL is ignored, never shown).
 */
export function linkedProvider(search: string, linked: readonly string[]): string | undefined {
  const p = new URLSearchParams(search).get("linked") ?? "";
  return ["google", "discord"].includes(p) && linked.includes(p) ? p : undefined;
}
