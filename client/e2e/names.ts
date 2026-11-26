// Character names for the E2E suites. The server takes 3 to 16 letters (auth.MaxNameLen =
// CREATURE_NAME_MAX_CHARS; client/vite/e2e-names.test.ts keeps NAME_MAX equal to it), so no
// spec builds a name by hand: a tag one letter too long made eight tests fail with
// invalid_name. No imports here: Playwright and vitest both load this file.

/** The longest character name the server takes. */
export const NAME_MAX = 16;
/** Random letters after the tag: these many when they fit, never fewer than the least. */
const LETTERS = 8;
const LETTERS_MIN = 4;

export function randomLetters(n: number): string {
  const pool = "bcdfghjklmnpqrstvwxz";
  let s = "";
  for (let i = 0; i < n; i++) s += pool[Math.floor(Math.random() * pool.length)];
  return s;
}

/**
 * A fresh, valid character name: the tag (one capitalized word) and a random capitalized
 * word, NAME_MAX characters at most. Throws for a tag that leaves no room for enough
 * random letters, so the mistake shows where the test is written.
 */
export function characterName(tag: string): string {
  if (!/^[A-Z][a-z]+$/.test(tag)) throw new Error(`"${tag}" is not one capitalized word`);
  const n = Math.min(LETTERS, NAME_MAX - tag.length - 1);
  if (n < LETTERS_MIN)
    throw new Error(`"${tag}" is too long a tag: a name takes ${NAME_MAX} characters at most`);
  return `${tag} ${randomLetters(n).replace(/^./, (c) => c.toUpperCase())}`;
}
