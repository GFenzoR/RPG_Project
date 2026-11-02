import { describe, expect, it } from "vitest";
import { refuseRequest } from "./guard.ts";

const ok = {
  host: "localhost:5174",
  "x-rpg-editor": "1",
  "content-type": "application/json",
  origin: "http://localhost:5174",
  "sec-fetch-site": "same-origin",
};

describe("refuseRequest", () => {
  it("lets the editor page through", () => {
    expect(refuseRequest("POST", ok)).toBeUndefined();
    expect(refuseRequest("GET", { host: ok.host, "x-rpg-editor": "1" })).toBeUndefined();
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ["no API header (simple cross-site form/fetch)", { ...ok, "x-rpg-editor": "" }, /missing x-rpg-editor/],
    ["another site", { ...ok, "sec-fetch-site": "cross-site" }, /cross-site/],
    ["a sibling localhost port", { ...ok, "sec-fetch-site": "same-site" }, /cross-site/],
    ["a foreign Origin", { ...ok, origin: "https://evil.example" }, /cross-origin request from https:\/\/evil.example/],
    ["a text/plain body", { ...ok, "content-type": "text/plain" }, /application\/json/],
  ])("refuses %s", (_name, headers, msg) => {
    expect(refuseRequest("POST", headers)).toMatch(msg);
  });
});
