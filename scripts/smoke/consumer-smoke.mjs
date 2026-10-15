/**
 * nexharness × auth-center 消费方联调冒烟（一次性脚本）。
 *
 * 前置：
 * - auth-center API(:3100) + vite(:3101) 已启动（允许名单含 http://localhost:3210）。
 * - nexharness dev(:3210, NEX_AUTH_CENTER_URL=http://localhost:3101) 已启动。
 *
 * 场景：
 *  1. 未登录访问 /chat → /login 302 → auth-center 登录页（returnTo=nexharness 原地址）
 *  2. 登录 → 票据回跳 ?ticket= → middleware 兑换落地 → 干净 URL 渲染 /chat
 *  3. /api/user/current 经 auth-center introspect 返回登录用户
 *  4. 二次访问复用会话（不再触发登录）
 *  5. /studio 经实时 authorize 门禁渲染（admin）
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
  console.log("\n== nexharness × auth-center 消费方联调冒烟 ==\n");
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log("[1] 未登录 /chat → auth-center 登录页");
  await page.goto(`${NEX}/chat`);
  await page.waitForSelector("#login-account", { timeout: 60000 });
  expect(page.url().startsWith(`${AC}/login`), "落在 auth-center 登录页", page.url());
  const returnTo = new URL(page.url()).searchParams.get("returnTo");
  expect(returnTo === `${NEX}/chat`, "returnTo 指向 nexharness 原地址", returnTo);

  console.log("[2] 登录 → 票据回跳 → 兑换落地");
  await page.fill("#login-account", ACCOUNT);
  await page.fill("#login-password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(
    (url) => url.href.startsWith(`${NEX}/chat`) && !url.searchParams.has("ticket"),
    { timeout: 60000 },
  );
  expect(true, "落地 /chat 且 ticket 已清除", page.url());
  await page.waitForSelector("textarea", { timeout: 40000 });
  expect(true, "/chat 渲染（textarea 就绪）");
  await page.screenshot({ path: "tmp/consumer-chat.png" });

  console.log("[3] /api/user/current（经 auth-center introspect）");
  const me = await page.evaluate(async () => {
    const response = await fetch("/api/user/current");
    return { status: response.status, body: await response.json().catch(() => null) };
  });
  expect(
    me.status === 200 && me.body?.user?.email === ACCOUNT,
    "user/current 返回登录用户",
    me.body,
  );

  console.log("[4] 二次访问复用会话");
  await page.goto(`${NEX}/chat`);
  await page.waitForSelector("textarea", { timeout: 40000 });
  expect(!page.url().includes("login"), "复用会话直接进入 /chat");
  expect(page.url().includes(`${NEX}/chat`), "地址保持在 nexharness");

  console.log("[5] /studio（实时 authorize 门禁）");
  await page.goto(`${NEX}/studio`);
  await page.waitForSelector("text=总览", { timeout: 60000 });
  const studioText = await page.locator("body").innerText();
  expect(!studioText.includes("无法访问"), "admin 通过 studio.access 门禁");
  expect(studioText.includes("智能体"), "studio 渲染导航/内容", studioText.slice(0, 200));
  await page.screenshot({ path: "tmp/consumer-studio.png" });

  await browser.close();
  console.log(`\n== 消费方联调冒烟：${checks - failures}/${checks} 通过 ==\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(
    "SMOKE ERROR:",
    (error?.message ?? String(error)).split("\n").slice(0, 4).join(" | "),
  );
  process.exit(1);
});
