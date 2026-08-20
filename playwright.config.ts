/**
 * S10-W08 e2e 测试配置（Playwright）。
 *
 * 事实源：
 * - docs/architecture/conversations.md
 *   S10-W08：「Web 用真实浏览器完成端到端任务」「UI 验证使用正式 Conversation API 与 MySQL，
 *           不用静态 HTML、截图或 typed mock 代替完成」
 *
 * 职责：
 * - 定义 e2e 测试目录（./e2e）与浏览器项目（chromium）。
 * - 通过 webServer 启动 MySQL 容器 + Next.js dev server（scripts/e2e-start.mts）。
 * - 复用已有 server（dev 模式）以加速本地迭代；CI 强制新建。
 *
 * 使用：
 *   pnpm test:e2e            # 运行全部 e2e
 *   pnpm test:e2e -- --ui    # 带 UI 模式
 *   pnpm test:e2e -- --grep "冒烟"  # 按名称过滤
 *
 * 注意：
 * - e2e 测试需要 Docker（testcontainers 启动 MySQL）。
 * - 首次运行会拉取 mysql:8.0 镜像，耗时较长。
 * - webServer.timeout=180s 容纳 MySQL 启动 + migration + Next.js 首次编译。
 */
import { defineConfig, devices } from "@playwright/test";

/**
 * e2e 专用端口。
 *
 * 刻意不用 3000：开发者本机常驻 `pnpm dev` 占用 3000，若与之冲突，
 * e2e 会误连开发库并跳过正式链引导。独立端口保证本地与 CI 行为一致。
 */
export const E2E_PORT = Number(process.env.SNOW_E2E_PORT ?? 3100);
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // DB 共享单容器 → 串行执行避免 TRUNCATE 竞态（e2e 不 TRUNCATE，但保持简单）
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  // 正式执行链用例要等真实 Agent Loop 产出回复（模型流式 + Event 落库 + SSE 收敛），
  // 默认 30s 不够；Electron 启动本身也要十几秒。
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: E2E_ORIGIN,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm exec tsx scripts/e2e-start.mts",
    url: E2E_ORIGIN,
    // 必须始终新建：e2e 依赖 scripts/e2e-start.mts 引导出的正式执行链
    // （enabled Agent → published Revision → Route → Projection）。
    // 复用开发者本机 dev server 会跳过引导，测试将跑在开发库上而非干净容器上，
    // 结论不可信（曾实际发生）。
    reuseExistingServer: false,
    // 引导与确定性模型服务的日志需要可见：CI 与人工都靠它判断回复是否正常。
    stdout: "pipe",
    stderr: "pipe",
    // 容纳 MySQL 容器启动 + migration + 正式链引导 + next build。
    timeout: 900_000,
  },
});
