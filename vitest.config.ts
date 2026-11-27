import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 15_000,
    // Live and regression tests share one isolated OpenClaw state per run; two `openclaw agent` runs at once contend for it.
    fileParallelism: process.env.OPENCLAW_ALL_CLI_LIVE !== "1" && process.env.OPENCLAW_ALL_CLI_REGRESSION !== "1",
  },
});
