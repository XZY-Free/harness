import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": resolve(__dirname, ".") };

export default defineConfig({
  resolve: { alias },
  test: {
    // S1（08 同构）：起真实 MySQL 容器供 DB 测试使用。
    globalSetup: ["./lib/db/test/global-setup.ts"],
    // DB 测试共享 container，并发 resetDatabase 会互相清表 → DB 测试串行（singleFork）；
    // 非 DB 测试并发保持速度。用 projects 分离。
    projects: [
      {
        resolve: { alias },
        test: {
          name: "db",
          include: [
            "lib/db/**/*.test.ts",
            "lib/browser/**/*.test.ts",
            "lib/analytics/**/*.test.ts",
            "lib/auth.test.ts",
            "lib/policy/config.test.ts",
            "lib/v11/identity/**/*.test.ts",
            "lib/v11/control-plane/**/*.test.ts",
            "lib/v11/conversation/**/*.test.ts",
            "lib/v11/runtime/**/*.test.ts",
            "lib/v11/capability/**/*.test.ts",
            "lib/v11/catalog/**/*.test.ts",
            "lib/v11/gateway/**/*.test.ts",
            "lib/v11/context/**/*.test.ts",
            "lib/v11/memory/**/*.test.ts",
            "lib/v11/knowledge/**/*.test.ts",
            "lib/v11/workspace/**/*.test.ts",
            "lib/v11/environment/**/*.test.ts",
            "lib/v11/permission/**/*.test.ts",
            "lib/v11/job/**/*.test.ts",
            "lib/v11/evaluation/**/*.test.ts",
            "lib/v11/operations/**/*.test.ts",
            "lib/v11/admin/**/*.test.ts",
            "lib/v11/migration/**/*.test.ts",
          ],
          environment: "node",
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          // resetDatabase TRUNCATE 所有表（60+ 迁移），10s 默认不够。
          hookTimeout: 60000,
          testTimeout: 60000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["**/*.test.ts", "**/*.test.tsx"],
          exclude: [
            "lib/db/**",
            "lib/browser/**",
            "lib/analytics/**",
            "lib/auth.test.ts",
            "lib/policy/config.test.ts",
            "lib/v11/identity/**",
            "lib/v11/control-plane/**",
            "lib/v11/conversation/**",
            "lib/v11/runtime/**",
            "lib/v11/capability/**",
            "lib/v11/catalog/**",
            "lib/v11/gateway/**",
            "lib/v11/context/**",
            "lib/v11/memory/**",
            "lib/v11/knowledge/**",
            "lib/v11/workspace/**",
            "lib/v11/environment/**",
            "lib/v11/permission/**",
            "lib/v11/job/**",
            "lib/v11/evaluation/**",
            "lib/v11/operations/**",
            "lib/v11/admin/**",
            "lib/v11/migration/**",
            "node_modules",
            ".next",
          ],
          environmentMatchGlobs: [
            ["**/*.test.tsx", "happy-dom"],
            ["**/*.test.ts", "node"],
          ],
        },
      },
    ],
  },
});
