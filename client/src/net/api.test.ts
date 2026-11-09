import { afterEach, describe, expect, it, vi } from "vitest";
import { api, authConfig, forgetEmailConfig, registerBody } from "./api.ts";

describe("register body (T2.1)", () => {
  it("sends lang only to a server that sends emails", () => {
    expect(registerBody("a@b.c", "pw", "es", true)).toEqual({
      email: "a@b.c",
      password: "pw",
      lang: "es",
    });
    expect(registerBody("a@b.c", "pw", "es", false)).toEqual({ email: "a@b.c", password: "pw" });
    expect(registerBody("a@b.c", "pw", undefined, true)).toEqual({
      email: "a@b.c",
      password: "pw",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetEmailConfig();
  });

  it("leaves lang out when an older server answers 404 to /api/auth/config", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: { body?: string }) => {
        if (path === "/api/auth/config")
          return Promise.resolve(new Response('{"error":{"code":"not_found"}}', { status: 404 }));
        bodies.push(JSON.parse(init?.body ?? "null"));
        return Promise.resolve(new Response('{"account_id":1}', { status: 201 }));
      }),
    );
    await api.register("a@b.c", "long-password", "es");
    expect(bodies).toEqual([{ email: "a@b.c", password: "long-password" }]);
  });
});

describe("authConfig", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetEmailConfig();
  });
  it("keeps only known providers and treats an old server as none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response('{"email":true,"providers":["discord","evil","google"]}', { status: 200 }),
        ),
      ),
    );
    expect(await authConfig()).toEqual({ email: true, providers: ["google", "discord"] });
  });
});
