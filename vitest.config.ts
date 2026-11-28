import { defineConfig } from "vitest/config";

const live = process.env.OPENCLAW_ALL_CLI_LIVE === "1";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 15_000,
    // Live and regression tests share one isolated OpenClaw state per run; two `openclaw agent` runs at once contend for it.
    fileParallelism: !live && process.env.OPENCLAW_ALL_CLI_REGRESSION !== "1",
    // A live test drives a real model: it passes when any of its 3 tries passes (epic-regression-gate ticket 4.5), and the
    // live tier's tries reporter (test/live/tries-reporter.ts) records how many it took. Every other test runs once.
    retry: live ? 2 : 0,
  },
});
