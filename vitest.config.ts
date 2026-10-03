import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "tools/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Las pruebas de integración levantan impresoras simuladas en puertos
    // propios; se ejecutan en paralelo por archivo sin chocar.
    pool: "forks",
  },
});
