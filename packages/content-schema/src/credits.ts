// Which vendor packs assets/CREDITS.md registers, and what counts as their licence file.
// Same rules as tools/spritepack/src/credits.ts (sprites): keep both in step.

/** Pack folder names registered in the CREDITS.md table as `assets/vendor/<pack>`. */
export function registeredPacks(creditsMd: string): Set<string> {
  const packs = new Set<string>();
  for (const line of creditsMd.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    for (const m of line.matchAll(/assets\/vendor\/([A-Za-z0-9._-]+)/g)) {
      const pack = m[1];
      // The empty template row reads `assets/vendor/...`.
      if (pack && !/^\.+$/.test(pack)) packs.add(pack);
    }
  }
  return packs;
}

/** A pack folder must ship its licence text (LICENSE, LICENCE.txt, COPYING...). */
export function isLicenseFile(name: string): boolean {
  return /^(licen[cs]e|copying)/i.test(name);
}
