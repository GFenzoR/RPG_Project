// Vite plugin: the editor's local backend. The browser does all the editing (ops run
// client-side); this only reads and writes files and runs the shared validator, because
// world/, data/ and the validator live on disk and in Node.
//
//   GET  /api/bootstrap      world + palette items + texts
//   POST /api/validate       body: WireWorld → ValidateResult (what `mapcli validate` would say)
//   POST /api/save           body: WireWorld → SaveResult (canonical files, as `mapcli fmt`)
//   GET  /atlas/<file>       sprite atlas built from assets/ with tools/spritepack
//
// The repository root defaults to the parent of editor/; EDITOR_ROOT overrides it (E2E
// tests point it at a scratch copy so they never touch the real world/).
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContent } from "@rpg/map-format";
import { buildAtlas, writeAtlas } from "@rpg/spritepack";
import type { Plugin } from "vite";
import { fromWire } from "../src/io/wire.ts";
import type { WireWorld } from "../src/io/wire.ts";
import { SaveRefused, bootstrap, saveWorld, validateInMemory } from "./store.ts";

export function editorRoot(): string {
  return resolve(process.env["EDITOR_ROOT"] ?? fileURLToPath(new URL("../..", import.meta.url)));
}

async function body(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
}

function buildAtlasDir(root: string): string {
  const out = mkdtempSync(join(tmpdir(), "rpg-editor-atlas-"));
  const result = buildAtlas(root);
  for (const d of result.diagnostics)
    if (d.severity === "error") console.error(`[editor] atlas: ${d.where}: ${d.message}`);
  if (!result.atlas) throw new Error("the sprite atlas has errors; run `make sprites` to see them");
  writeAtlas(result.atlas, out);
  return out;
}

export function editorApi(): Plugin {
  const root = editorRoot();
  let atlasDir: string | undefined;
  return {
    name: "rpg-editor-api",
    configureServer(server) {
      console.log(`[editor] repository root: ${root}`);
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://editor");
        const handle = async (): Promise<void> => {
          if (req.method === "GET" && url.pathname === "/api/bootstrap") {
            send(res, 200, bootstrap(root));
          } else if (req.method === "POST" && url.pathname === "/api/validate") {
            const world = fromWire((await body(req)) as WireWorld);
            send(res, 200, validateInMemory(world, loadContent(root)));
          } else if (req.method === "POST" && url.pathname === "/api/save") {
            const world = fromWire((await body(req)) as WireWorld);
            try {
              send(res, 200, saveWorld(root, world));
            } catch (e) {
              if (!(e instanceof SaveRefused)) throw e;
              send(res, 409, { error: e.message });
            }
          } else if (req.method === "GET" && url.pathname.startsWith("/atlas/")) {
            atlasDir ??= buildAtlasDir(root);
            const name = url.pathname.slice("/atlas/".length);
            const file = join(atlasDir, name);
            if (!/^atlas(-\d+)?\.(png|json)$/.test(name) || !existsSync(file)) {
              res.statusCode = 404;
              res.end();
              return;
            }
            res.setHeader("content-type", name.endsWith(".png") ? "image/png" : "application/json");
            res.end(readFileSync(file));
          } else {
            next();
          }
        };
        handle().catch((e: unknown) => {
          console.error("[editor]", e);
          send(res, 500, { error: e instanceof Error ? e.message : String(e) });
        });
      });
    },
  };
}
