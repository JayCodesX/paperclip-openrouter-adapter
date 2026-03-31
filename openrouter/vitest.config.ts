import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    globalSetup: ["tests/global-setup.ts"],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/test-delete-later/**",
    ],
  },
});
