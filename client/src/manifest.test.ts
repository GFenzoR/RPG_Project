// The web app manifest (docs/15 "Pantalla completa e instalar como app"): installed, the
// game opens straight at /play/ with no browser chrome, in either orientation, on the
// colours of the gothic theme.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MANIFEST_TEMPLATE, gameName, renderManifest } from "../vite/brand.ts";
import { repoRoot } from "../vite/content.ts";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  start_url: string;
  scope: string;
  display: string;
  display_override: string[];
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}

// The file is a template (client/manifest.webmanifest.in): vite/brand.ts fills the game's name
// in, from the i18n key client.title, and serves it at /manifest.webmanifest.
const root = repoRoot();
const manifest = JSON.parse(
  renderManifest(readFileSync(join(root, MANIFEST_TEMPLATE), "utf8"), gameName(root)),
) as Manifest;

describe("manifest.webmanifest", () => {
  it("opens the game itself, full screen, with standalone as the fallback", () => {
    expect(manifest.start_url).toBe("/play/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("fullscreen");
    expect(manifest.display_override).toEqual(["fullscreen", "standalone"]);
  });

  it("does not lock the orientation", () => {
    expect(manifest.orientation).toBe("any");
  });

  it("uses the void of the gothic theme, as the pages do", () => {
    const voidColour = /--ui-void:\s*(#[0-9a-f]{6})/i.exec(
      readFileSync(join(here, "ui", "client.css"), "utf8"),
    )?.[1];
    expect(voidColour).toBeDefined();
    expect(manifest.background_color).toBe(voidColour);
    expect(manifest.theme_color).toBe(voidColour);
    for (const page of ["index.html", join("play", "index.html")]) {
      const html = readFileSync(join(here, "..", page), "utf8");
      expect(html).toContain(`<meta name="theme-color" content="${voidColour}" />`);
      expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
      expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
      expect(html).toContain('rel="apple-touch-icon"');
      expect(html).toContain("viewport-fit=cover");
    }
  });

  it("has a 192 and a 512 icon, a maskable one, and every file exists", () => {
    const sizes = manifest.icons.filter((i) => i.purpose === "any").map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(manifest.icons.some((i) => i.purpose === "maskable" && i.sizes === "512x512")).toBe(
      true,
    );
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(existsSync(join(publicDir, icon.src))).toBe(true);
    }
  });
});
