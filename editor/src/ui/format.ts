import type { WireDiagnostic } from "../io/wire.ts";

/** "error testisle/island.yaml:5 (1056,1056,7) temple is not on a walkable tile" */
export function formatDiagnosticShort(d: WireDiagnostic): string {
  const file = d.file.replace(/^world\/islands\//, "");
  const where = d.line === undefined ? file : `${file}:${d.line}`;
  const pos = d.pos ? ` (${d.pos.x},${d.pos.y},${d.pos.z})` : "";
  return `${where}${pos} ${d.message}`;
}
