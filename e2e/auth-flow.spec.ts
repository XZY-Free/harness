import { expect, test } from "@playwright/test";
import { E2E_ADMIN_NAME } from "../lib/test-support/e2e-credentials";

test("退出后会话立即失效，受保护页面重新进入登录页", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByLabel("消息输入框")).toBeEnabled({ timeout: 60_000 });

  const expandSidebar = page.getByRole("button", { name: "展开侧栏", exact: true });
  if (await expandSidebar.isVisible()) await expandSidebar.click();
  await page.getByRole("button", { name: E2E_ADMIN_NAME, exact: true }).click();
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();

  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fchat$/);
});
