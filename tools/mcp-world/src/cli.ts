#!/usr/bin/env node
// Entry point (registered in .mcp.json):
//   node --experimental-strip-types tools/mcp-world/src/cli.ts [--root DIR]
// MCP stdio transport: one JSON-RPC message per line on stdin, responses on stdout.
// Logs go to stderr only (stdout is the protocol).
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { McpServer } from "./server.ts";

const { values } = parseArgs({ options: { root: { type: "string" } } });
const root = resolve(values.root ?? process.env["RPG_ROOT"] ?? ".");
const server = new McpServer({ root });
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
    );
    return;
  }
  const res = Array.isArray(msg)
    ? msg.map((m) => server.handle(m)).filter(Boolean)
    : server.handle(msg);
  if (res !== undefined && !(Array.isArray(res) && res.length === 0))
    process.stdout.write(`${JSON.stringify(res)}\n`);
});
process.stderr.write(`mcp-world: serving ${root}\n`);
