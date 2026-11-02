// Opens the editor, edits testisle with every hito 1 tool, checks undo/redo, live
// validation and floors, saves, and verifies the saved files are canonical (`mapcli fmt
// --check` finds nothing to change). Screenshots: e2e/screenshots/actual/.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
    "Isla de pruebas (testisle)",
    "Isla del Puerto (puerto)",
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
  await page.goto("/?lang=en");
  await expect(page.getByTestId("floor")).toHaveText("Floor 7");
  await expect(page.getByTestId("validation-summary")).toHaveText("No errors or warnings");
  await shot(page, "06-english");

  expect(errors).toEqual([]);
});

test("asks before leaving with unsaved changes, and refuses to save over changes on disk", async ({
  page,
}) => {
  await page.goto("/?lang=es");
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
