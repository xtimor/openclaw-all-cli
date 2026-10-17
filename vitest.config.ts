import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 15_000,
    // Live tests share one isolated OpenClaw state; two `openclaw agent` runs at once contend for it.
    fileParallelism: process.env.OPENCLAW_ALL_CLI_LIVE !== "1",
  },
});
