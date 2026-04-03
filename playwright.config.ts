import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun services/server/src/index.ts",
    url: "http://localhost:3000/api/ping",
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
    env: {
      SERVER_REGION: "us",
      CANONICAL_HOST: "localhost",
    },
  },
});
