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
