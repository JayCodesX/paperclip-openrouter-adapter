import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration tests that spawn a real orager process (full-pipeline) can
    // take well over 90 s when competing for CPU with parallel test files.
    // Set a generous global ceiling; individual tests override with IT / IT_SLOW.
    testTimeout: 120_000,
  },
});
