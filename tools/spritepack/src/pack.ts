// Deterministic shelf packer: sprites are multiples of 32 px, so shelves pack tightly.

export interface PackInput {
  name: string;
  width: number;
  height: number;
}

export interface Placement {
  name: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PackResult {
  placements: Placement[];
  /** Used size of each page (the page image is cropped to it). */
  pages: { width: number; height: number }[];
}

/**
 * Places sprites tallest-first (ties by name) on rows of at most maxSize px, opening a new
 * page when a page is full. The order depends only on the inputs, never on insertion order.
 */
export function packSprites(inputs: PackInput[], maxSize: number): PackResult {
  const sorted = [...inputs].sort(
    (a, b) =>
      b.height - a.height || b.width - a.width || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const placements: Placement[] = [];
  const pages: { width: number; height: number }[] = [];
  let page = -1;
  let x = 0;
  let y = 0;
  let rowH = 0;
  const newPage = (): void => {
    page++;
    pages.push({ width: 0, height: 0 });
    x = 0;
    y = 0;
    rowH = 0;
  };
  newPage();
  for (const s of sorted) {
    if (s.width > maxSize || s.height > maxSize) {
      throw new Error(
        `sprite ${s.name} (${s.width}x${s.height}) is larger than the ${maxSize}px atlas page`,
      );
    }
    if (x + s.width > maxSize) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    if (y + s.height > maxSize) newPage();
    placements.push({ name: s.name, page, x, y, width: s.width, height: s.height });
    const p = pages[page];
    if (p) {
      p.width = Math.max(p.width, x + s.width);
      p.height = Math.max(p.height, y + s.height);
    }
    x += s.width;
    rowH = Math.max(rowH, s.height);
  }
  return { placements, pages: pages.filter((p) => p.width > 0) };
}
