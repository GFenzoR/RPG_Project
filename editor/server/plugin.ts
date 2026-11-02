// Vite plugin: the editor's local backend. The browser does all the editing (ops run
// client-side); this only reads and writes files and runs the shared validator, because
// world/, data/ and the validator live on disk and in Node.
//
//   GET  /api/bootstrap      world + palette items + texts + base hashes of the chunk files
//   POST /api/validate       body: WireWorld → ValidateResult (the shared validator, in memory)
//   POST /api/save           body: SaveRequest → SaveResult, 409 SaveConflictBody, 400 if
//                            invalid, 500 { error, partial?: SaveResult } if it failed
//   GET  /atlas/<file>       sprite atlas built from assets/ with tools/spritepack
// Every /api call must pass refuseRequest (same-origin only, see guard.ts).
//
// The repository root defaults to the parent of editor/; EDITOR_ROOT overrides it (E2E
// tests point it at a scratch copy so they never touch the real world/).
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContent } from "@rpg/map-format";
import { buildAtlas, writeAtlas } from "@rpg/spritepack";
import type { Plugin } from "vite";
import { fromWire } from "../src/io/wire.ts";
import type { SaveRequest, WireWorld } from "../src/io/wire.ts";
import { refuseRequest } from "./guard.ts";
import {
  BadRequest,
  PartialSave,
  SaveConflict,
  bootstrap,
  saveChanges,
  validateInMemory,
} from "./store.ts";

export function editorRoot(): string {
  return resolve(process.env["EDITOR_ROOT"] ?? fileURLToPath(new URL("../..", import.meta.url)));
}

/** Largest request body accepted (a 512x512 island with 3 floors is ~5 MB of JSON). */
const MAX_BODY = 64 * 1024 * 1024;

async function body(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest("request body too large");
    parts.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } catch {
    throw new BadRequest("body is not JSON");
  }
}

function worldOf(data: unknown): ReturnType<typeof fromWire> {
  const w = data as Partial<WireWorld> | null;
  if (!w || typeof w !== "object" || !Array.isArray(w.islands) || typeof w.meta !== "object")
    throw new BadRequest("expected a world");
  try {
    return fromWire(w as WireWorld);
  } catch {
    throw new BadRequest("malformed world");
  }
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
          if (url.pathname.startsWith("/api/")) {
            const refused = refuseRequest(req.method ?? "GET", req.headers);
            if (refused) {
              console.warn(`[editor] refused ${req.method} ${url.pathname}: ${refused}`);
              send(res, 403, { error: refused });
              return;
            }
          }
          if (req.method === "GET" && url.pathname === "/api/bootstrap") {
            send(res, 200, bootstrap(root));
          } else if (req.method === "POST" && url.pathname === "/api/validate") {
            const world = worldOf(await body(req));
            send(res, 200, validateInMemory(root, world, loadContent(root)));
          } else if (req.method === "POST" && url.pathname === "/api/save") {
            const data = (await body(req)) as Partial<SaveRequest> | null;
            const world = worldOf(data?.world);
            send(res, 200, saveChanges(root, world, data?.changes as SaveRequest["changes"]));
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
          if (e instanceof SaveConflict) {
            send(res, 409, { error: e.message, conflicts: e.conflicts });
            return;
          }
          if (e instanceof PartialSave) {
            console.error("[editor]", e);
            send(res, 500, { error: e.message, partial: e.result });
            return;
          }
          if (e instanceof BadRequest) {
            console.warn(`[editor] bad request ${req.method} ${url.pathname}: ${e.message}`);
            send(res, 400, { error: e.message });
            return;
          }
          console.error("[editor]", e);
          send(res, 500, { error: e instanceof Error ? e.message : String(e) });
        });
      });
    },
  };
}
