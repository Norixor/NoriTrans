import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  outputDir: "test-results",
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
});
