/**
 * 收尾轮综合验证（一次性脚本）。
 *
 * 覆盖：
 *  1. nexharness /studio/governance（基线供给后渲染，不再 fail-closed）
 *  2. nexharness /studio/permission-rules（工具权限）
 *  3. nexharness /studio/security（成员角色 → auth-center 管理台外链）
 *  4. console 单智能体访问页：缺行 = 继承平台默认（懒默认语义；运行前已删除策略行）
 *
 * 前置：三服务已起（3100/3101/3210）；console-smoke-agent 存在。
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
const NEX = "http://localhost:3210";
const AC = "http://localhost:3101";
const AGENT_ID = "a0000000-0000-4000-8000-0000000000a1";

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

async function loginNexharness(page) {
  await page.goto(`${NEX}/chat`);
  await page.waitForSelector("#login-account", { timeout: 60000 });
  await page.fill("#login-account", ACCOUNT);
  await page.fill("#login-password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(
    (url) => url.href.startsWith(`${NEX}/chat`) && !url.searchParams.has("ticket"),
    {
      timeout: 60000,
    },
  );
}

async function main() {
  console.log("\n== 收尾轮综合验证 ==\n");
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await loginNexharness(page);

  console.log("[1] /studio/governance（运行保护 · 基线供给后）");
  await page.goto(`${NEX}/studio/governance`);
  await page.waitForSelector("text=运行保护", { timeout: 30000 });
  const govText = await page.locator("body").innerText();
  expect(govText.includes("运行保护"), "渲染运行保护页");
  expect(
    !govText.includes("加载失败"),
    "治理配置加载成功（无 fail-closed 报错）",
    govText.slice(0, 160),
  );

  console.log("[2] /studio/permission-rules（工具权限）");
  await page.goto(`${NEX}/studio/permission-rules`);
  await page.waitForSelector("text=工具权限", { timeout: 30000 });
  const rulesText = await page.locator("body").innerText();
  expect(rulesText.includes("权限规则"), "渲染权限规则区", rulesText.slice(0, 160));

  console.log("[3] /studio/security（成员角色外链）");
  await page.goto(`${NEX}/studio/security`);
  await page.waitForSelector("text=成员角色", { timeout: 30000 });
  const secText = await page.locator("body").innerText();
  expect(secText.includes("前往管理台"), "成员角色行含管理台外链");
  const consoleHref = await page.locator('a:has-text("前往管理台")').first().getAttribute("href");
  expect(consoleHref === `${AC}/console/settings`, "外链指向 auth-center 管理台", consoleHref);
  await page.screenshot({ path: "tmp/final-studio-security.png" });

  console.log("[4] console 访问设置：缺行 = 继承平台默认（懒默认）");
  // 同 context 共享 auth-center 会话：/login 自动续跳回 returnTo。
  const consolePage = await context.newPage();
  await consolePage.goto(`${AC}/login?returnTo=${encodeURIComponent("/console/agents")}`);
  await consolePage.waitForURL(`${AC}/console/agents`, { timeout: 30000 });
  await consolePage.goto(`${AC}/console/agents/${AGENT_ID}`);
  await consolePage.waitForSelector("text=使用范围", { timeout: 30000 });
  await consolePage.waitForSelector("text=保存访问设置", { timeout: 30000 });
  const accessText = await consolePage.locator("body").innerText();
  expect(
    accessText.includes("继承平台默认"),
    "缺行渲染为「继承平台默认」",
    accessText.slice(0, 200),
  );
  // 保存「全体成员」→ 行由保存动作创建（insert 分支）
  await consolePage.click('label:has-text("全体成员")');
  await consolePage.click("text=保存访问设置");
  await consolePage.waitForSelector("text=已保存", { timeout: 30000 });
  expect(true, "缺行保存「全体成员」成功（insert 分支）");
  await consolePage.screenshot({ path: "tmp/final-console-inherit.png" });

  await browser.close();
  console.log(`\n== 结果：${checks - failures}/${checks} 通过 ==\n`);
  if (failures > 0) process.exitCode = 1;
}

void main();
