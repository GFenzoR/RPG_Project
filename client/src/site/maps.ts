// Map submission portal (T4.5): pure helpers of the website's pages /maps/submit,
// /maps/mine and /maps/review. The server checks everything again; these only give the
// player quick feedback and pick the texts. Tested without a browser (maps.test.ts).
import type { MapSubmission } from "../net/api.ts";

export const MAP_STATUSES = ["pending", "approved", "rejected", "pr_opened", "failed"] as const;
export type MapStatus = (typeof MAP_STATUSES)[number];

/** Patch check codes of the server (server/internal/mappatch) with their own text. */
const PATCH_CODES = new Set([
  "too_large",
  "not_utf8",
  "not_json",
  "duplicate_key",
  "unknown_field",
  "not_patch",
  "format",
  "base_ref",
  "no_files",
  "too_many_files",
  "path",
  "duplicate_path",
  "base",
  "content",
  "empty_file",
  "missing_base_text",
  "base_mismatch",
  "forbidden_char",
  "unchanged",
]);

/** API error codes of the portal with their own text (others are the shared error.*). */
const MAP_ERRORS = new Set([
  "license_required",
  "invalid_title",
  "invalid_description",
  "invalid_reason",
  "patch_too_large",
  "submit_limit",
  "account_too_new",
  "duplicate_submission",
  "not_pending",
  "forbidden",
  "own_submission",
  "account_blocked",
  "patch_gone",
]);

/** i18n key of a failed portal call (ApiError code and detail). */
export function errorKey(code: string, detail?: string): string {
  if (code === "invalid_patch")
    return detail !== undefined && PATCH_CODES.has(detail)
      ? `site.maps.patch_error.${detail}`
      : "site.maps.patch_error.not_patch";
  if (MAP_ERRORS.has(code)) return `site.maps.error.${code}`;
  return `error.${code}`;
}

/** UTF-8 size of a text: what the server measures against its limit. */
export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Quick look at a chosen file before uploading it: null if it looks like a patch, or the
 * patch check code the server would answer for the obvious problems.
 */
export function precheckPatch(text: string, maxBytes: number): string | null {
  if (byteLength(text) > maxBytes) return "too_large";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "not_json";
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "not_patch";
  const o = raw as { kind?: unknown; format?: unknown; files?: unknown };
  if (o.kind !== "rpg-map-patch" || !Array.isArray(o.files)) return "not_patch";
  if (o.format !== 2) return "format";
  if (o.files.length === 0) return "no_files";
  return null;
}

/** Size for people: bytes under 1 KiB, then KiB or MiB with one decimal. */
export function formatSize(bytes: number, lang: string): string {
  const num = (n: number): string =>
    new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(n);
  if (bytes < 1024) return `${num(bytes)} B`;
  if (bytes < 1024 * 1024) return `${num(bytes / 1024)} KiB`;
  return `${num(bytes / (1024 * 1024))} MiB`;
}

/** Map files a submission touches, grouped by island id (data), or "world"/"prefabs". */
export function groupFiles(files: MapSubmission["files"]): Map<string, MapSubmission["files"]> {
  const out = new Map<string, MapSubmission["files"]>();
  for (const f of files) {
    const m = /^world\/islands\/([a-z][a-z0-9_]*)\//.exec(f.path);
    const key = m?.[1] ?? (f.path.startsWith("world/prefabs/") ? "prefabs" : "world");
    const list = out.get(key) ?? [];
    list.push(f);
    out.set(key, list);
  }
  return out;
}

/** Title and description as the server will store them (trimmed, CR LF → LF). */
export function cleanInput(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

/** The form can be sent: a title, a character, the license accepted and a file read. */
export function canSubmit(f: {
  title: string;
  characterId: number | null;
  license: boolean;
  patch: string | null;
  busy: boolean;
}): boolean {
  return (
    !f.busy && cleanInput(f.title) !== "" && f.characterId !== null && f.license && f.patch !== null
  );
}

/** Heading of a file group: an island id is shown as is, the other two are i18n keys. */
export function groupLabel(group: string, t: (key: string) => string): string {
  return group === "world" || group === "prefabs" ? t(`site.maps.group.${group}`) : group;
}

export const isMapStatus = (s: string): s is MapStatus =>
  (MAP_STATUSES as readonly string[]).includes(s);

/**
 * The PR link of a submission, only when it is an https URL of github.com (the URL comes
 * from the server, but a link is a place where a bad value would hurt).
 */
export function safePrUrl(m: Pick<MapSubmission, "pr_url">): string | undefined {
  const u = m.pr_url;
  if (u === undefined) return undefined;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
