import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import {
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_NAME,
  E2E_ADMIN_PASSWORD,
} from "../lib/test-support/e2e-credentials";
import { type LaunchedDesktop, launchDesktopApp } from "./support/launch-desktop";

const captureUi = process.env.SNOW_CAPTURE_UI === "1";
const captureDir = resolve(process.cwd(), "output/login-design-qa");

async function capture(window: Page, name: string): Promise<void> {
  if (!captureUi) return;
  mkdirSync(captureDir, { recursive: true });
  await window.screenshot({ path: resolve(captureDir, name) });
}

test.describe("Desktop 登录闭环", () => {
  let desktop: LaunchedDesktop;
  let window: Page;

  test.beforeAll(async () => {
    desktop = await launchDesktopApp();
    window = await desktop.app.firstWindow();
  });

  test.afterAll(async () => {
    await desktop?.dispose();
  });

  test("未登录 → 失败反馈 → 登录 → 退出 → 回到登录页", async () => {
    await expect(window.getByRole("heading", { name: "登录" })).toBeVisible({
      timeout: 90_000,
    });
    await expect(window.getByText("SnowHarness", { exact: true })).toHaveCount(1);
    await expect(window.getByText(/管理员/)).toHaveCount(0);
    await capture(window, "01-desktop-login.png");

    for (const size of [
      { width: 1280, height: 800 },
      { width: 1024, height: 700 },
    ]) {
      await desktop.app.evaluate(({ BrowserWindow }, nextSize) => {
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (!mainWindow) throw new Error("Desktop 主窗口不存在");
        mainWindow.setSize(nextSize.width, nextSize.height);
      }, size);
      await expect(window.getByLabel("邮箱")).toBeVisible();
      await expect(window.getByRole("button", { name: "登录" })).toBeVisible();
      expect(
        await window.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth),
      ).toBe(true);
    }
    await capture(window, "02-desktop-login-min-size.png");

    await window.getByLabel("邮箱").fill(E2E_ADMIN_EMAIL);
    await window.getByLabel("密码").fill("wrong-password");
    await window.getByRole("button", { name: "登录" }).click();
    await expect(window.getByRole("alert")).toHaveText("邮箱或密码错误");

    await window.getByLabel("密码").fill(E2E_ADMIN_PASSWORD);
    await window.getByRole("button", { name: "登录" }).click();
    await expect(window.getByLabel("消息输入框")).toBeEnabled({ timeout: 90_000 });

    const sidebarTrigger = window.getByRole("button", { name: "展开侧栏" });
    await expect(sidebarTrigger).toBeVisible();
    await sidebarTrigger.click();
    await window.getByRole("button", { name: E2E_ADMIN_NAME }).click();
    await window.getByRole("menuitem", { name: "退出登录" }).click();

    await expect(window.getByRole("heading", { name: "登录" })).toBeVisible({
      timeout: 90_000,
    });
    await expect(window.getByLabel("邮箱")).toHaveValue("");
    await capture(window, "03-desktop-after-logout.png");
  });
});
