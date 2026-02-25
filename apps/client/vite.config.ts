import { defineConfig, loadEnv } from "vite";
import { resolve } from "path";
import { execSync } from "child_process";
import fs from "fs";

let commitHash = "unknown";
let commitDate = "";
try {
  commitHash = execSync("git rev-parse --short HEAD").toString().trim();
  commitDate = execSync("git log -1 --format=%ci").toString().trim().slice(0, 16);
} catch {
  // git not available (Docker, CI artifacts, tarballs)
}

const env = loadEnv("development", resolve(__dirname, "../.."), "VITE_");

export default defineConfig({
  envDir: resolve(__dirname, "../.."), // load .env from monorepo root
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
    __COMMIT_DATE__: JSON.stringify(commitDate),
  },
  server: {
    host: true,
    open: true,
    allowedHosts: ["chickenz.local"],
    https: {
      key: fs.readFileSync(resolve(__dirname, "certs/chickenz.local-key.pem")),
      cert: fs.readFileSync(resolve(__dirname, "certs/chickenz.local.pem")),
    },
    proxy: {
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
        changeOrigin: true,
      },
      "/relayer": {
        target: "https://channels.openzeppelin.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/relayer/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            const apiKey = env.VITE_RELAYER_API_KEY;
            if (apiKey) {
              proxyReq.setHeader("Authorization", `Bearer ${apiKey}`);
            }
          });
        },
      },
    },
    fs: {
      allow: ["../.."], // allow monorepo root for WASM pkg access
    },
  },
  build: {
    target: "esnext", // support top-level await for WASM init
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        editor: resolve(__dirname, "editor.html"),
      },
    },
  },
});
