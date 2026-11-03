// Desktop smoke test (T2.5, Linux only): drives the real Tauri app through tauri-driver +
// WebKitWebDriver (W3C WebDriver over plain HTTP), against a game server that is already
// running. Logs in, picks the character, enters the world and saves screenshots; it also
// checks that the account token never reaches the page and that the CSP blocks other hosts.
//
//   make desktop-smoke   (builds the app, starts a server on :18090 and runs this)
//
// Env: DESKTOP_BIN (app binary), SERVER (game server, the app gets it as RPG_SERVER_URL),
// DRIVER (tauri-driver URL, default http://127.0.0.1:4444).
import { mkdirSync, writeFileSync } from "node:fs";

const bin = process.env["DESKTOP_BIN"] ?? "apps/desktop/src-tauri/target/debug/rpg-desktop";
const server = process.env["SERVER"] ?? "http://127.0.0.1:18090";
const driver = process.env["DRIVER"] ?? "http://127.0.0.1:4444";
const shots = new URL("./screenshots/", import.meta.url);

type Json = Record<string, unknown>;

async function wd(method: string, path: string, body?: Json): Promise<unknown> {
  const res = await fetch(`${driver}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json()) as { value: unknown };
  if (!res.ok) throw new Error(`webdriver ${method} ${path}: ${JSON.stringify(data.value)}`);
  return data.value;
}

async function api(path: string, body: Json, token?: string): Promise<Json> {
  const res = await fetch(`${server}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  if (res.status >= 300) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as Json;
}

const letters = (n: number): string =>
  Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(
    "",
  );

async function main(): Promise<void> {
  // Account and character through the HTTP API, like the client E2E.
  const email = `desktop-${Date.now()}-${letters(5)}@example.com`;
  const password = "desktop-password-1";
  const name = `Desk ${letters(8).replace(/^./, (c) => c.toUpperCase())}`;
  await api("/api/auth/register", { email, password });
  const { token } = (await api("/api/auth/login", { email, password, token_in_body: true })) as {
    token: string;
  };
  await api("/api/characters", { name, vocation: "guardian" }, token);

  const session = (await wd("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application: bin } } },
  })) as { sessionId: string };
  const s = `/session/${session.sessionId}`;
  const run = async <T>(script: string, ...args: unknown[]): Promise<T> =>
    (await wd("POST", `${s}/execute/sync`, { script, args })) as T;
  const runAsync = async <T>(script: string, ...args: unknown[]): Promise<T> =>
    (await wd("POST", `${s}/execute/async`, { script, args })) as T;
  const waitFor = async (css: string, timeoutMs = 20_000): Promise<void> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await run<boolean>("return document.querySelector(arguments[0]) !== null", css)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting for ${css}`);
  };
  const find = async (css: string): Promise<string> => {
    const el = (await wd("POST", `${s}/element`, { using: "css selector", value: css })) as Json;
    // W3C key, or the legacy one some drivers still use.
    return (el["element-6066-11e4-a52f-4a6c5bcd8b5e"] ?? Object.values(el)[0]) as string;
  };
  const shot = async (file: string): Promise<void> => {
    const png = (await wd("GET", `${s}/screenshot`)) as string;
    mkdirSync(shots, { recursive: true });
    writeFileSync(new URL(file, shots), Buffer.from(png, "base64"));
    console.log(`screenshot ${file}`);
  };

  try {
    await waitFor("[data-testid=login-form]");
    console.log("page:", await run<string>("return location.href"));
    await wd("POST", `${s}/element/${await find("input[type=email]")}/value`, { text: email });
    await wd("POST", `${s}/element/${await find("input[type=password]")}/value`, {
      text: password,
    });
    await shot("01-login.png");
    await wd(
      "POST",
      `${s}/element/${await find("[data-testid=login-form] button[type=submit]")}/click`,
      {},
    );

    await waitFor("[data-testid=characters] li");
    await shot("02-characters.png");
    // The token stays in Rust: a login through the app's command never returns it, and
    // there is no cookie on the page.
    const leaked = await runAsync<string>(
      `const done = arguments[arguments.length - 1];
       window.__TAURI_INTERNALS__.invoke("api", { method: "POST", path: "/api/auth/login",
         body: { email: arguments[0], password: arguments[1] } })
         .then((r) => done(JSON.stringify({ status: r.status, keys: Object.keys(r.body || {}), cookie: document.cookie })),
               (e) => done("error " + e));`,
      email,
      password,
    );
    console.log("login through the app:", leaked);
    if (
      !leaked.includes('"status":200') ||
      leaked.includes("token") ||
      !leaked.includes('"cookie":""')
    )
      throw new Error(`token or cookie visible to the page: ${leaked}`);
    // The CSP only lets the page connect to its configured server.
    const csp = await runAsync<string>(
      `const done = arguments[arguments.length - 1];
       document.addEventListener("securitypolicyviolation", (e) => done("blocked " + e.violatedDirective), { once: true });
       try { new WebSocket("wss://evil.example.com/ws"); } catch (e) { done("blocked (throw) " + e.name); }
       setTimeout(() => done("not blocked"), 3000);`,
    );
    console.log("websocket to another host:", csp);
    if (!csp.startsWith("blocked")) throw new Error("CSP did not block another host");

    await run(
      `[...document.querySelectorAll("[data-testid=characters] button")]
         .find((b) => /^(Jugar|Play)$/.test(b.textContent.trim())).click();`,
    );
    await waitFor("[data-testid=game] canvas", 30_000);
    await waitFor("[data-testid=health]");
    await new Promise((r) => setTimeout(r, 2000)); // let the first frames draw
    await shot("03-world.png");
    console.log(
      "health:",
      await run<string>(`return document.querySelector("[data-testid=health]").textContent`),
    );
    console.log("desktop smoke: OK");
  } catch (e) {
    await shot("failure.png").catch(() => undefined);
    const html = await run<string>(
      "return location.href + '\\n' + document.documentElement.outerHTML",
    ).catch((err: unknown) => String(err));
    console.error(html.slice(0, 2000));
    throw e;
  } finally {
    await wd("DELETE", s).catch(() => undefined);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
