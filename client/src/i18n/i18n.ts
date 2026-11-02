// Client texts: i18n/<lang>/client.yaml plus the content names it shows (vocations,
// monsters, NPCs), bundled by vite/content.ts. No visible string is hardcoded in the UI.
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export const DEFAULT_LANGUAGE = "es";

/** ?lang= if available, else the browser language, else Spanish. */
export function pickLanguage(
  available: readonly string[],
  requested: string | null,
  browser: string,
): string {
  if (requested && available.includes(requested)) return requested;
  const short = browser.slice(0, 2).toLowerCase();
  if (available.includes(short)) return short;
  return available.includes(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : (available[0] ?? "es");
}

/** Looks keys up in `texts`; an unknown key is returned as is so it shows up in review. */
export function translator(texts: Readonly<Record<string, string>>): Translate {
  return (key, params) => {
    const text = texts[key] ?? key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (m, name: string) =>
      params[name] === undefined ? m : String(params[name]),
    );
  };
}
