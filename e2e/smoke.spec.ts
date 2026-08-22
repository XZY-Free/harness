/**
 * Web 冒烟测试。
 *
 * 职责：
 * - 验证 Next.js dev server 在真实 MySQL + drizzle migration 环境下能正常启动。
 * - 验证核心路由可被浏览器访问且无 5xx。
 *
 * 边界说明：
 * - 完整执行链（Thread → Turn → Invocation → ExecutionBinding → Event → Agent 回复）
 *   由 `e2e/web-execution-chain.spec.ts` 覆盖（§20.4）。
 * - Desktop 不再有服务端 `/desktop` 页面：Electron 主进程从本机打包 renderer 加载 UI，
 *   服务端只处理 API/SSE（见 `desktop/main/index.ts`）。Desktop 覆盖见
 *   `e2e/desktop-execution-chain.spec.ts`（§20.5）。
 *
 * 运行：
 *   pnpm test:e2e
 */
import { expect, test } from "@playwright/test";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("首页 / 重定向到新会话页 /chat（§33.7，无 /chat/new 假路由）", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(/\/chat$/);
});

test("/chat 渲染新会话页（可输入）", async ({ page }) => {
  const response = await page.goto("/chat");
  expect(response?.status()).toBeLessThan(400);
  // 助手列表加载完成后输入框可用——证明 GET /api/v1/threads 正常返回。
  await expect(page.getByLabel("消息输入框")).toBeEnabled({ timeout: 60_000 });
});

test("/chat/<uuid> 渲染会话页（无 5xx）", async ({ page }) => {
  // DB 中不存在的合法 UUID：页面应正常渲染（不是 500）。
  const candidateId = "00000000-0000-4000-8000-000000000000";
  expect(candidateId).toMatch(UUID_REGEX);
  const response = await page.goto(`/chat/${candidateId}`);
  expect(response?.status()).toBeLessThan(500);
  await expect(page.locator("body")).toBeVisible();
});
