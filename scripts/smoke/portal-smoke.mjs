/**
 * auth-center 门户浏览器全链路冒烟（一次性脚本）。
 *
 * 放在 nexharness/tmp/ 以便从 nexharness node_modules 解析 playwright
 * （auth-center 暂未引入 playwright 依赖）。
 *
 * 前置：auth-center API(:3100) 与 vite 门户(:3101) 已启动；
 * 脚本自行在 :3299 起一个"消费方目标"页（需在 AUTH_CENTER_ALLOWED_ORIGINS 中）。
 *
 * 场景：
 *  1. 匿名访问 /login?returnTo=http://localhost:3299/app → 渲染登录表单（品牌 NexHarness）
 *  2. 填账号密码提交 → 浏览器导航到 http://localhost:3299/app?ticket=T1
 *  3. 服务端（node fetch）兑换 T1 → 200 + principal.email
 *  4. 已有会话二次访问 /login?returnTo=.../app2 → 自动续跳 → T2（≠T1）→ 兑换成功
 *  5. 门户首页 /（共用 cookie）→ 显示已登录
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const ACCOUNT = process.env.SMOKE_ADMIN_ACCOUNT ?? "admin@nexharness.local";
const PASSWORD = readFileSync(
  process.env.SMOKE_ADMIN_PASSWORD_FILE ??
    join(homedir(), ".config", "nexharness", "dev-admin-password.txt"),
  "utf-8",
).trim();
const CONSUMER_BASE = "http://localhost:3299";
const API_BASE = "http://127.0.0.1:3100";
const WEB_BASE = "http://localhost:3101";

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

const consumer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><html><body><h1>consumer target</h1></body></html>");
});

async function resolveTicket(ticket) {
  const response = await fetch(`${API_BASE}/api/session/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function main() {
  await new Promise((resolve) => consumer.listen(3299, resolve));
  console.log("consumer target listening on :3299");
  console.log("\n== auth-center 门户浏览器冒烟 ==\n");

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("[1] 匿名访问登录页（外部 returnTo）");
  await page.goto(`${WEB_BASE}/login?returnTo=${encodeURIComponent(`${CONSUMER_BASE}/app`)}`);
  await page.waitForSelector("#login-account", { timeout: 20000 });
  expect(true, "登录表单渲染");
  const mainText = await page.locator("main").first().innerText();
  expect(mainText.includes("NexHarness"), "品牌名渲染", mainText.slice(0, 80));

  console.log("[2] 提交登录 → 消费方回跳（携带 ticket）");
  await page.fill("#login-account", ACCOUNT);
  await page.fill("#login-password", PASSWORD);
  await Promise.all([
    page.waitForURL(/localhost:3299\/app\?ticket=/, { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  const url1 = new URL(page.url());
  const ticket1 = url1.searchParams.get("ticket");
  expect(url1.origin === CONSUMER_BASE && url1.pathname === "/app", "命中消费方地址", page.url());
  expect(Boolean(ticket1), "URL 携带 ticket");

  console.log("[3] 服务端兑换 T1");
  const r1 = await resolveTicket(ticket1);
  expect(
    r1.status === 200 && r1.body?.principal?.email === ACCOUNT,
    "T1 兑换成功（principal 一致）",
    r1.body,
  );

  console.log("[4] 已有会话二次访问（自动续跳 · 新票据）");
  await page.goto(`${WEB_BASE}/login?returnTo=${encodeURIComponent(`${CONSUMER_BASE}/app2`)}`);
  await page.waitForURL(/localhost:3299\/app2\?ticket=/, { timeout: 30000 });
  const url2 = new URL(page.url());
  const ticket2 = url2.searchParams.get("ticket");
  expect(Boolean(ticket2), "自动续跳携带 ticket");
  expect(ticket2 !== ticket1, "票据不复用（一次性）");
  const r2 = await resolveTicket(ticket2);
  expect(r2.status === 200, "T2 兑换成功", r2.status);

  console.log("[5] 门户首页（共用 cookie）");
  await page.goto(`${WEB_BASE}/`);
  await page.waitForSelector("text=已登录", { timeout: 20000 });
  expect(true, "首页显示已登录");

  await browser.close();
  consumer.close();
  console.log(`\n== 门户冒烟：${checks - failures}/${checks} 通过 ==\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(
    "SMOKE ERROR:",
    (error?.message ?? String(error)).split("\n").slice(0, 4).join(" | "),
  );
  consumer.close();
  process.exit(1);
});
