import { describe, expect, it } from "vitest";
import { loadLastEmail, saveLastEmail } from "./last-email.ts";

class MemoryStorage implements Storage {
  private readonly m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  entries(): [string, string][] {
    return [...this.m.entries()];
  }
}

describe("remembered login email (lote 17)", () => {
  it("prefills the last email and stores nothing else", () => {
    const s = new MemoryStorage();
    expect(loadLastEmail(s)).toBe("");
    saveLastEmail("  ana@example.org ", s);
    expect(loadLastEmail(s)).toBe("ana@example.org");
    // Only the email: no token, no password, no other key.
    expect(s.entries()).toEqual([["rpg.lastEmail", "ana@example.org"]]);
  });

  it("forgets on an empty email and ignores junk", () => {
    const s = new MemoryStorage();
    saveLastEmail("ana@example.org", s);
    saveLastEmail("", s);
    expect(s.length).toBe(0);
    s.setItem("rpg.lastEmail", "not an email");
    expect(loadLastEmail(s)).toBe("");
  });

  it("survives a storage that throws or is missing", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadLastEmail(broken)).toBe("");
    expect(loadLastEmail(undefined)).toBe("");
    expect(() => saveLastEmail("ana@example.org", undefined)).not.toThrow();
  });
});

describe("no token in web storage (lote 17)", () => {
  it("the API and desktop modules never touch web storage", async () => {
    const { readFileSync } = await import("node:fs");
    const code = (f: string): string =>
      readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
    for (const f of ["../net/api.ts", "../net/desktop.ts"]) {
      expect(code(f)).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
    // The only thing the login remembers is an email.
    expect(code("./last-email.ts")).not.toMatch(/token|password/i);
  });
});
