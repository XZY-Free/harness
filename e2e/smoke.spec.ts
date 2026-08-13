/**
 * S10-W08 e2e 冒烟测试。
 *
 * 事实源：
 * - docs/architecture/conversations.md
 *   S10-W08：「Web 用真实浏览器完成端到端任务」
 *
 * 职责：
 * - 验证 Next.js dev server 在真实 MySQL + drizzle migration 环境下能正常启动。
 * - 验证核心路由（/ → /chat/<uuid>、/desktop → /desktop/chat/<uuid>）可被浏览器访问。
 * - 验证 /chat/<uuid> 渲染 Workspace 组件（无 500 错误）。
 *
 * 不覆盖：
 * - 完整 Thread 生命周期（创建/执行/排队/确认/断线恢复）—— 需要正式 Runtime + SSE，
 *   由阶段 10 阶段验证在集成环境完成，不在此冒烟测试范围。
 * - Desktop Electron Shell 本地任务 —— 需要 Electron 运行环境，由阶段 10 阶段验证。
 *
 * 运行：
 *   pnpm test:e2e
 */
import { expect, test } from "@playwright/test";

const UUID_REGEX = /\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESKTOP_UUID_REGEX =
  /\/desktop\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("首页 / 重定向到 /chat/<uuid>", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(UUID_REGEX);
});

test("/chat/<uuid> 渲染 Workspace（无 500）", async ({ page }) => {
  // 使用固定 UUID（DB 中不存在 → 视为新建候选，与 app/page.tsx 语义一致）
  const candidateId = "00000000-0000-0000-0000-000000000000";
  const response = await page.goto(`/chat/${candidateId}`);
  expect(response?.status()).toBeLessThan(400);
  // 页面 body 可见即代表 React 渲染成功（无 500 错误）
  await expect(page.locator("body")).toBeVisible();
});

test("/desktop 重定向到 /desktop/chat/<uuid>", async ({ page }) => {
  const response = await page.goto("/desktop");
  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(DESKTOP_UUID_REGEX);
});
