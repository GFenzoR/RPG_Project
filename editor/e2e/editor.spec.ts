// Opens the editor, edits testisle with every hito 1 tool, checks undo/redo, live
// validation and floors, saves, and verifies the saved files are canonical (`mapcli fmt
// --check` finds nothing to change). Screenshots: e2e/screenshots/actual/.
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const repo = resolve(import.meta.dirname, "../..");
const root = process.env["EDITOR_E2E_ROOT"] ?? "";
const shots = join(import.meta.dirname, "screenshots", "actual");

type Tile = { ground: string | null; stack: string[] } | undefined;

const tile = (page: Page, x: number, y: number, z: number): Promise<Tile> =>
  page.evaluate(([x, y, z]) => window.__rpgEditor?.tile(x, y, z), [x, y, z] as const);

async function clientOf(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(([x, y]) => window.__rpgEditor?.tileToClient(x, y), [
    x,
    y,
  ] as const);
  if (!p) throw new Error("editor hooks missing");
  return p;
}

async function clickTile(
  page: Page,
  x: number,
  y: number,
  button: "left" | "right" = "left",
): Promise<void> {
  const p = await clientOf(page, x, y);
  await page.mouse.click(p.x, p.y, { button });
}

async function dragTiles(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const a = await clientOf(page, ...from);
  const b = await clientOf(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

async function pick(page: Page, query: string, id: string): Promise<void> {
  await page.getByTestId("palette-search").fill(query);
  await page.getByTestId(`palette-${id}`).click();
}

async function settled(page: Page): Promise<void> {
  // Live validation is debounced; wait until a run started after the last edit finished.
  await page.waitForTimeout(400);
  await expect.poll(() => page.evaluate(() => window.__rpgEditor?.state().validating)).toBe(false);
}

const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: join(shots, `${name}.png`) });

