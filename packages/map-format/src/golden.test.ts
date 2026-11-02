// Golden files: testdata/golden/<name>.in.* is any valid input, <name>.out.* is the only
// layout the writers may produce. Regenerate with UPDATE_GOLDEN=1 and review the diff.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** The committed golden text; written only when updating, a missing file is a failure. */
function expectedGolden(file: URL, got: string, updating: boolean): string {
  if (updating) writeFileSync(file, got);
  if (!existsSync(file))
    throw new Error(`missing ${file.pathname}; run with UPDATE_GOLDEN=1 and review it`);
  return readFileSync(file, "utf8");
}

describe("golden helper", () => {
  it("fails on a missing output instead of creating it", () => {
    const missing = new URL(`file://${tmpdir()}/map-format-golden-${process.pid}.out.json`);
    expect(() => expectedGolden(missing, "x", false)).toThrow(/missing .*UPDATE_GOLDEN=1/);
    expect(existsSync(missing)).toBe(false);
  });
});

describe("golden files", () => {
  it("has inputs", () => expect(inputs.length).toBeGreaterThanOrEqual(4));

  for (const input of inputs) {
    const output = input.replace(".in.", ".out.");
    it(`${input} formats to ${output}`, () => {
      const got = canonical(input, readFileSync(new URL(input, dir), "utf8"));
      expect(got).toBe(expectedGolden(new URL(output, dir), got, update));
    });
    it(`${output} is a fixed point`, () => {
      const want = readFileSync(new URL(output, dir), "utf8");
      expect(canonical(output, want)).toBe(want);
    });
  }
});

describe("docs/03-world-and-maps.md", () => {
  const doc = readFileSync(new URL("../../../docs/03-world-and-maps.md", import.meta.url), "utf8");
  const blocks = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

  it("has YAML examples", () => expect(blocks.length).toBeGreaterThanOrEqual(7));

  it("shows every YAML example in canonical form", () => {
    for (const block of blocks) expect(canonical("docs.yaml", block)).toBe(block);
  });
});

describe("docs/03-world-and-maps.md chunk example", () => {
  const doc = readFileSync(new URL("../../../docs/03-world-and-maps.md", import.meta.url), "utf8");
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

  it("is what the canonical writer produces (with rows 3–31 elided)", () => {
    expect(blocks).toHaveLength(1);
    const shown = blocks[0] ?? "";
    // The example elides identical rows with "    ..."; restore them to get a full chunk.
    const lines = shown.split("\n");
    const at = lines.indexOf("    ...");
    expect(at).toBeGreaterThan(0);
    const row = lines[at + 1] ?? "";
    const full = [
      ...lines.slice(0, at),
      ...Array<string>(29).fill(`${row},`),
      ...lines.slice(at + 1),
    ].join("\n");
    expect(canonical("docs.json", full)).toBe(full);
  });
});
