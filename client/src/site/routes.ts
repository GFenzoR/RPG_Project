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
