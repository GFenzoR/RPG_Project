import { describe, expect, it } from "vitest";
import { shouldRegisterServiceWorker } from "./pwa.ts";
import type { RegistrationEnv } from "./pwa.ts";

const web: RegistrationEnv = {
  prod: true,
  supported: true,
  secure: true,
  desktop: false,
  protocol: "https:",
};

describe("shouldRegisterServiceWorker", () => {
  it("registers in a production build served over https or localhost", () => {
    expect(shouldRegisterServiceWorker(web)).toBe(true);
    expect(shouldRegisterServiceWorker({ ...web, protocol: "http:" })).toBe(true);
  });

  it("skips the dev server, old browsers and insecure origins", () => {
    expect(shouldRegisterServiceWorker({ ...web, prod: false })).toBe(false);
    expect(shouldRegisterServiceWorker({ ...web, supported: false })).toBe(false);
    expect(shouldRegisterServiceWorker({ ...web, secure: false, protocol: "http:" })).toBe(false);
  });

  it("skips the Tauri app and non-http schemes", () => {
    expect(shouldRegisterServiceWorker({ ...web, desktop: true })).toBe(false);
    expect(shouldRegisterServiceWorker({ ...web, protocol: "tauri:" })).toBe(false);
  });
});
