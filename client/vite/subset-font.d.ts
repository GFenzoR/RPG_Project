// subset-font (devDependency of the fonts plugin, vite/fonts.ts) ships no types.
declare module "subset-font" {
  export interface SubsetFontOptions {
    targetFormat?: "sfnt" | "woff" | "woff2" | "truetype";
    preserveNameIds?: number[];
    variationAxes?: Record<string, number | { min: number; max: number; default?: number }>;
    noLayoutClosure?: boolean;
  }
  export default function subsetFont(
    font: Uint8Array,
    text: string,
    options?: SubsetFontOptions,
  ): Promise<Uint8Array>;
}
