// Go↔TS compatibility. The fixtures in proto/testdata/golden are shared with the Go test
// in server/internal/net: <name>.json is the canonical proto3 JSON of a message,
// <name>.ts.bin is this package's encoding of it and <name>.go.bin Go's. We check that
// our encoding is stable and that both binaries decode back to the fixture.
//
// Regenerate the .ts.bin files after changing a fixture:
//   UPDATE_GOLDEN=1 pnpm --filter @rpg/protocol test
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import type { DescMessage, JsonValue } from "@bufbuild/protobuf";
import { ClientMessageSchema, ServerBatchSchema } from "./index.ts";

const goldenDir = join(import.meta.dirname, "../../../proto/testdata/golden");
const update = process.env["UPDATE_GOLDEN"] === "1";
const fixtures = readdirSync(goldenDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length));

function schemaFor(name: string): DescMessage {
  if (name.startsWith("client_")) return ClientMessageSchema;
  if (name.startsWith("server_")) return ServerBatchSchema;
  throw new Error(`fixture ${name}: name must start with client_ or server_`);
}

describe("golden fixtures shared with Go", () => {
  it("finds fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)("%s round-trips", (name) => {
    const schema = schemaFor(name);
    const base = join(goldenDir, name);
    const json = JSON.parse(readFileSync(`${base}.json`, "utf8")) as JsonValue;

    // JSON fixture -> binary must equal our golden bytes.
    const encoded = toBinary(schema, fromJson(schema, json));
    if (update) writeFileSync(`${base}.ts.bin`, encoded);
    expect(encoded).toEqual(new Uint8Array(readFileSync(`${base}.ts.bin`)));

    // Our bytes and Go's bytes -> JSON must be the fixture.
    for (const suffix of [".ts.bin", ".go.bin"]) {
      const decoded = fromBinary(schema, new Uint8Array(readFileSync(base + suffix)), {
        readUnknownFields: true,
      });
      expect(toJson(schema, decoded), `${name}${suffix}`).toEqual(json);
      expect(decoded.$unknown, `${name}${suffix} has unknown fields`).toBeUndefined();
    }
  });
});
