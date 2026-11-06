import { describe, expect, it } from "vitest";
import {
  byteLength,
  canSubmit,
  cleanInput,
  errorKey,
  failureKey,
  formatSize,
  groupFiles,
  groupLabel,
  isMapStatus,
  manualPr,
  precheckPatch,
  safePrUrl,
} from "./maps.ts";
import { parseRoute } from "./routes.ts";

const patch = (o: object): string =>
  JSON.stringify({ format: 2, kind: "rpg-map-patch", base_ref: "editor", files: [{}], ...o });

describe("map portal routes", () => {
  it("parses the portal pages", () => {
    expect(parseRoute("/maps")).toEqual({ page: "maps_submit" });
    expect(parseRoute("/maps/submit/")).toEqual({ page: "maps_submit" });
    expect(parseRoute("/maps/mine")).toEqual({ page: "maps_mine" });
    expect(parseRoute("/maps/review")).toEqual({ page: "maps_review" });
    expect(parseRoute("/maps/review/42")).toEqual({ page: "maps_review", id: 42 });
  });
  it("rejects odd ids", () => {
    for (const p of ["/maps/review/0", "/maps/review/-1", "/maps/review/1e3", "/maps/review/abc"])
      expect(parseRoute(p)).toEqual({ page: "not_found" });
  });
});

describe("errorKey", () => {
  it("maps patch check codes", () => {
    expect(errorKey("invalid_patch", "path")).toBe("site.maps.patch_error.path");
    expect(errorKey("invalid_patch", "forbidden_char")).toBe(
      "site.maps.patch_error.forbidden_char",
    );
  });
  it("never builds a key from an unknown detail", () => {
    expect(errorKey("invalid_patch", "__proto__")).toBe("site.maps.patch_error.not_patch");
    expect(errorKey("invalid_patch")).toBe("site.maps.patch_error.not_patch");
  });
  it("uses portal texts, then the shared errors", () => {
    expect(errorKey("submit_limit")).toBe("site.maps.error.submit_limit");
    expect(errorKey("forbidden")).toBe("site.maps.error.forbidden");
    expect(errorKey("own_submission")).toBe("site.maps.error.own_submission");
    expect(errorKey("account_blocked")).toBe("site.maps.error.account_blocked");
    expect(errorKey("patch_gone")).toBe("site.maps.error.patch_gone");
    expect(errorKey("unauthorized")).toBe("error.unauthorized");
    expect(errorKey("network")).toBe("error.network");
  });
});

describe("precheckPatch", () => {
  it("accepts a patch", () => expect(precheckPatch(patch({}), 1 << 20)).toBeNull());
  it("finds the obvious problems", () => {
    expect(precheckPatch("{", 100)).toBe("not_json");
    expect(precheckPatch("[]", 100)).toBe("not_patch");
    expect(precheckPatch("null", 100)).toBe("not_patch");
    expect(precheckPatch(patch({ kind: "x" }), 1000)).toBe("not_patch");
    expect(precheckPatch(patch({ format: 1 }), 1000)).toBe("format");
    expect(precheckPatch(patch({ files: [] }), 1000)).toBe("no_files");
    expect(precheckPatch(patch({}), 10)).toBe("too_large");
  });
  it("measures bytes, not characters", () => {
    expect(byteLength("ñ")).toBe(2);
    const p = patch({ base_ref: "ñ".repeat(10) });
    expect(precheckPatch(p, p.length)).toBe("too_large");
    expect(precheckPatch(p, byteLength(p))).toBeNull();
  });
});

describe("helpers", () => {
  it("formats sizes", () => {
    expect(formatSize(512, "es")).toBe("512 B");
    expect(formatSize(1536, "en")).toBe("1.5 KiB");
    expect(formatSize(1536, "es")).toBe("1,5 KiB");
    expect(formatSize(2 * 1024 * 1024, "en")).toBe("2 MiB");
  });
  it("groups files by island", () => {
    const g = groupFiles([
      { path: "world/islands/puerto/chunks/z07/c0100_0196.json", action: "modify" },
      { path: "world/islands/puerto/zones.yaml", action: "modify" },
      { path: "world/prefabs/hut.yaml", action: "create" },
      { path: "world/world.yaml", action: "modify" },
    ]);
    expect([...g.keys()]).toEqual(["puerto", "prefabs", "world"]);
    const t = (k: string): string => `<${k}>`;
    expect(groupLabel("puerto", t)).toBe("puerto");
    expect(groupLabel("world", t)).toBe("<site.maps.group.world>");
    expect(g.get("puerto")).toHaveLength(2);
  });
  it("cleans inputs and gates the form", () => {
    expect(cleanInput("  a\r\nb  ")).toBe("a\nb");
    const ok = { title: "Muelle", characterId: 1, license: true, patch: "{}", busy: false };
    expect(canSubmit(ok)).toBe(true);
    expect(canSubmit({ ...ok, title: "   " })).toBe(false);
    expect(canSubmit({ ...ok, characterId: null })).toBe(false);
    expect(canSubmit({ ...ok, license: false })).toBe(false);
    expect(canSubmit({ ...ok, patch: null })).toBe(false);
    expect(canSubmit({ ...ok, busy: true })).toBe(false);
  });
  it("names worker failures, never building a key from an unknown code", () => {
    expect(failureKey("conflict")).toBe("site.maps.failure.conflict");
    expect(failureKey("outside_plot")).toBe("site.maps.failure.outside_plot");
    expect(failureKey("constructor")).toBe("site.maps.outcome.failed");
    expect(failureKey(undefined)).toBe("site.maps.outcome.failed");
  });
  it("gives the worker's branch and marker for a PR opened by hand", () => {
    expect(manualPr({ id: 12, sha256: "ab".repeat(32) })).toEqual({
      branch: "map-submission/12-abababababab",
      marker: `<!-- rpg-map-submission: 12 sha256:${"ab".repeat(32)} -->`,
    });
  });
  it("checks statuses and PR links", () => {
    expect(isMapStatus("pr_opened")).toBe(true);
    expect(isMapStatus("deleted")).toBe(false);
    expect(safePrUrl({ pr_url: "https://github.com/o/r/pull/3" })).toBe(
      "https://github.com/o/r/pull/3",
    );
    expect(safePrUrl({ pr_url: "javascript:alert(1)" })).toBeUndefined();
    expect(safePrUrl({ pr_url: "https://evil.example/pull/3" })).toBeUndefined();
    expect(safePrUrl({})).toBeUndefined();
  });
});
