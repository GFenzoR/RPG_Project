import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_OPS, McpServer } from "./server.ts";
import type { Response } from "./server.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-world-"));
  dirs.push(root);
  for (const d of ["world", "data", "i18n", "assets"])
    cpSync(join(repo, d), join(root, d), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  return root;
}

interface CallResult {
  isError?: boolean;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

function client(root: string) {
  const renderDir = join(root, "..", `${root.split("/").pop() ?? "x"}-renders`);
  dirs.push(renderDir);
  const server = new McpServer({ root, renderDir });
  let id = 0;
  const call = (name: string, args: Record<string, unknown> = {}): CallResult => {
    const res = server.handle({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return res?.result as CallResult;
  };
  const json = (name: string, args: Record<string, unknown> = {}): Record<string, unknown> => {
    const r = call(name, args);
    if (r.isError) throw new Error(r.content[0]?.text);
    return JSON.parse(r.content[0]?.text ?? "null") as Record<string, unknown>;
  };
  return { server, call, json };
}

describe("protocol", () => {
  it("initializes, lists the tools and ignores notifications", () => {
    const { server } = client(repo);
    const init = server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(init?.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "rpg-world" },
    });
    expect(server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    const list = server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as Response;
    const names = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual([
      "map_info",
      "map_view",
      "map_render",
      "map_apply_ops",
      "map_validate",
      "map_find",
      "content_search",
      "map_patch_create",
    ]);
    expect(server.handle({ jsonrpc: "2.0", id: 3, method: "nope" })?.error?.code).toBe(-32601);
    expect(
      server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "x" } })?.error
        ?.code,
    ).toBe(-32602);
  });

