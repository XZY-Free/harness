import { expect, test } from "@playwright/test";
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_NAME,
  E2E_ADMIN_PASSWORD,
} from "../lib/test-support/e2e-credentials";

test("退出后会话立即失效，受保护页面重新进入登录页", async ({ page }) => {
  // 本用例必须撤销自己创建的会话，不能撤销 authentication project 写入、供其余
  // chromium 用例共享的 storageState 会话。
  await page.context().clearCookies();
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fchat$/);
  await page.getByLabel("账号").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("密码").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByLabel("消息输入框")).toBeEnabled({ timeout: 60_000 });

  const expandSidebar = page.getByRole("button", { name: "展开侧栏", exact: true });
  if (await expandSidebar.isVisible()) await expandSidebar.click();
  await page.getByRole("button", { name: E2E_ADMIN_NAME, exact: true }).click();
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();

  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fchat$/);
});
