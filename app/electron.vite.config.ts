import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve(__dirname, "main/index.ts") } } },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "preload/index.ts") },
        // Sandboxed preloads must be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "jarvis-window"),
    build: { rollupOptions: { input: { index: resolve(__dirname, "jarvis-window/index.html") } } },
    plugins: [react()],
  },
});
