import { describe, expect, it } from "vitest";
import { formatYaml } from "../yaml.ts";
import { PatchError, canonicalPatchText, parsePatchFile } from "./patch.ts";

const SP = "world/islands/isle/spawns.yaml";
const spawn = (notes: string) => [
  {
    id: "s",
    center: { x: 1, y: 1, z: 7 },
    radius: 1,
    monsters: [{ monster: "wolf", count: 1 }],
    respawn_seconds: 60,
    notes,
  },
];

describe("characters the Go server's yaml.v3 refuses (F1)", () => {
  it("rejects C0 (but tab/LF/CR), DEL, C1 and U+FFFE/U+FFFF, raw or escaped", () => {
    for (const ch of ["\u0000", "\u0007", "\u001b", "\u007f", "\u0085", "\u009f", "￾", "￿"]) {
      const raw = formatYaml(spawn(`a${ch}b`));
      expect(() => parsePatchFile(SP, raw), JSON.stringify(ch)).toThrow(PatchError);
    }
    // Written as a YAML escape inside a double-quoted string, still rejected.
    const escaped = formatYaml(spawn("PLACEHOLDER")).replace(/notes: .*/, 'notes: "a\\x7fb"');
    expect(() => parsePatchFile(SP, escaped)).toThrow(PatchError);
  });

  it("accepts accents, ñ and other ordinary text, and keeps it canonical", () => {
    const text = formatYaml(spawn("Playa del ñandú: árbol, «muelle» y café — 東"));
    expect(parsePatchFile(SP, text)).toBeTruthy();
    expect(canonicalPatchText(SP, text)).toBe(text);
  });
});