test("edit, undo, validate and save testisle", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/?lang=es&island=testisle");
  await expect.poll(() => page.evaluate(() => window.__rpgEditor?.ready === true)).toBe(true);
  await expect(page.getByTestId("validation-summary")).toHaveText("Sin errores ni advertencias");
  await expect(page.getByTestId("island")).toHaveValue("testisle");
  await expect(page.getByTestId("island").locator("option")).toHaveText([
    "Isla del Puerto (puerto)",
    "Isla de pruebas (testisle)",
  ]);
  await expect(page.getByTestId("floor")).toHaveText("Piso 7");
  await shot(page, "01-open");

  // Brush: search the palette by translated name, 3x3 stroke.
  await pick(page, "arena", "sand");
  await expect(page.getByTestId("tool-brush")).toHaveClass(/active/);
  await page.getByTestId("brush-size").selectOption("3");
  await dragTiles(page, [1046, 1062], [1052, 1062]);
  for (const x of [1045, 1049, 1053]) expect((await tile(page, x, 1063, 7))?.ground).toBe("sand");
  await expect(page.getByTestId("dirty")).toHaveText("Cambios sin guardar");

  // Item tool: place two items, remove the top one with right-click.
  await page.getByTestId("category-decoration").click();
  await page.getByTestId("palette-search").fill("");
  await page.getByTestId("palette-cargo_crate").click();
  await expect(page.getByTestId("tool-item")).toHaveClass(/active/);
  await clickTile(page, 1050, 1050);
  await page.getByTestId("palette-mooring_post").click();
  await clickTile(page, 1050, 1050);
  expect((await tile(page, 1050, 1050, 7))?.stack).toEqual(["cargo_crate", "mooring_post"]);
  await clickTile(page, 1050, 1050, "right");
  expect((await tile(page, 1050, 1050, 7))?.stack).toEqual(["cargo_crate"]);
  await page.getByTestId("palette-mooring_post").click();
  await clickTile(page, 1052, 1050);
  await settled(page);
  await shot(page, "02-painted");

  // Undo / redo: keyboard and buttons, one entry per stroke or click.
  await page.keyboard.press("Control+z");
  expect((await tile(page, 1052, 1050, 7))?.stack).toEqual([]);
  await page.keyboard.press("Control+z");
  expect((await tile(page, 1050, 1050, 7))?.stack).toEqual(["cargo_crate", "mooring_post"]);
  await page.getByTestId("redo").click();
  await page.keyboard.press("Control+y");
  expect((await tile(page, 1052, 1050, 7))?.stack).toEqual(["mooring_post"]);
  await expect(page.getByTestId("status")).toContainText("Rehecho: colocar item");

  // Live validation: flood the temple tile, the panel reports it, clicking jumps there.
  await page.getByTestId("category-all").click();
  await pick(page, "agua", "water_shallow");
  await page.getByTestId("brush-size").selectOption("1");
  await clickTile(page, 1056, 1056);
  await settled(page);
  await expect(page.getByTestId("validation-summary")).toContainText("error");
  const diag = page
    .getByTestId("diagnostic")
    .filter({ hasText: "temple is not on a walkable tile" });
  await expect(diag).toHaveCount(1);
  await page.mouse.wheel(0, 600); // zoom out, then let the diagnostic bring the temple back
  await diag.click();
  const temple = await clientOf(page, 1056, 1056);
  const box = await page.getByTestId("map-canvas").boundingBox();
  expect(Math.abs(temple.x - ((box?.x ?? 0) + (box?.width ?? 0) / 2))).toBeLessThan(40);
  await shot(page, "03-validation-error");
  await page.keyboard.press("Control+z");
  await settled(page);
  await expect(page.getByTestId("validation-summary")).toHaveText("Sin errores ni advertencias");

  // Shortcuts still work with a select or checkbox focused, and Space does not toggle it.
  await page.getByTestId("brush-size").focus();
  await page.keyboard.press("b");
  await expect(page.getByTestId("tool-brush")).toHaveClass(/active/);
  const grid = page.getByTestId("grid");
  await grid.focus();
  await page.keyboard.press(" ");
  await expect(grid).toBeChecked();

  // Eraser (all layers) on the second item tile.
  await page.keyboard.press("e");
  await expect(page.getByTestId("tool-eraser")).toHaveClass(/active/);
  await clickTile(page, 1052, 1050);
  expect(await tile(page, 1052, 1050, 7)).toEqual({ ground: null, stack: [] });
  await settled(page);

  // Floors: PgDn shows the cave on floor 8, PgUp comes back.
  await page.keyboard.press("PageDown");
  await expect(page.getByTestId("floor")).toHaveText("Piso 8");
  await page.waitForTimeout(100);
  await shot(page, "04-floor-8");
  await page.keyboard.press("PageUp");
  await expect(page.getByTestId("floor")).toHaveText("Piso 7");

  // Zoom with the wheel.
  const before = await page.evaluate(() => window.__rpgEditor?.state().zoom ?? 0);
  const centre = await clientOf(page, 1056, 1056);
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.wheel(0, -400);
  await expect
    .poll(() => page.evaluate(() => window.__rpgEditor?.state().zoom ?? 0))
    .toBeGreaterThan(before);
  await page.waitForTimeout(100);
  await shot(page, "05-zoomed");

  // Save: canonical files, exactly what `mapcli fmt` writes.
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("status")).toContainText("Guardado:");
  await expect(page.getByTestId("dirty")).toHaveText("Sin cambios");
  const fmt = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(repo, "tools/mapcli/src/cli.ts"),
      "fmt",
      "--check",
      "--root",
      root,
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(fmt)).toEqual({ check: true, changed: [], errors: [] });
  const chunk = readFileSync(
    join(root, "world/islands/testisle/chunks/z07/c0032_0032.json"),
    "utf8",
  );
  expect(chunk).toContain('"sand"');
  expect(chunk).toContain('"cargo_crate"');

  // Reload: the edits come back from disk.
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__rpgEditor?.ready === true)).toBe(true);
  expect((await tile(page, 1050, 1050, 7))?.stack).toEqual(["cargo_crate"]);
  expect((await tile(page, 1049, 1063, 7))?.ground).toBe("sand");

  // English UI from i18n/en/editor.yaml.
  await page.goto("/?lang=en&island=testisle");
  await expect(page.getByTestId("floor")).toHaveText("Floor 7");
  await expect(page.getByTestId("validation-summary")).toHaveText("No errors or warnings");
  await shot(page, "06-english");

  expect(errors).toEqual([]);
});

