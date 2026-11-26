// The roofed tiles the build shipped (client/vite/roofs.ts, docs/17 "Bajo techo"), as the
// map view asks for them: by floor, then by tile. Built once.

/** `roofs`: by floor, flat runs [y, x, length, ...] in global tiles (ClientContent.roofs). */
export function roofLookup(
  roofs: Readonly<Record<string, readonly number[]>> | undefined,
): ((floor: number) => ((x: number, y: number) => boolean) | undefined) | undefined {
  if (!roofs) return undefined;
  const floors = new Map<number, Set<number>>();
  for (const [z, runs] of Object.entries(roofs)) {
    const tiles = new Set<number>();
    for (let i = 0; i + 2 < runs.length; i += 3) {
      const y = runs[i] as number;
      const x = runs[i + 1] as number;
      for (let k = 0; k < (runs[i + 2] as number); k++) tiles.add(y * 65536 + x + k);
    }
    floors.set(Number(z), tiles);
  }
  // A floor the build has no roofs for has none: the map is whole there too.
  const none = (): boolean => false;
  return (floor) => {
    const tiles = floors.get(floor);
    return tiles ? (x, y) => tiles.has(y * 65536 + x) : none;
  };
}
