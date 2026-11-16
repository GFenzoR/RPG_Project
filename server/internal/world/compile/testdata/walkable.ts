// Prints, as JSON, which tiles packages/map-format considers walkable in the world under the
// root given as the first argument, or with "portals" as the second the portals it loads
// (island by island, in file order). Used by mapcompile's parity test (compile_test.go):
//   node --experimental-strip-types walkable.ts <root> [portals]
import { TileMap, isWalkable, loadContent, loadWorld } from "../../../../../packages/map-format/src/index.ts";

const root = process.argv[2] ?? ".";
const { world, diagnostics } = loadWorld(root);
const errors = diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error(JSON.stringify(errors, null, 2));
  process.exit(1);
}
if (process.argv[3] === "portals") {
  const portals = [];
  for (const island of world.islands.values())
    for (const p of island.portals)
      portals.push({
        id: p.id,
        kind: p.kind,
        from: [p.from.x, p.from.y, p.from.z],
        to: [p.to.x, p.to.y, p.to.z],
      });
  console.log(JSON.stringify(portals));
  process.exit(0);
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