test("hito 2: rectangle, autoborder, fill, copy/paste across floors and entity panels", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?lang=es&island=testisle");
  await expect.poll(() => page.evaluate(() => window.__rpgEditor?.ready === true)).toBe(true);
  await expect(page.getByTestId("autoborder")).toBeChecked();

  // Rectangle (R): drag a 4x3 sand rect into the grass; autoborder adds the grass edges.
  await pick(page, "arena", "sand");
  await page.keyboard.press("r");
  await expect(page.getByTestId("tool-rect")).toHaveClass(/active/);
  await dragTiles(page, [1045, 1046], [1048, 1048]);
  for (const [x, y] of [
    [1045, 1046],
    [1048, 1048],
  ] as const)
    expect((await tile(page, x, y, 7))?.ground).toBe("sand");
  expect((await tile(page, 1049, 1048, 7))?.ground).toBe("grass");
  expect((await tile(page, 1046, 1046, 7))?.stack).toEqual(["border_grass_sand_n"]);
  expect((await tile(page, 1046, 1048, 7))?.stack).toEqual(["border_grass_sand_s"]);
  expect((await tile(page, 1046, 1047, 7))?.stack).toEqual([]);
  await settled(page);
  await shot(page, "08-rect-autoborder");

  // Fill (G): the sand rect (and only it) becomes dirt; its borders go away.
  await pick(page, "tierra", "dirt");
  await page.keyboard.press("g");
  await expect(page.getByTestId("tool-fill")).toHaveClass(/active/);
  await clickTile(page, 1047, 1047);
  expect((await tile(page, 1045, 1046, 7))?.ground).toBe("dirt");
  expect((await tile(page, 1048, 1048, 7))?.ground).toBe("dirt");
  expect((await tile(page, 1044, 1047, 7))?.ground).toBe("grass");
  expect((await tile(page, 1046, 1046, 7))?.stack).toEqual([]);
  // One undo entry for the whole flood; redo brings it back.
  await page.keyboard.press("Control+z");
  expect((await tile(page, 1048, 1048, 7))?.ground).toBe("sand");
  await page.keyboard.press("Control+y");
  expect((await tile(page, 1048, 1048, 7))?.ground).toBe("dirt");

  // Selection (V) + copy, with an item inside; paste on floor 8.
  await page.getByTestId("category-decoration").click();
  await page.getByTestId("palette-search").fill("");
  await page.getByTestId("palette-cargo_crate").click();
  await clickTile(page, 1046, 1047);
  await page.keyboard.press("v");
  await expect(page.getByTestId("tool-select")).toHaveClass(/active/);
  await dragTiles(page, [1045, 1046], [1048, 1048]);
  await page.keyboard.press("Control+c");
  await expect(page.getByTestId("status")).toHaveText("Copiado: 4×3 casillas");
  await page.keyboard.press("PageDown");
  await expect(page.getByTestId("floor")).toHaveText("Piso 8");
  await page.evaluate(() => window.__rpgEditor?.centerOn(1068, 1054, 8));
  await page.keyboard.press("Control+v");
  const target = await clientOf(page, 1067, 1053);
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(100);
  await shot(page, "09-paste-preview");
  await clickTile(page, 1067, 1053);
  expect(await tile(page, 1068, 1054, 8)).toEqual({ ground: "dirt", stack: ["cargo_crate"] });
  expect((await tile(page, 1070, 1055, 8))?.ground).toBe("dirt");
  // Copied from the toolbar button too, and the source on floor 7 is unchanged.
  await expect(page.getByTestId("paste")).toBeEnabled();
  expect(await tile(page, 1046, 1047, 7)).toEqual({ ground: "dirt", stack: ["cargo_crate"] });
  await settled(page);
  await shot(page, "10-pasted-floor-8");
  await page.keyboard.press("PageUp");

  // Spawn panel: create one at a picked tile, then edit it; undo/redo the edit.
  await page.evaluate(() => window.__rpgEditor?.centerOn(1048, 1050, 7));
  await page.getByTestId("entity-tab-spawns").click();
  await expect(page.getByTestId("entity-testisle_wolves")).toBeVisible();
  await page.getByTestId("entity-new").click();
  await expect(page.getByTestId("field-id")).toHaveValue("testisle_spawn_1");
  await page.getByTestId("pick-center").click();
  await expect(page.getByTestId("status")).toHaveText("Clic en el mapa para elegir la casilla");
  await clickTile(page, 1047, 1052);
  await expect(page.getByTestId("field-center-x")).toHaveValue("1047");
  await expect(page.getByTestId("field-center-y")).toHaveValue("1052");
  await page.getByTestId("field-monster-0").selectOption("wolf");
  await page.getByTestId("field-count-0").fill("2");
  await page.getByTestId("entity-apply").click();
  await expect(page.getByTestId("entity-testisle_spawn_1")).toHaveClass(/active/);
  await page.getByTestId("field-radius").fill("3");
  await page.getByTestId("entity-apply").click();
  await expect(page.getByTestId("status")).not.toContainText("rechazada");
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("status")).toHaveText("Deshecho: editar entidad");
  await expect(page.getByTestId("field-radius")).toHaveValue("2");
  await page.keyboard.press("Control+y");
  await expect(page.getByTestId("field-radius")).toHaveValue("3");
  // Unapplied form edits survive map edits (#6) and switching islands (A), and a pick
  // asked for before switching lands in the open form.
  await page.getByTestId("field-notes").fill("sin aplicar");
  await clickTile(page, 1040, 1060); // with the select tool: takes the focus off the input
  await page.keyboard.press("b");
  await clickTile(page, 1040, 1060); // paints dirt: a map edit
  expect((await tile(page, 1040, 1060, 7))?.ground).toBe("dirt");
  await expect(page.getByTestId("field-notes")).toHaveValue("sin aplicar");
  await page.getByTestId("pick-center").click();
  await page.getByTestId("island").selectOption("puerto");
  await expect(page.getByTestId("field-notes")).toHaveValue("sin aplicar");
  await clickTile(page, 3158, 6388);
  await expect(page.getByTestId("field-center-x")).toHaveValue("3158");
  await expect(page.getByTestId("field-center-y")).toHaveValue("6388");
  await page.getByTestId("island").selectOption("testisle");
  await expect(page.getByTestId("field-notes")).toHaveValue("sin aplicar");
  await expect(page.getByTestId("entity-testisle_spawn_1")).toHaveClass(/active/);

  // #7: with page text selected, Ctrl+C is left to the browser (not prevented).
  await page.evaluate(() => {
    const w = window as unknown as { __copyPrevented?: boolean };
    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === "c") w.__copyPrevented = e.defaultPrevented;
    });
    const el = document.querySelector('[data-testid="validation-summary"]');
    const range = document.createRange();
    if (el) range.selectNodeContents(el);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  await page.keyboard.press("Control+c");
  expect(
    await page.evaluate(() => (window as unknown as { __copyPrevented?: boolean }).__copyPrevented),
  ).toBe(false);
  // A bad ID is reported in Spanish (checked before the op runs) and changes nothing.
  await page.getByTestId("field-id").fill("Bad ID");
  await page.getByTestId("entity-apply").click();
  await expect(page.getByTestId("status")).toHaveText(
    "ID inválido «Bad ID»: usa minúsculas, números y _ (empieza con letra)",
  );
  await page.getByTestId("entity-cancel").click();

  // Zone panel: a new zone takes its rect from the selection.
  await page.keyboard.press("v");
  await dragTiles(page, [1044, 1050], [1050, 1054]);
  await page.getByTestId("entity-tab-zones").click();
  await page.getByTestId("entity-new").click();
  await page.getByTestId("rects-from-selection").click();
  await expect(page.getByTestId("field-rects")).toHaveValue("1044,1050,7,5");
  await page.getByTestId("field-type").selectOption("no_pvp");
  await page.getByTestId("entity-apply").click();
  await expect(page.getByTestId("entity-testisle_zone_1")).toBeVisible();
  // Delete the dock zone (its file keeps the other entries).
  await page.getByTestId("entity-testisle_dock").click();
  await page.getByTestId("entity-delete").click();
  await expect(page.getByTestId("entity-testisle_dock")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await settled(page);
  await expect(page.getByTestId("validation-summary")).toHaveText("Sin errores ni advertencias");
  await page.evaluate(() => window.__rpgEditor?.centerOn(1048, 1050, 7));
  await page.waitForTimeout(100);
  await shot(page, "11-entities");

  // Save: chunks and YAML exactly as mapcli fmt writes them.
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("status")).toContainText("Guardado:");
  await expect(page.getByTestId("dirty")).toHaveText("Sin cambios");
  const fmt = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(repo, "tools/mapcli/src/cli.ts"),
      "fmt",
      "--check",
      "--root",
      root,
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(fmt)).toEqual({ check: true, changed: [], errors: [] });
  const spawns = readFileSync(join(root, "world/islands/testisle/spawns.yaml"), "utf8");
  expect(spawns).toContain("id: testisle_spawn_1");
  expect(spawns).toContain("radius: 3");
  const zones = readFileSync(join(root, "world/islands/testisle/zones.yaml"), "utf8");
  expect(zones).toContain("id: testisle_zone_1");
  expect(zones).not.toContain("testisle_dock");
  const validate = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(repo, "tools/mapcli/src/cli.ts"),
      "validate",
      "testisle",
      "--root",
      root,
    ],
    { encoding: "utf8" },
  );
  expect(validate).not.toMatch(/"severity": ?"error"/);
  expect(errors).toEqual([]);
});

