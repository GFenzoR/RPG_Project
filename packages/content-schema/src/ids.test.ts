import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDiagnostic, generateIdsLock, validateContent } from "./index.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

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
    expect(generateIdsLock(root)).toEqual({ added: [], chests: [], text: before });
  });

  it("appends new items after the highest number and keeps existing ones", () => {
    const before = readFileSync(lockPath(), "utf8");
    const max = Math.max(...[...before.matchAll(/: (\d+)$/gm)].map((m) => Number(m[1])));
    appendFileSync(
      join(root, "data/items/misc.yaml"),
      "\n- id: anchor\n  kind: decoration\n  sprite: deco/anchor\n  name: item.grass.name\n",
    );
    expect(errors()).toEqual([
      expect.stringMatching(
        /^error data\/ids\.lock\.yaml:\d+:1 items: item "anchor" has no numeric id; run `make gen-ids`$/,
      ),
    ]);
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

  it('locks every reward chest id with its item (docs/02 "Libros y cofres")', () => {
    const before = readFileSync(lockPath(), "utf8");
    expect(before).toContain("\nchests:\n  puerto_mine: chest_puerto_mine\n");
    writeFileSync(lockPath(), before.replace(/^# Reward chests.*\n#.*\nchests:\n( {2}.*\n)*/m, ""));
    expect(errors()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /chests: chest "puerto_mine" \(item "chest_puerto_mine"\) is not locked; run `make gen-ids`/,
        ),
      ]),
    );
    const { added, chests, text } = generateIdsLock(root);
    expect(added).toEqual([]);
    expect(chests).toEqual([
      "puerto_mine",
      "puerto_grove",
      "bosque_cave",
      "volcan_mine",
      "pruebas",
    ]);
    expect(text).toBe(before);
    expect(errors()).toEqual([]);
  });

  it("refuses a renamed or reused chest id: it is the storage key of whoever opened it", () => {
    const items = join(root, "data/items/exploration.yaml");
    const yaml = readFileSync(items, "utf8");
    writeFileSync(items, yaml.replace("id: puerto_grove\n", "id: north_grove\n"));
    expect(errors()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /chests\.puerto_grove: item "chest_puerto_grove" has chest id "north_grove" now: never rename a chest id/,
        ),
        expect.stringMatching(/chest "north_grove" \(item "chest_puerto_grove"\) is not locked/),
      ]),
    );
    // make gen-ids does not lock the rename: it stays an error until the id is back.
    expect(generateIdsLock(root).chests).toEqual([]);
    writeFileSync(
      items,
      yaml
        .replace("id: puerto_grove\n", "id: north_grove\n")
        .replace("id: pruebas\n", "id: puerto_grove\n"),
    );
    expect(errors()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /chests\.puerto_grove: chest id "puerto_grove" belongs to item "chest_puerto_grove", not "chest_pruebas": .*never reuse one/,
        ),
      ]),
    );
    expect(generateIdsLock(root).chests).toEqual([]);
  });

  it("fails when a chest is removed from the lock or changes its item against the base revision", () => {
    const base = readFileSync(lockPath(), "utf8");
    writeFileSync(
      lockPath(),
      base
        .replace("  puerto_mine: chest_puerto_mine\n", "  puerto_mine: chest_volcan_mine\n")
        .replace("  pruebas: chest_pruebas\n", ""),
    );
    const out = errors(base);
    expect(out).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /chests\.puerto_mine: item changed from "chest_puerto_mine" to "chest_volcan_mine"; ids\.lock\.yaml is append-only/,
        ),
        expect.stringMatching(/chest "pruebas" \("chest_pruebas"\) was removed/),
      ]),
    );
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
