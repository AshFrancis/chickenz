import { defineConfig } from "vite";
import { execSync } from "child_process";

const commitHash = execSync("git rev-parse --short HEAD").toString().trim();
const commitDate = execSync("git log -1 --format=%ci").toString().trim().slice(0, 16);

export default defineConfig({
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
    __COMMIT_DATE__: JSON.stringify(commitDate),
  },
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