test("asks before leaving with unsaved changes, and refuses to save over changes on disk", async ({
  page,
}) => {
  await page.goto("/?lang=es&island=testisle");
  await expect.poll(() => page.evaluate(() => window.__rpgEditor?.ready === true)).toBe(true);
  await pick(page, "tierra", "dirt");
  await clickTile(page, 1046, 1059);
  expect((await tile(page, 1046, 1059, 7))?.ground).toBe("dirt");
  await expect(page.getByTestId("dirty")).toHaveText("Cambios sin guardar");

  // Someone changes the same chunk on disk (git pull, mapcli...) after the editor loaded it.
  const file = join(root, "world/islands/testisle/chunks/z07/c0032_0033.json");
  const external = readFileSync(file, "utf8").replace('"sand"', '"grass"');
  writeFileSync(file, external);
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("status")).toContainText("No se guardó nada: 1 archivo(s)");
  await expect(page.getByTestId("status")).toContainText("testisle/chunks/z07/c0032_0033.json");
  await expect(page.getByTestId("dirty")).toHaveText("Cambios sin guardar");
  expect(readFileSync(file, "utf8")).toBe(external);
  await shot(page, "07-save-conflict");

  // Leaving the page with unsaved changes triggers the browser's confirmation.
  const dialog = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const d = await dialog;
  expect(d.type()).toBe("beforeunload");
  await d.accept();
});

