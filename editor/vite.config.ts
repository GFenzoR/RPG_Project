import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { editorApi } from "./server/plugin.ts";

const dir = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  plugins: [editorApi()],
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  server: {
    port: Number(process.env["EDITOR_PORT"] ?? 5174),
    strictPort: true,
    // Vite's default CORS approves any localhost origin, which would let another local page
    // send the API header (see server/guard.ts) and read files through /@fs/. The editor
    // only talks to its own origin, so CORS stays off.
    cors: false,
    // Serve only the editor and the code it imports, never world/, data/ or local files.
    fs: { strict: true, allow: [dir("./"), dir("../packages/"), dir("../node_modules/")] },
  },
});
