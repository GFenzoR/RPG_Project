import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDiagnostic, generateIdsLock, validateContent } from "./index.ts";

const REPO = new URL("../../../", import.meta.url).pathname;

describe("ids.lock.yaml", () => {
  let root: string;
  const lockPath = (): string => join(root, "data/ids.lock.yaml");
  const errors = (base?: string): string[] =>
    validateContent(root, base === undefined ? {} : { baseIdsLock: base })
      .diagnostics.filter((d) => d.severity === "error")
      .map(formatDiagnostic);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ids-"));
    cpSync(join(REPO, "data"), join(root, "data"), { recursive: true });
    cpSync(join(REPO, "i18n"), join(root, "i18n"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is up to date in the repository", () => {
    const before = readFileSync(lockPath(), "utf8");
    expect(generateIdsLock(root)).toEqual({ added: [], text: before });
  });

  it("appends new items after the highest number and keeps existing ones", () => {
    const before = readFileSync(lockPath(), "utf8");
    const max = Math.max(...[...before.matchAll(/: (\d+)$/gm)].map((m) => Number(m[1])));
    appendFileSync(
      join(root, "data/items/misc.yaml"),
      "\n- id: anchor\n  kind: decoration\n  sprite: deco/anchor\n  name: item.grass.name\n",
    );
    expect(errors()).toContain(
      'error data/ids.lock.yaml:3:1 items: item "anchor" has no numeric id; run `make gen-ids`',
    );
    const { added, text } = generateIdsLock(root);
    expect(added).toEqual(["anchor"]);
    expect(text.startsWith(before.trimEnd())).toBe(true);
    expect(text).toContain(`  anchor: ${max + 1}\n`);
    expect(errors()).toEqual([]);
  });

  it("never reuses a number, even after the item is deleted", () => {
    writeFileSync(lockPath(), readFileSync(lockPath(), "utf8") + "  old_boat: 900\n");
    const { text } = generateIdsLock(root);
    expect(text).toContain("old_boat: 900");
    appendFileSync(
      join(root, "data/items/misc.yaml"),
      "\n- id: anchor\n  kind: decoration\n  sprite: deco/anchor\n  name: item.grass.name\n",
    );
    expect(generateIdsLock(root).text).toContain("anchor: 901");
    const report = validateContent(root);
    expect(
      report.diagnostics
        .map(formatDiagnostic)
        .some((m) => m.startsWith("warning") && m.includes('"old_boat"')),
    ).toBe(true);
  });

  it("fails when a number changes, is removed or is duplicated against the base revision", () => {
    const base = readFileSync(lockPath(), "utf8");
    writeFileSync(
      lockPath(),
      base.replace("  rope: 12\n", "  rope: 13\n").replace("  wolf_pelt: 9\n", ""),
    );
    const out = errors(base);
    expect(out.some((m) => m.includes("rope: number changed from 12 to 13"))).toBe(true);
    expect(out.some((m) => m.includes('iron_sword: number 13 is already assigned to "rope"'))).toBe(
      true,
    );
    expect(out.some((m) => m.includes('"wolf_pelt" (9) was removed'))).toBe(true);
  });
});
