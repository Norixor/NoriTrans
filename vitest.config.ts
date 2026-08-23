import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["./tests/**/*.test.ts"],
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
  resolve: {
    alias: {
      "@": new URL(".", import.meta.url).pathname,
    },
  },
});
