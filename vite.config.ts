import { defineConfig } from "vite";

// GitHub Pages serves this project site from https://<user>.github.io/aether/,
// so production assets must be referenced under that sub-path. The dev server
// keeps base "/" for a clean local URL.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/aether/" : "/",
}));
