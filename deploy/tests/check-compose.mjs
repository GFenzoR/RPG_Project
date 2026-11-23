// Container hardening of the compose stacks (lote 16), on the output of
// `docker compose config --format json` (deploy/tests/check-hardening.sh writes it).
//
//   node deploy/tests/check-compose.mjs <name> <config.json> [<name> <config.json>...]
import { readFileSync } from "node:fs";

const errors = [];
const err = (stack, svc, msg) => errors.push(`${stack}/${svc}: ${msg}`);

// Services that must run with a read-only root filesystem.
const READ_ONLY = [
  "gameserver",
  "caddy",
  "backup",
  "map-pr-worker",
  "prometheus",
  "alertmanager",
  "node-exporter",
];
// What postgres may keep: the entrypoint chowns its data directory and drops to postgres.
const POSTGRES_CAPS = new Set(["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]);

function sizeMB(s) {
  const m = /^(\d+)([kmg]?)b?$/i.exec(String(s));
  if (!m) return NaN;
  const n = Number(m[1]);
  return { k: n / 1024, m: n, g: n * 1024, "": n / 1048576 }[m[2].toLowerCase()];
}

function check(stack, cfg) {
  const services = cfg.services ?? {};
  for (const [name, s] of Object.entries(services)) {
    const caps = s.cap_drop ?? [];
    if (!caps.includes("ALL")) err(stack, name, "cap_drop: [ALL] missing");
    if (!(s.security_opt ?? []).some((o) => /^no-new-privileges(:true)?$/.test(o)))
      err(stack, name, "security_opt no-new-privileges:true missing");
    if (READ_ONLY.includes(name) && s.read_only !== true)
      err(stack, name, "read_only: true missing");
    const opts = s.logging?.options ?? {};
    if (s.logging?.driver === "json-file" && ["gameserver", "caddy", "postgres"].includes(name)) {
      const total = sizeMB(opts["max-size"]) * Number(opts["max-file"]);
      if (!(total >= 500))
        err(
          stack,
          name,
          `logs keep only ${opts["max-file"]} x ${opts["max-size"]} (want >= 500 MB)`,
        );
    }
  }

  const pg = services.postgres;
  if (pg) {
    for (const c of pg.cap_add ?? [])
      if (!POSTGRES_CAPS.has(c)) err(stack, "postgres", `cap_add ${c} not allowed`);
  }

  const gs = services.gameserver;
  if (gs) {
    if (!gs.mem_limit) err(stack, "gameserver", "mem_limit missing");
    if (!gs.ulimits?.nofile) err(stack, "gameserver", "ulimits.nofile missing");
    const url = gs.environment?.DATABASE_URL ?? "";
    if (!/[?&]pool_max_conns=16(&|$)/.test(url))
      err(stack, "gameserver", "DATABASE_URL lacks pool_max_conns=16");
    if (gs.ports?.length) err(stack, "gameserver", "publishes a port (only Caddy talks to it)");
  }

  const prom = services.prometheus;
  if (prom) {
    const cmd = [].concat(prom.command ?? []).join(" ");
    if (cmd.includes("--web.enable-lifecycle"))
      err(stack, "prometheus", "--web.enable-lifecycle is on");
    const nets = Object.keys(prom.networks ?? {});
    if (nets.includes("edge")) err(stack, "prometheus", "on the shared edge network");
    for (const p of prom.ports ?? [])
      if (p.host_ip !== "127.0.0.1") err(stack, "prometheus", `port published on ${p.host_ip}`);
  }
}

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2) {
  console.error("usage: check-compose.mjs <name> <config.json> [...]");
  process.exit(2);
}
for (let i = 0; i < args.length; i += 2)
  check(args[i], JSON.parse(readFileSync(args[i + 1], "utf8")));
if (errors.length) {
  for (const e of errors) console.error(`check-compose: ${e}`);
  process.exit(1);
}
console.log(`check-compose: ok (${args.length / 2} stack(s))`);
