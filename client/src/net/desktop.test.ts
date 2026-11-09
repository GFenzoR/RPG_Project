import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLIENT_VERSION } from "../version.ts";
import { gameSocketUrl, isDesktop, normalizeServerUrl, serverUrlError } from "./desktop.ts";

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

// Mirrors config.rs (Server::parse) tests: the picker explains before the app refuses.
describe("serverUrlError", () => {
  it("accepts https anywhere and http only on this machine or a private network", () => {
    for (const ok of [
      "https://juego.example.com",
      " https://x.trycloudflare.com:8443/ ",
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://192.168.1.20:8080",
      "http://10.0.0.5",
      "http://172.20.0.2",
    ])
      expect(serverUrlError(ok), ok).toBeUndefined();
    for (const bad of ["http://juego.example.com", "http://8.8.8.8", "http://172.32.0.1"])
      expect(serverUrlError(bad), bad).toBe("insecure");
  });

  it("refuses anything but a server origin", () => {
    for (const bad of [
      "",
      "juego.example.com",
      "ftp://juego.example.com",
      "https://user:pw@juego.example.com",
      "http://[::1]:8080",
    ])
      expect(serverUrlError(bad), bad).toBe("invalid");
    for (const bad of [
      "http://localhost:8080/play/",
      "https://juego.example.com/?x=1",
      "https://juego.example.com/#x",
    ])
      expect(serverUrlError(bad), bad).toBe("path");
  });
});

describe("normalizeServerUrl", () => {
  it("adds http:// only to a bare local address", () => {
    expect(normalizeServerUrl(" 192.168.1.20:8080 ")).toBe("http://192.168.1.20:8080");
    expect(normalizeServerUrl("localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeServerUrl("https://x.trycloudflare.com")).toBe("https://x.trycloudflare.com");
    // Not local: left as typed, so the picker explains instead of guessing a scheme.
    expect(normalizeServerUrl("juego.example.com")).toBe("juego.example.com");
    expect(normalizeServerUrl("")).toBe("");
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
