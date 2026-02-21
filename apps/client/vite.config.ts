import { defineConfig } from "vite";

export default defineConfig({
  server: {
    open: true,
    fs: {
      allow: ["../.."], // allow monorepo root for WASM pkg access
    },
  },
  build: {
    target: "esnext", // support top-level await for WASM init
  },
});
