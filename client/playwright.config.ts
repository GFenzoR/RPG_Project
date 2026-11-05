// E2E for the game client: starts the game server (Go) on the compiled test map
// (world/ → build/world.bin, island testisle) against Postgres, and the client's Vite dev
// server proxying /api and /ws to it. Postgres must be running (make db-up); the server
// applies migrations itself. Screenshots go to e2e/screenshots/actual/ (git-ignored).
import { defineConfig, devices } from "@playwright/test";

const serverPort = Number(process.env["CLIENT_E2E_SERVER_PORT"] ?? 18080);
const clientPort = Number(process.env["CLIENT_E2E_PORT"] ?? 5176);
export const databaseUrl =
  process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/rpg";
export const serverURL = `http://localhost:${serverPort}`;
// A second server whose start island is Puerto, like production (T4.2: a new character
// starts there with no town and gets the tutorial), with its own Vite.
const puertoServerPort = Number(process.env["CLIENT_E2E_PUERTO_SERVER_PORT"] ?? 18081);
const puertoClientPort = Number(process.env["CLIENT_E2E_PUERTO_PORT"] ?? 5177);
export const puertoServerURL = `http://localhost:${puertoServerPort}`;
export const puertoClientURL = `http://localhost:${puertoClientPort}`;

export default defineConfig({
  testDir: "e2e",
  outputDir: "../test-results/client",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${clientPort}`,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // mapcompile first, so `pnpm --filter @rpg/client e2e` works on its own too.
      command:
        "go run ./cmd/mapcompile -root .. -out ../build/world.bin && " +
        // Every test registers and logs in from 127.0.0.1: raise the per-IP auth burst so the
        // suite does not depend on how fast it runs (production keeps the default).
        `go run ./cmd/gameserver -http :${serverPort} -world ../build/world.bin -seed 1 -auth-rate-burst 1000 -start-town testisle -boat-routes ../client/e2e/fixtures/boat_routes.yaml`,
      cwd: `${import.meta.dirname}/../server`,
      url: `${serverURL}/healthz`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { DATABASE_URL: databaseUrl },
      stdout: "pipe",
    },
    {
      command: `pnpm exec vite --port ${clientPort} --strictPort`,
      cwd: import.meta.dirname,
      url: `http://localhost:${clientPort}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { RPG_SERVER: serverURL },
    },
    {
      // Its own world.bin: both servers compile the map at the same time.
      command:
        "go run ./cmd/mapcompile -root .. -out ../build/world-puerto.bin && " +
        `go run ./cmd/gameserver -http :${puertoServerPort} -world ../build/world-puerto.bin -seed 1 -auth-rate-burst 1000 -start-town puerto -metrics-addr ""`,
      cwd: `${import.meta.dirname}/../server`,
      url: `${puertoServerURL}/healthz`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { DATABASE_URL: databaseUrl },
      stdout: "pipe",
    },
    {
      command: `pnpm exec vite --port ${puertoClientPort} --strictPort`,
      cwd: import.meta.dirname,
      url: `${puertoClientURL}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { RPG_SERVER: puertoServerURL },
    },
  ],
});
