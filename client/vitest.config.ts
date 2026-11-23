// Unit tests only; e2e/ is Playwright (pnpm --filter @rpg/client e2e).
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The E2E hooks are on in unit tests, as in the dev server (vite.config.ts).
  define: { __RPG_E2E_HOOKS__: "true" },
  test: { include: ["src/**/*.test.ts", "vite/**/*.test.ts"] },
});
