import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": resolve(__dirname, ".") };

// 遗留 B1 层测试：测的是 §17 刻意丢弃的旧表（User/Message/ThreadRun/ToolRun/Role/
// policyConfig/GitCheckpoint）。正式链零依赖；按用户
// 决策「未覆盖就不管」排除，代码原样保留。unit project 现有 exclude 已跳过，仅 db project 需要。
// 02-3：retention.test.ts 随 legacy thread 表删除（retention 依赖旧表，02-8 正式重实现）。
const LEGACY_B1_DB_TESTS = ["lib/db/studio-queries.test.ts", "lib/policy/config.test.ts"];

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
            // 02-6 及其后续批：新正式领域的 DB 集成测试也必须走串行（db）project，
            // 否则会在并行 unit project 里 resetDatabase 清表，互相/与 db project 竞争。
            "app/gateway/**/*.test.ts",
            "lib/governance/**/*.test.ts",
            "lib/executions/**/*.test.ts",
            "lib/permission/**/*.test.ts",
            "lib/routes/persistence/**/*.test.ts",
            "lib/policy/config.test.ts",
            "lib/identity/**/*.test.ts",
            "lib/agents/agent-lifecycle.test.ts",
            "lib/agents/application/**/*.test.ts",
            "lib/artifacts/*.test.ts",
            "lib/control-plane/**/*.test.ts",
            "lib/publications/**/*.test.ts",
            "lib/routes/application/**/*.test.ts",
            "lib/runtimes/application/publish-runtime-revision.test.ts",
            "lib/runtimes/application/record-runtime-conformance-run.test.ts",
            "lib/runtimes/runtime-lifecycle.test.ts",
            "lib/conversations/**/*.test.ts",
            "lib/runtime/**/*.test.ts",
            "lib/job/**/*.test.ts",
          ],
          exclude: LEGACY_B1_DB_TESTS,
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
            "app/gateway/**",
            "lib/governance/**",
            "lib/executions/**",
            "lib/permission/**",
            "lib/routes/persistence/**",
            "lib/policy/config.test.ts",
            "lib/identity/**",
            "lib/agents/agent-lifecycle.test.ts",
            "lib/agents/application/**",
            "lib/artifacts/*.test.ts",
            "lib/control-plane/**",
            "lib/publications/**",
            "lib/routes/application/**",
            "lib/runtimes/application/publish-runtime-revision.test.ts",
            "lib/runtimes/application/record-runtime-conformance-run.test.ts",
            "lib/runtimes/runtime-lifecycle.test.ts",
            "lib/conversations/**",
            "lib/runtime/**",
            "lib/job/**",
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
