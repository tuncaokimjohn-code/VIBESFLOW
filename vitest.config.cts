const path = require("node:path");
const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
  // CommonJS config (.cts): Vite compiles the bundled config in-memory via
  // require, so no ESM temp file is written next to the shared node_modules
  // (Finding C). Keep Vitest's dep-optimizer/results cache inside the
  // candidate so test runs never write into the shared symlinked tree.
  cacheDir: path.resolve(__dirname, ".vitest-cache"),
  test: { setupFiles: [path.resolve(__dirname, "offline.setup.ts")] },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // Next enforces this poison import in application builds. Offline unit
      // tests use an explicit stub, never a replacement in production config.
      "server-only": path.resolve(__dirname, "test-support/server-only.ts"),
    },
  },
});
