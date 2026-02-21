import { defineConfig } from "vite";

export default defineConfig({
  server: {
    open: true,
    fs: {
      allow: ["../.."], // allow monorepo root for WASM pkg access
    },
  },
});
