// Pure helpers of the /credits page (docs/17 A1): where each licence's text lives and
// which links the page may show. The data comes from assets/CREDITS.md at build time
// (vite/credits.ts); these keep a malformed row from becoming a strange link.

/** The official text of each licence CREDITS.md accepts, by the name it gives it. */
const LICENCE_URLS: Readonly<Record<string, string>> = {
  CC0: "https://creativecommons.org/publicdomain/zero/1.0/",
  "CC0 1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
  "OGA-BY 3.0": "https://static.opengameart.org/OGA-BY-3.0.txt",
  "CC-BY 3.0": "https://creativecommons.org/licenses/by/3.0/",
  "CC-BY 4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC-BY-SA 3.0": "https://creativecommons.org/licenses/by-sa/3.0/",
  "CC-BY-SA 4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
  "OFL 1.1": "https://openfontlicense.org/open-font-license-official-text/",
};

/** The link to a licence's text; undefined for a name the page does not know. */
export function licenceUrl(name: string): string | undefined {
  return Object.hasOwn(LICENCE_URLS, name) ? LICENCE_URLS[name] : undefined;
}

/** A link the page may show: only http(s), anything else is left as text. */
export function safeLink(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The i18n keys of a pack's name and author: site.credits.pack.<pack>.*, its folder name
 * in snake_case as i18n keys are ("dungeon-crawl" → dungeon_crawl).
 */
export function packKeys(pack: string): { title: string; author: string } {
  const id = pack.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return { title: `site.credits.pack.${id}.title`, author: `site.credits.pack.${id}.author` };
}
