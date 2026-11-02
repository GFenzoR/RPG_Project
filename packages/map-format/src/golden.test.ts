// Golden files: testdata/golden/<name>.in.* is any valid input, <name>.out.* is the only
// layout the writers may produce. Regenerate with UPDATE_GOLDEN=1 and review the diff.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatChunk, parseChunk } from "./chunk.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { formatYaml, parseYamlText } from "./yaml.ts";

const dir = new URL("../testdata/golden/", import.meta.url);
const update = process.env["UPDATE_GOLDEN"] === "1";
const inputs = readdirSync(dir)
  .filter((f) => /\.in\.(json|yaml)$/.test(f))
  .sort();

function canonical(name: string, text: string): string {
  const diags: Diagnostic[] = [];
  if (name.endsWith(".json")) {
    const chunk = parseChunk(text, name, diags);
    expect(diags).toEqual([]);
    if (!chunk) throw new Error(`${name} did not parse`);
    return formatChunk(chunk);
  }
  const parsed = parseYamlText(text, name, diags);
  expect(diags).toEqual([]);
  if (!parsed) throw new Error(`${name} did not parse`);
  return formatYaml(parsed.data);
}

describe("golden files", () => {
  it("has inputs", () => expect(inputs.length).toBeGreaterThanOrEqual(4));

  for (const input of inputs) {
    const output = input.replace(".in.", ".out.");
    it(`${input} formats to ${output}`, () => {
      const got = canonical(input, readFileSync(new URL(input, dir), "utf8"));
      if (update || !existsSync(new URL(output, dir))) writeFileSync(new URL(output, dir), got);
      expect(got).toBe(readFileSync(new URL(output, dir), "utf8"));
    });
    it(`${output} is a fixed point`, () => {
      const want = readFileSync(new URL(output, dir), "utf8");
      expect(canonical(output, want)).toBe(want);
    });
  }
});
