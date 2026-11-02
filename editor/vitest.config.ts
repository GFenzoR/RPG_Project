// Unit tests only; e2e/ is Playwright (pnpm --filter @rpg/editor e2e).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts", "server/**/*.test.ts"] },
});
