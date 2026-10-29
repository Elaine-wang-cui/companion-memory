import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "sql-text",
      transform(_code: string, id: string) {
        if (id.endsWith(".sql")) return { code: `export default ${JSON.stringify(readFileSync(id, "utf8"))};`, map: null };
      },
    },
  ],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
