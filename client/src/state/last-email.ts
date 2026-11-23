// The login form remembers only the email of the last successful login (lote 17: the game
// never keeps the login, so every start asks for the password). Never the token, never
// the password: the web session lives in an HttpOnly cookie the page cannot read, and the
// desktop app keeps its token in Rust memory for the run.

const EMAIL_KEY = "rpg.lastEmail";
const MAX_EMAIL = 254;

/** The remembered email, or "" when unset, unreadable or not an email-like value. */
export function loadLastEmail(storage: Pick<Storage, "getItem"> | undefined): string {
  try {
    const v = storage?.getItem(EMAIL_KEY) ?? "";
    return v.length <= MAX_EMAIL && /^[^\s@]+@[^\s@]+$/.test(v) ? v : "";
  } catch {
    return "";
  }
}

/** Remembers the email of a successful login (trimmed); an empty one forgets it. */
export function saveLastEmail(email: string, storage: Storage | undefined): void {
  const v = email.trim();
  try {
    if (v === "" || v.length > MAX_EMAIL) storage?.removeItem(EMAIL_KEY);
    else storage?.setItem(EMAIL_KEY, v);
  } catch {
    // Private mode or full storage: the form just starts empty next time.
  }
}
