// psql for the E2E seeds. Uses the host's psql when there is one (Linux, macOS, CI); on a
// machine without it (native Windows with Docker Desktop, docs/12 "Windows nativo") it runs
// psql inside the dev Postgres container of deploy/docker-compose.dev.yml instead.
import { execFileSync } from "node:child_process";
import type {
  ExecFileSyncOptions,
  ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { join } from "node:path";

const composeFile = join(import.meta.dirname, "..", "..", "deploy", "docker-compose.dev.yml");

let hostPsql: boolean | undefined;
function hasHostPsql(): boolean {
  if (hostPsql === undefined) {
    try {
      execFileSync("psql", ["--version"], { stdio: "ignore" });
      hostPsql = true;
    } catch {
      hostPsql = false;
    }
  }
  return hostPsql;
}

/** The URL as seen from inside the container: same user, password and database. */
export function containerUrl(url: string): string {
  const u = new URL(url);
  u.hostname = "127.0.0.1";
  u.port = "5432";
  return u.toString();
}

/** The command that runs psql with `args` (the first one is the database URL). */
export function psqlCommand(args: string[], host: boolean): [string, string[]] {
  if (host) return ["psql", args];
  const [url = "", ...rest] = args;
  const { hostname } = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname))
    throw new Error(`psql is not installed and ${hostname} is not the local dev database`);
  return [
    "docker",
    ["compose", "-f", composeFile, "exec", "-T", "postgres", "psql", containerUrl(url), ...rest],
  ];
}

export function psql(args: string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function psql(args: string[], options?: ExecFileSyncOptions): Buffer;
export function psql(args: string[], options?: ExecFileSyncOptions): string | Buffer {
  const [cmd, cmdArgs] = psqlCommand(args, hasHostPsql());
  return execFileSync(cmd, cmdArgs, options);
}
