import { defineConfig } from "vite";
import { editorApi } from "./server/plugin.ts";

export default defineConfig({
  plugins: [editorApi()],
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  server: { port: Number(process.env["EDITOR_PORT"] ?? 5174), strictPort: true },
});
