import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // scripts/ had no coverage at all, which is how an untested fallback in the alerting
    // path shipped a bare `Version: viem@2.55.10` as a real Discord alert (CC-085,
    // 2026-08-17). The monitors are the thing that tells us the money path is intact;
    // leaving them as the only untested code was the wrong trade.
    include: ["src/**/__tests__/**/*.test.ts", "scripts/**/__tests__/**/*.test.mjs"],
    // CC-060: strips signing keys and real endpoints from the environment, and blocks
    // global fetch, so the suite cannot reach the network or sign with a real key.
    setupFiles: ["./vitest.setup.ts"],
    // Vitest defaults to 5s. Nothing here is slow — the suite is hermetic and the
    // tests themselves run in milliseconds — but the first `await import()` in each
    // file pays the whole module-graph resolution cost, and on a cold Windows
    // checkout that alone exceeds 5s. Measured 2026-08-26 on an unchanged tree: 30
    // failures, then 16 on a re-run, then 0 at 60s. Every one was `Test timed out`.
    // A suite whose pass/fail depends on machine speed is the CC-060 problem with a
    // different cause, and it is worse for an unattended agent than for a human: red
    // tests invite a "fix" to code that was never broken.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
