import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
    // Shared CI runners (Windows above all) can take seconds over a database-heavy test that runs in milliseconds
    // here, so CI gets more room; locally the default 5 s still catches a test that hangs.
    ...(process.env.CI ? { testTimeout: 30_000 } : {}),
  },
});
