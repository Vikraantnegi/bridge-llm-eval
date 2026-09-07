import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["rubrics/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
