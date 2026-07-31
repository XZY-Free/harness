/**
 * S10-W08 e2e 测试配置（Playwright）。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md
 *   S10-W08：「Web 用真实浏览器完成端到端任务」「UI 验证使用真实 V11 API 与 MySQL，
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

export default defineConfig({
  testDir: "./e2e",
  // DB 共享单容器 → 串行执行避免 TRUNCATE 竞态（e2e 不 TRUNCATE，但保持简单）
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
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
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
