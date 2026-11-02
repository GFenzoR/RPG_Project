// Minimal RGBA image helpers on top of pngjs (decode, encode, blit, fill).
import { PNG } from "pngjs";

export interface Image {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8Array;
}

export type Rgba = readonly [number, number, number, number];

export function createImage(width: number, height: number): Image {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function decodePng(buf: Buffer): Image {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

/** Encodes deterministically: same pixels, same bytes. */
export function encodePng(img: Image): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png, { colorType: 6 });
}

export function fillRect(
  img: Image,
  x: number,
  y: number,
  w: number,
  h: number,
  color: Rgba,
): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(img.width, x + w);
  const y1 = Math.min(img.height, y + h);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * img.width + px) * 4;
      img.data[i] = color[0];
      img.data[i + 1] = color[1];
      img.data[i + 2] = color[2];
      img.data[i + 3] = color[3];
    }
  }
}

/** Copies the src rectangle (sx, sy, w, h) into dst at (dx, dy), replacing pixels. */
export function blit(
  src: Image,
  sx: number,
  sy: number,
  w: number,
  h: number,
  dst: Image,
  dx: number,
  dy: number,
): void {
  for (let row = 0; row < h; row++) {
    const s = ((sy + row) * src.width + sx) * 4;
    const d = ((dy + row) * dst.width + dx) * 4;
    dst.data.set(src.data.subarray(s, s + w * 4), d);
  }
}

/** Nearest-neighbour upscale, for previews meant to be looked at. */
export function scaleImage(img: Image, factor: number): Image {
  const out = createImage(img.width * factor, img.height * factor);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const s = (Math.floor(y / factor) * img.width + Math.floor(x / factor)) * 4;
      out.data.set(img.data.subarray(s, s + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

export function parseHexColor(hex: string): Rgba | undefined {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m?.[1]) return undefined;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}
