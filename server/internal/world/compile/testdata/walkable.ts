// Prints, as JSON, which tiles packages/map-format considers walkable in the world under the
// root given as the first argument. Used by mapcompile's parity test (compile_test.go):
//   node --experimental-strip-types walkable.ts <root>
import { TileMap, isWalkable, loadContent, loadWorld } from "../../../../../packages/map-format/src/index.ts";

const root = process.argv[2] ?? ".";
const { world, diagnostics } = loadWorld(root);
const errors = diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error(JSON.stringify(errors, null, 2));
  process.exit(1);
}
const content = loadContent(root);
const tiles = new TileMap(world.islands.values());
const out = [];
for (const island of world.islands.values()) {
  const { rect, floors } = island.meta;
  for (const z of floors) {
    const rows: string[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      let row = "";
      for (let x = rect.x; x < rect.x + rect.w; x++)
        row += isWalkable(tiles.tile(x, y, z), content) ? "1" : "0";
      rows.push(row);
    }
    out.push({ island: island.meta.id, z, x: rect.x, y: rect.y, rows });
  }
}
console.log(JSON.stringify(out));
