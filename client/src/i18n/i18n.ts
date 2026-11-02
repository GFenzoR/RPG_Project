// Client texts: i18n/<lang>/client.yaml plus the content names it shows (vocations,
// monsters, NPCs), bundled by vite/content.ts. No visible string is hardcoded in the UI.
// Texts take {param} placeholders and ICU plurals:
//   "{seconds, plural, one {# segundo} other {# segundos}}"  (=N exact matches first).
// Parameter values are inserted as they are, never parsed again: a player's chat text
// cannot inject placeholders or markup (the UI renders it as text).
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export const DEFAULT_LANGUAGE = "es";

/** localStorage key of the language the player picked in the UI. */
export const LANGUAGE_STORAGE_KEY = "rpg.lang";

/** ?lang= if available, then the stored choice, then the browser language, then Spanish. */
export function pickLanguage(
  available: readonly string[],
  requested: string | null,
  browser: string,
  stored: string | null = null,
): string {
  if (requested && available.includes(requested)) return requested;
  if (stored && available.includes(stored)) return stored;
  const short = browser.slice(0, 2).toLowerCase();
  if (available.includes(short)) return short;
  return available.includes(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : (available[0] ?? "es");
}

/** Looks keys up in `texts`; an unknown key is returned as is so it shows up in review. */
export function translator(
  texts: Readonly<Record<string, string>>,
  lang = DEFAULT_LANGUAGE,
): Translate {
  let rules: Intl.PluralRules;
  try {
    rules = new Intl.PluralRules(lang);
  } catch {
    rules = new Intl.PluralRules(DEFAULT_LANGUAGE);
  }
  return (key, params) => {
    const text = texts[key] ?? key;
    if (!params) return text;
    return format(text, params, rules, undefined);
  };
}

/** Index of the "}" that closes the "{" at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

function format(
  text: string,
  params: Record<string, string | number>,
  rules: Intl.PluralRules,
  hash: number | undefined,
): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (c === "#" && hash !== undefined) {
      out += String(hash);
      i++;
      continue;
    }
    const end = c === "{" ? closing(text, i) : -1;
    if (end < 0) {
      out += c;
      i++;
      continue;
    }
    out += placeholder(text.slice(i, end + 1), params, rules);
    i = end + 1;
  }
  return out;
}

/** Fills one "{...}": a plain {name} or {name, plural, ...}; anything else stays as is. */
function placeholder(
  whole: string,
  params: Record<string, string | number>,
  rules: Intl.PluralRules,
): string {
  const inner = whole.slice(1, -1);
  const plain = /^\s*(\w+)\s*$/.exec(inner);
  if (plain) {
    const v = params[plain[1] ?? ""];
    return v === undefined ? whole : String(v);
  }
  const plural = /^\s*(\w+)\s*,\s*plural\s*,/.exec(inner);
  const value = plural ? params[plural[1] ?? ""] : undefined;
  if (!plural || value === undefined) return whole;
  const n = Number(value);
  const options = new Map<string, string>();
  const rest = inner.slice(plural[0].length);
  for (let i = 0; i < rest.length;) {
    const sel = /^\s*(=\d+|\w+)\s*\{/.exec(rest.slice(i));
    if (!sel) break;
    const open = i + sel[0].length - 1;
    const end = closing(rest, open);
    if (end < 0) break;
    options.set(sel[1] ?? "", rest.slice(open + 1, end));
    i = end + 1;
  }
  const body = options.get(`=${n}`) ?? options.get(rules.select(n)) ?? options.get("other");
  return body === undefined ? whole : format(body, params, rules, n);
}