  it("speaks MCP over stdio", async () => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "tools/mcp-world/src/cli.ts"],
      {
        cwd: repo,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "map_info", arguments: {} } })}\n`,
    );
    child.stdin.write("not json\n");
    child.stdin.end();
    await new Promise((r) => child.on("close", r));
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Response);
    expect(lines.map((l) => l.id)).toEqual([1, 2, null]);
    expect(lines[2]?.error?.code).toBe(-32700);
    const info = JSON.parse((lines[1]?.result as CallResult).content[0]?.text ?? "") as {
      islands: unknown[];
    };
    expect(info.islands).toHaveLength(1);
  }, 20000);
});

describe("read tools", () => {
  it("map_info, map_view, map_validate, map_find, content_search", () => {
    const { json, call } = client(repo);
    expect(json("map_info", { island: "testisle" })).toMatchObject({
      id: "testisle",
      load_errors: [],
    });
    const view = call("map_view", {
      island: "testisle",
      floor: 7,
      area: { x: 1053, y: 1053, w: 7, h: 7 },
    });
    expect(view.content[0]?.text).toContain("@");
    expect(
      call("map_view", { island: "testisle", floor: 7, area: { x: 0, y: 0, w: 65, h: 1 } }).isError,
    ).toBe(true);
    expect(json("map_validate", { island: "testisle" })).toMatchObject({ errors: 0 });
    expect(json("map_find", { kind: "npc", id: "harbor_master" })).toMatchObject({
      total: 1,
      results: [{ island: "testisle", npc: "harbor_master" }],
    });
    expect(json("map_find", { kind: "item", id: "fishing_rod" })).toMatchObject({
      total: 1,
      results: [{ pos: { x: 1057, y: 1084, z: 7 }, layer: "stack" }],
    });
    expect(json("map_find", { kind: "spawn", id: "wolf" }).total).toBe(1);
    expect(
      json("map_find", {
        kind: "item",
        id: "stone_floor",
        area: { x: 1053, y: 1053, w: 7, h: 7 },
        floor: 7,
      }).total,
    ).toBe(49);
    const crab = json("content_search", { text: "cangrejo", kind: "monster" });
    expect(crab).toMatchObject({
      results: [{ kind: "monster", id: "tide_crab", names: { es: "cangrejo de marea" } }],
    });
    const grounds = json("content_search", { kind: "item", item_kind: "ground", limit: 200 }) as {
      results: { id: string; walkable: boolean }[];
    };
    expect(grounds.results.find((g) => g.id === "water_shallow")?.walkable).toBe(false);
  });

  it("map_render returns a PNG image and its path", () => {
    const { call } = client(sandbox());
    const r = call("map_render", {
      island: "testisle",
      floor: 7,
      area: { x: 1050, y: 1050, w: 12, h: 12 },
    });
    expect(r.isError).toBeUndefined();
    const info = JSON.parse(r.content[0]?.text ?? "") as { path: string; tile: number };
    expect(info.tile).toBe(32);
    expect(existsSync(info.path)).toBe(true);
    const img = r.content[1];
    expect(img?.mimeType).toBe("image/png");
    expect(
      Buffer.from(img?.data ?? "", "base64")
        .subarray(1, 4)
        .toString(),
    ).toBe("PNG");
    expect(call("map_render", { island: "testisle", floor: 7, tile: 12 }).isError).toBe(true);
  });
});

describe("map_apply_ops", () => {
  it("applies atomically, writes only world/, and reports validation", () => {
    const root = sandbox();
    const { json, call } = client(root);
    const chunk = "world/islands/testisle/chunks/z07/c0032_0032.json";
    const before = readFileSync(join(root, chunk), "utf8");
    const bad = call("map_apply_ops", {
      ops: [
        { op: "paint_ground", floor: 7, rect: { x: 1045, y: 1045, w: 2, h: 2 }, item: "sand" },
        { op: "place_npc", npc: "ghost", pos: { x: 1045, y: 1045, z: 7 } },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain("unknown NPC");
    expect(readFileSync(join(root, chunk), "utf8")).toBe(before);

    const ok = json("map_apply_ops", {
      island: "testisle",
      ops: [
        { op: "paint_ground", floor: 7, rect: { x: 1045, y: 1045, w: 2, h: 2 }, item: "sand" },
        { op: "autoborder", floor: 7, rect: { x: 1044, y: 1044, w: 4, h: 4 } },
        {
          op: "add_spawn",
          id: "testisle_boars",
          center: { x: 1040, y: 1066, z: 7 },
          radius: 2,
          monsters: [{ monster: "bristleback_boar", count: 1 }],
          respawn_seconds: 90,
        },
      ],
    });
    expect(ok).toMatchObject({
      ok: true,
      written: [chunk, "world/islands/testisle/spawns.yaml"],
      validation: { errors: 0 },
    });
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
    ).not.toMatch(/data\//);
  });

  it("enforces the op limit and the island scope", () => {
    const { call } = client(sandbox());
    const many = Array.from({ length: MAX_OPS + 1 }, () => ({
      op: "fill",
      pos: { x: 1040, y: 1040, z: 7 },
      item: "sand",
    }));
    expect(call("map_apply_ops", { ops: many }).content[0]?.text).toContain(
      `at most ${MAX_OPS} ops`,
    );
    const other = call("map_apply_ops", {
      island: "otherisle",
      ops: [{ op: "paint_ground", floor: 7, rect: { x: 1045, y: 1045, w: 1, h: 1 }, item: "sand" }],
    });
    expect(other.isError).toBe(true);
    expect(call("map_apply_ops", { ops: [{ nope: 1 }] }).isError).toBe(true);
  });
});

describe("map_patch_create", () => {
  it("packs the changes into world/patches and rejects unsafe names", () => {
    const root = sandbox();
    const { json, call } = client(root);
    json("map_apply_ops", { ops: [{ op: "remove_zone", id: "testisle_dock" }] });
    const r = json("map_patch_create", { name: "drop-dock" });
    expect(r).toMatchObject({
      path: "world/patches/drop-dock.rpgpatch.json",
      files: [{ path: "world/islands/testisle/zones.yaml", change: "modified" }],
    });
    expect(existsSync(join(root, "world/patches/drop-dock.rpgpatch.json"))).toBe(true);
    expect(call("map_patch_create", { name: "../../data/x" }).isError).toBe(true);
    expect(call("map_patch_create", { name: "x", against: "--output=/tmp/x" }).isError).toBe(true);
  });
});
