/**
 * nexharness-client（Vite SPA）冒烟（一次性脚本）。
 *
 * 前置：auth-center API(:3100) + vite(:3101)、nexharness dev(:3210)、client dev(:5173) 已启动；
 *       auth-center 允许名单含 http://localhost:5173。
 *
 * 覆盖：
 *  0. 未登录访问 /studio → 触发 SPA /login → auth-center 登录页（returnTo 正确）
 *  1. 登录 → 票据回跳 5173 → /api/session/exchange 落地 → 干净 URL 渲染 /chat
 *  2. 会话复用；/api/user/current 经代理返回登录用户
 *  3. /studio 总览（StudioShell context）
 *  4. audit / governance / skills / resources / agents/[id] / settings 抽样
 *  5. 未登录再次访问 /studio（负向）
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
const NEX = "http://localhost:5173";
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
  console.log("\n== nexharness-client（Vite SPA）冒烟 ==\n");
  const browser = await chromium.launch();

  // [0] 未登录访问 /studio → 登录跳转
  {
    const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const anonPage = await anon.newPage();
    console.log("[0] 未登录访问 /studio");
    await anonPage.goto(`${NEX}/studio`);
    await anonPage.waitForSelector("#login-account", { timeout: 60000 });
    expect(anonPage.url().startsWith(`${AC}/login`), "落在 auth-center 登录页", anonPage.url());
    const returnTo = new URL(anonPage.url()).searchParams.get("returnTo");
    expect(returnTo === `${NEX}/studio`, "returnTo 指向 SPA /studio", returnTo);
    await anon.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // [1] 登录 → 票据回跳 → exchange 落地
  console.log("[1] 登录 → 票据回跳 → /api/session/exchange");
  await loginNexharness(page);
  expect(true, "落地 /chat 且 ticket 已清除", page.url());
  await page.waitForSelector("textarea", { timeout: 40000 });
  expect(true, "/chat 渲染（textarea 就绪）");
  const me = await page.evaluate(async () => {
    const response = await fetch("/api/user/current");
    return { status: response.status, body: await response.json().catch(() => null) };
  });
  expect(
    me.status === 200 && me.body?.user?.email === ACCOUNT,
    "user/current（经代理）返回登录用户",
    me.body,
  );
  await page.screenshot({ path: "tmp/client-spa-chat.png" });

  // [2] 会话复用
  console.log("[2] 二次访问复用会话");
  await page.goto(`${NEX}/chat`);
  await page.waitForSelector("textarea", { timeout: 40000 });
  expect(!page.url().includes("login"), "复用会话直接进入 /chat");

  // [3] /studio 总览
  console.log("[3] /studio 总览");
  await page.goto(`${NEX}/studio`);
  await page.waitForSelector("text=启用中的技能", { timeout: 60000 });
  const overview = await page.locator("body").innerText();
  expect(!overview.includes("无法访问"), "StudioShell context 门禁通过");
  expect(overview.includes("平台设置"), "导航渲染（菜单可见性下发）");
  await page.screenshot({ path: "tmp/client-spa-studio.png" });

  // [4] 页面抽样
  console.log("[4] 页面抽样");
  await page.goto(`${NEX}/studio/audit`);
  await page.waitForSelector("section[aria-label='最近记录']", { timeout: 30000 });
  expect(true, "audit 页加载");

  await page.goto(`${NEX}/studio/governance`);
  await page.waitForSelector("textarea", { timeout: 30000 });
  expect(true, "governance 编辑器加载");

  await page.goto(`${NEX}/studio/skills`);
  await page.waitForSelector("text=技能", { timeout: 30000 });
  await page.waitForTimeout(600);
  const skillsText = await page.locator("body").innerText();
  expect(
    skillsText.includes("studio-smoke-skill") || skillsText.includes("暂无技能"),
    "skills 列表加载",
  );

  await page.goto(`${NEX}/studio/resources`);
  await page.waitForTimeout(1200);
  const resText = await page.locator("body").innerText();
  expect(resText.includes("智能体") && !resText.includes("无法访问"), "resources 工作区加载");

  await page.goto(`${NEX}/studio/agents/${AGENT_ID}`);
  await page.waitForSelector("text=登记状态", { timeout: 30000 });
  expect((await page.locator("body").innerText()).includes("控制台冒烟智能体"), "agent 详情渲染");

  await page.goto(`${NEX}/studio/settings`);
  await page.waitForSelector("text=平台设置", { timeout: 30000 });
  const setHref = await page
    .locator('a:has-text("前往管理台")')
    .first()
    .getAttribute("href")
    .catch(() => null);
  expect(setHref === `${AC}/console/settings`, "settings 外链（context 下发）", setHref);

  // [5] 未登录负向（新上下文）
  console.log("[5] 未登录负向（新上下文）");
  {
    const anon = await browser.newContext();
    const anonPage = await anon.newPage();
    await anonPage.goto(`${NEX}/studio/audit`);
    await anonPage.waitForSelector("#login-account", { timeout: 60000 });
    expect(
      anonPage.url().startsWith(`${AC}/login`),
      "未登录访问 /studio/audit 触发登录",
      anonPage.url(),
    );
    await anon.close();
  }

  await browser.close();
  console.log(`\n== 结果：${checks - failures}/${checks} 通过 ==\n`);
  if (failures > 0) process.exitCode = 1;
}

void main();
