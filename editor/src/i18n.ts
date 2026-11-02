// Editor texts come from i18n/<lang>/editor.yaml (and item names from items.yaml), sent by
// the dev server. No player- or user-visible string is hardcoded in the UI.
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export function pickLanguage(
  available: string[],
  requested: string | null,
  browser: string,
): string {
  if (requested && available.includes(requested)) return requested;
  const short = browser.slice(0, 2);
  if (available.includes(short)) return short;
  return available.includes("es") ? "es" : (available[0] ?? "es");
}

export function translator(texts: Record<string, string>): Translate {
  return (key, params) => {
    const text = texts[key] ?? key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (m, name: string) =>
      params[name] === undefined ? m : String(params[name]),
    );
  };
}
