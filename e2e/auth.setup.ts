import { expect, test as setup } from "@playwright/test";
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD,
  E2E_AUTH_STATE,
} from "../lib/test-support/e2e-credentials";

setup("通过正式登录页建立浏览器会话", async ({ page }) => {
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fchat$/);

  await page.getByLabel("邮箱").fill(E2E_ADMIN_EMAIL);
  await page.getByLabel("密码").fill("错误密码");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("邮箱或密码错误", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fchat$/);

  await page.getByLabel("密码").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByLabel("消息输入框")).toBeEnabled({ timeout: 60_000 });

  await page.context().storageState({ path: E2E_AUTH_STATE });
});
