// Checks that run full Vite builds (slow: tens of seconds each). They run in `make lint`
// (pnpm --filter @rpg/client test:build), not in `make test`, which stays fast.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["vite/**/*.buildtest.ts"] },
});
