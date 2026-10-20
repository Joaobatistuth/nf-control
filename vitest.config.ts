import path from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "client/src"), "@shared": path.resolve(import.meta.dirname, "shared") } },
  test: { include: ["shared/**/*.test.ts", "netlify/**/*.test.ts", "client/src/**/*.test.tsx"], environment: "node" },
});