test("the API refuses requests that do not come from the editor page", async ({ request }) => {
  const save = { world: { meta: {}, islands: [] }, changes: [] };
  const plain = await request.post("/api/save", { data: save });
  expect(plain.status()).toBe(403);
  const foreign = await request.post("/api/save", {
    data: save,
    headers: { "x-rpg-editor": "1", origin: "https://evil.example" },
  });
  expect(foreign.status()).toBe(403);
  const traversal = await request.post("/api/save", {
    data: {
      world: { meta: { format: 1, islands: [], boat_routes: [] }, islands: [] },
      changes: [{ file: "world/islands/testisle/../../../evil.json", base: null }],
    },
    headers: { "x-rpg-editor": "1" },
  });
  expect(traversal.status()).toBe(400);
});

test("hito 2: map patches — export, diff view, import with and without conflicts", async ({
  page,
}) => {
  // Start from the repository's world/: earlier tests leave edits (and a broken chunk) in
  // the scratch copy, which would show up in this test's screenshots.
  rmSync(join(root, "world"), { recursive: true, force: true });
  cpSync(join(repo, "world"), join(root, "world"), { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?lang=es&island=testisle");
  await expect.poll(() => page.evaluate(() => window.__rpgEditor?.ready === true)).toBe(true);
  await expect(page.getByTestId("validation-summary")).toHaveText("Sin errores ni advertencias");
  const CHUNK = "world/islands/testisle/chunks/z07/c0033_0032.json";
  const onDisk = readFileSync(join(root, CHUNK), "utf8");
  const A: [number, number] = [1058, 1040];
  const original = await tile(page, ...A, 7);
  expect(original?.ground).toBe("grass");

  // Review panel: empty diff at first.
  await page.getByTestId("review").click();
  await expect(page.getByTestId("review-empty")).toBeVisible();

  // A local edit (autoborder off: exactly one tile) and a new spawn.
  await page.getByTestId("autoborder").uncheck();
  await pick(page, "tierra", "dirt");
  await page.getByTestId("brush-size").selectOption("1");
  await page.evaluate(() => window.__rpgEditor?.centerOn(1058, 1040, 7));
  await clickTile(page, ...A);
  expect((await tile(page, ...A, 7))?.ground).toBe("dirt");
  await expect(page.getByTestId("review-chunk")).toHaveText(
    "testisle · z07/c0033_0032 · 1 casillas",
  );
  await page.getByTestId("review-after").click();
  await page.evaluate(() => window.__rpgEditor?.centerOn(1060, 1045, 7));
  await page.getByTestId("review-chunk").click(); // navigates to the change
  await shot(page, "30-review-after");
  await page.getByTestId("review-before").click();
  await expect(page.getByTestId("review-before")).toHaveClass(/active/);
  await shot(page, "31-review-before");
  // The "before" view is read-only.
  await clickTile(page, 1059, 1040);
  await expect(page.getByTestId("status")).toContainText("Antes");
  expect((await tile(page, 1059, 1040, 7))?.ground).toBe("grass");
  await page.getByTestId("review-after").click();

  // Export: a download, format 2, base = the file on disk; world/ untouched.
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("patch-export").click(),
  ]);
  expect(dl.suggestedFilename()).toBe("testisle.rpgpatch.json");
  const patchPath = join(root, "exported.rpgpatch.json");
  await dl.saveAs(patchPath);
  const patch = JSON.parse(readFileSync(patchPath, "utf8")) as {
    format: number;
    files: { path: string; base_text?: string; content: string }[];
  };
  expect(patch.format).toBe(2);
  expect(patch.files.map((f) => f.path)).toEqual([CHUNK]);
  expect(patch.files[0]?.base_text).toBe(onDisk);
  expect(readFileSync(join(root, CHUNK), "utf8")).toBe(onDisk);

  // Import without conflict: undo the edit, import the patch, undo it in one step.
  await page.getByTestId("undo").click();
  expect((await tile(page, ...A, 7))?.ground).toBe("grass");
  await page.getByTestId("patch-file").setInputFiles(patchPath);
  await expect(page.getByTestId("status")).toHaveText(
    "Patch importado: 1 archivos (Ctrl+Z lo deshace)",
  );
  expect((await tile(page, ...A, 7))?.ground).toBe("dirt");
  await shot(page, "32-imported");
  await page.getByTestId("undo").click();
  expect((await tile(page, ...A, 7))?.ground).toBe("grass");

  // Import with a conflict: the same tile now has another ground here.
  await pick(page, "arena", "sand");
  await clickTile(page, ...A);
  const before = await tile(page, ...A, 7);
  await page.getByTestId("patch-file").setInputFiles(patchPath);
  await expect(page.getByTestId("status")).toHaveText(
    "El patch tiene 1 conflictos: no se aplicó nada",
  );
  await expect(page.getByTestId("patch-conflicts").locator("li")).toHaveText([
    "testisle/chunks/z07/c0033_0032.json: casilla 1058,1040,7",
  ]);
  expect(await tile(page, ...A, 7)).toEqual(before);
  await shot(page, "33-conflict");

  // A malicious patch is refused by the dev server before anything is merged.
  await page.getByTestId("patch-file").setInputFiles({
    name: "evil.rpgpatch.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: 2,
        kind: "rpg-map-patch",
        base_ref: "editor",
        files: [{ path: "world/../data/items/ground.yaml", base: null, content: "[]\n" }],
      }),
    ),
  });
  await expect(page.getByTestId("status")).toContainText("Patch rechazado");
  expect(errors).toEqual([]);
});
