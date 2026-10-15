/**
 * auth-center 管理台浏览器冒烟（一次性脚本，放 nexharness/tmp 以解析 playwright）。
 *
 * 前置：auth-center API(:3100) + vite(:3101) 已启动；dev 库已有测试智能体
 * （console-smoke-agent）。场景：
 *  1. 登录回跳 /console/settings → 平台设置渲染（成员与权限 + 管理员行）
 *  2. /console/agents 列表出现测试智能体
 *  3. 进入访问设置 → 选“全体成员”保存 → 保存成功消息
 *  4. 匿名调用管理台接口 → 401（守卫生效）
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const ACCOUNT = "admin@nexharness.local";
const PASSWORD = readFileSync(
  join(homedir(), ".config", "nexharness", "dev-admin-password.txt"),
  "utf-8",
).trim();
const WEB_BASE = "http://localhost:3101";
const API_BASE = "http://127.0.0.1:3100";

let checks = 0;
let failures = 0;
function expect(condition, label, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 240) : "");
}

async function main() {
  console.log("\n== auth-center 管理台浏览器冒烟 ==\n");
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log("[1] 登录 → /console/settings");
  await page.goto(`${WEB_BASE}/login?returnTo=${encodeURIComponent("/console/settings")}`);
  await page.waitForSelector("#login-account", { timeout: 20000 });
  await page.fill("#login-account", ACCOUNT);
  await page.fill("#login-password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/localhost:3101\/console\/settings$/, { timeout: 30000 });
  // 等待权限视图真正加载完成（成员行出现），再做断言。
  await page.waitForSelector("text=本地管理员", { timeout: 30000 });
  expect(true, "落地 /console/settings");
  const settingsText = await page.locator("body").innerText();
  expect(settingsText.includes("平台设置"), "渲染「平台设置」标题");
  expect(settingsText.includes("成员与权限"), "渲染「成员与权限」分区");
  expect(settingsText.includes("本地管理员"), "用户列表含管理员", settingsText.slice(0, 200));
  expect(settingsText.includes("外观"), "渲染「外观」分区");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "tmp/auth-center-console-settings.png" });
  console.log("  （已截图 console-settings）");

  console.log("[2] /console/agents 智能体列表");
  await page.click('a[href="/console/agents"]');
  await page.waitForSelector("text=控制台冒烟智能体", { timeout: 20000 });
  expect(true, "列表出现测试智能体");

  console.log("[3] 进入访问设置 → 保存「全体成员」");
  await page.click("text=控制台冒烟智能体");
  await page.waitForSelector("text=访问管理", { timeout: 20000 });
  // 等策略加载（保存按钮出现）再做断言与操作。
  await page.waitForSelector("text=保存访问设置", { timeout: 20000 });
  const accessText = await page.locator("body").innerText();
  expect(accessText.includes("使用范围"), "渲染使用范围");
  expect(accessText.includes("协作管理"), "渲染协作管理");
  await page.click("text=全体成员");
  await page.waitForTimeout(200);
  await page.click("text=保存访问设置");
  await page.waitForSelector("text=已保存", { timeout: 20000 });
  expect(true, "保存成功（已保存）");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "tmp/auth-center-console-agent-access.png" });
  console.log("  （已截图 console-agent-access）");

  console.log("[4] 匿名接口守卫");
  const anonymous = await fetch(`${API_BASE}/api/console/settings/permissions`);
  expect(anonymous.status === 401, "匿名访问管理台接口 → 401", anonymous.status);

  await browser.close();
  console.log(`\n== 管理台冒烟：${checks - failures}/${checks} 通过 ==\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(
    "SMOKE ERROR:",
    (error?.message ?? String(error)).split("\n").slice(0, 4).join(" | "),
  );
  process.exit(1);
});
