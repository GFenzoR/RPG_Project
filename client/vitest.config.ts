// Unit tests only; e2e/ is Playwright (pnpm --filter @rpg/client e2e).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts", "vite/**/*.test.ts"] },
});
