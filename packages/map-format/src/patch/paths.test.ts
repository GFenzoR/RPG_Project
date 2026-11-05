// The paths a patch may touch, from a fixture shared with the server's first check of an
// uploaded patch (server/internal/mappatch, T4.5): both sides must agree on every case.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPatchable } from "./patch.ts";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "testdata", "paths.json"), "utf8"),
) as { allowed: string[]; rejected: string[] };

describe("patch paths (shared with the server)", () => {
  it.each(fixture.allowed)("allows %j", (path) => expect(isPatchable(path)).toBe(true));
  it.each(fixture.rejected)("rejects %j", (path) => expect(isPatchable(path)).toBe(false));
});
