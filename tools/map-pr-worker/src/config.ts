// Configuration of the map PR worker from the environment (documented in cli.ts and docs/09).
import { parseRepository } from "./github.ts";

export interface Config {
  databaseUrl: string;
  token: string;
  owner: string;
  repo: string;
  base: string;
  apiUrl: string;
  pollMs: number;
}

/** The configuration, `disabled` without a token, or the first problem found. */
export function readConfig(env: NodeJS.ProcessEnv): Config | "disabled" | { error: string } {
  const token = env["GITHUB_MAP_PR_TOKEN"] ?? "";
  if (token === "") return "disabled";
  if (/\s/.test(token)) return { error: "GITHUB_MAP_PR_TOKEN has whitespace" };
  const repo = parseRepository(env["GITHUB_REPOSITORY"] ?? "");
  if (!repo) return { error: "GITHUB_REPOSITORY must be owner/repo" };
  const databaseUrl = env["DATABASE_URL"] ?? "";
  if (databaseUrl === "") return { error: "DATABASE_URL is not set" };
  const base = env["MAP_PR_BASE"] || "main";
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(base) || base.startsWith("-") || base.includes(".."))
    return { error: "MAP_PR_BASE is not a branch name" };
  const apiUrl = env["GITHUB_API_URL"] || "https://api.github.com";
  let u: URL;
  try {
    u = new URL(apiUrl);
  } catch {
    return { error: "GITHUB_API_URL is not a URL" };
  }
  // The token goes to this host: plain http only for a local fake.
  if (
    u.protocol !== "https:" &&
    !(u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
  )
    return { error: "GITHUB_API_URL must be https (http only for localhost)" };
  const poll = Number(env["MAP_PR_POLL_SECONDS"] || "30");
  if (!Number.isFinite(poll) || poll < 1 || poll > 3600)
    return { error: "MAP_PR_POLL_SECONDS must be 1–3600" };
  return { databaseUrl, token, ...repo, base, apiUrl, pollMs: poll * 1000 };
}
