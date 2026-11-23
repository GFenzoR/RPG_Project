import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boundaryProblems, glueList, GO_REPO, importsOf, targetOf } from "./boundary.ts";

/** A TS import of `spec` (built, so this file's own source imports nothing of it). */
const imp = (spec: string): string => `import { x } from "${spec}";`;

const README = `
<!-- glue:begin -->
- \`client/src/render/living.ts\`: mounts it
- \`server/internal/game/living.go\`: calls it
<!-- glue:end -->
- \`client/src/other.ts\` (outside the list)
`;

describe("livingworld boundary", () => {
  it("reads the glue list between its markers only", () => {
    expect([...glueList(README)]).toEqual([
      "client/src/render/living.ts",
      "server/internal/game/living.go",
    ]);
  });

  it("finds TS and Go imports", () => {
    expect(
      importsOf(
        "a.ts",
        [
          imp("@rpg/living-world"),
          'export * from "./y.ts";',
          'import "./z.css";',
          'await import("../q.ts");',
        ].join("\n"),
      ),
    ).toEqual(["@rpg/living-world", "./y.ts", "./z.css", "../q.ts"]);
    expect(
      importsOf(
        "a.go",
        `package a\n\nimport (\n\t"fmt"\n\tlw "${GO_REPO}/livingworld/server/trail"\n)\n`,
      ),
    ).toEqual(["fmt", `${GO_REPO}/livingworld/server/trail`]);
    expect(targetOf("livingworld/client/src/a.ts", "../../../client/src/game.ts")).toBe("client");
    expect(targetOf("client/src/a.ts", "../../livingworld/client/src/index.ts")).toBe(
      "livingworld",
    );
    expect(targetOf("x.go", `${GO_REPO}/server/internal/world`)).toBe("server");
  });

  it("refuses livingworld importing server or client, and imports of it outside the glue", () => {
    const glue = glueList(README);
    const problems = boundaryProblems(
      [
        { path: "livingworld/client/src/a.ts", text: imp("@rpg/client") },
        { path: "livingworld/client/src/b.ts", text: imp("../../../client/src/game.ts") },
        {
          path: "livingworld/server/trail/t.go",
          text: `package trail\nimport "${GO_REPO}/server/internal/world"\n`,
        },
        { path: "livingworld/client/src/ok.ts", text: imp("pixi.js") },
        { path: "client/src/render/living.ts", text: imp("@rpg/living-world") },
        { path: "client/src/other.ts", text: imp("@rpg/living-world/data") },
        {
          path: "server/internal/game/sneaky.go",
          text: `package game\nimport lw "${GO_REPO}/livingworld/server"\n`,
        },
        { path: "docs/notes.md", text: imp("@rpg/living-world") },
      ],
      glue,
    );
    expect(problems).toHaveLength(5);
    expect(problems.filter((p) => p.startsWith("livingworld/"))).toHaveLength(3);
    expect(problems.some((p) => p.startsWith("client/src/other.ts"))).toBe(true);
    expect(problems.some((p) => p.startsWith("server/internal/game/sneaky.go"))).toBe(true);
  });

  it("the repository keeps the boundary", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    expect(glueList(readme).size).toBeGreaterThan(0);
  });
});
