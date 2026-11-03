import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLIENT_VERSION } from "../version.ts";
import { gameSocketUrl, isDesktop } from "./desktop.ts";

describe("gameSocketUrl", () => {
  it("uses the page's host on the web", () => {
    expect(gameSocketUrl({ protocol: "https:", host: "juego.example.com" }, undefined)).toBe(
      "wss://juego.example.com/ws",
    );
    expect(gameSocketUrl({ protocol: "http:", host: "localhost:5173" }, undefined)).toBe(
      "ws://localhost:5173/ws",
    );
  });

  it("uses the server the desktop app was configured with", () => {
    expect(
      gameSocketUrl({ protocol: "tauri:", host: "localhost" }, "wss://x.trycloudflare.com/ws"),
    ).toBe("wss://x.trycloudflare.com/ws");
  });

  it("is not the desktop app under Node", () => {
    expect(isDesktop()).toBe(false);
  });
});

describe("CLIENT_VERSION", () => {
  it("is client/package.json's version, the one source of the app version", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
    };
    expect(CLIENT_VERSION).toBe(pkg.version);
    expect(CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const tauri = JSON.parse(
      readFileSync(
        new URL("../../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url),
        "utf8",
      ),
    ) as { version: string };
    expect(tauri.version).toBe("../../../client/package.json");
  });
});
