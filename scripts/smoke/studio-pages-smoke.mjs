/**
 * Studio 页面数据 API 化冒烟（一次性脚本）。
 *
 * 覆盖（页面数据 API 化改造后）：
 *  0. 未登录访问 /studio → 跳转 auth-center 登录页（returnTo 正确）
 *  1. /studio 总览（客户端拉取计数）
 *  2. /studio/audit（/studio/api/audit）
 *  3. /studio/governance（/studio/api/governance + 编辑器）
 *  4. /studio/permission-rules（/studio/api/permission-rules + 编辑器）
 *  5. /studio/skills 列表（?withSync=1；含建技能 → 详情页）
 *  6. /studio/resources（快照轻量断言 + 工作区）
 *  7. /studio/agents/[id] 详情（control-plane-client 拉取）
 *  8. /studio/operations · /studio/runtime · /studio/security · /studio/settings
 *  9. /studio/capabilities · /studio/observability（静态页）
 * 10. /chat（AuthGate 客户端门禁）
 *
 * 前置：三服务已起（auth-center 3100/3101 + nexharness 3210）。
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
const SKILL_NAME = "studio-smoke-skill";

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
  console.log("\n== Studio 页面数据 API 化冒烟 ==\n");
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
    expect(returnTo === `${NEX}/studio`, "returnTo 指向 /studio", returnTo);
    await anon.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await loginNexharness(page);

  // [1] /studio 总览
  console.log("[1] /studio 总览（客户端计数）");
  await page.goto(`${NEX}/studio`);
  await page.waitForSelector("text=启用中的技能", { timeout: 60000 });
  const overviewText = await page.locator("body").innerText();
  expect(!overviewText.includes("无法访问"), "admin 通过门禁（StudioShell context）");
  expect(overviewText.includes("智能体"), "渲染资源计数区", overviewText.slice(0, 160));
  expect(overviewText.includes("平台设置"), "导航含「平台设置」（菜单可见性下发）");
  await page.screenshot({ path: "tmp/studio-shell-overview.png" });

  // [2] /studio/audit
  console.log("[2] /studio/audit（/studio/api/audit）");
  await page.goto(`${NEX}/studio/audit`);
  await page.waitForSelector("section[aria-label='最近记录']", { timeout: 30000 });
  await page.waitForTimeout(800);
  const auditText = await page.locator("body").innerText();
  const auditTable = await page.locator("table").count();
  expect(auditText.includes("最近记录"), "渲染操作记录区");
  expect(auditTable > 0 || auditText.includes("暂无"), "审计表或空态就绪", auditText.slice(0, 160));

  // [3] /studio/governance
  console.log("[3] /studio/governance（/studio/api/governance）");
  await page.goto(`${NEX}/studio/governance`);
  await page.waitForSelector("text=保护规则", { timeout: 30000 });
  await page.waitForSelector("textarea", { timeout: 30000 });
  const govText = await page.locator("body").innerText();
  expect(!govText.includes("加载失败") && !govText.includes("无法访问"), "治理编辑器加载成功");
  await page.screenshot({ path: "tmp/studio-shell-governance.png" });

  // [4] /studio/permission-rules
  console.log("[4] /studio/permission-rules（/studio/api/permission-rules）");
  await page.goto(`${NEX}/studio/permission-rules`);
  await page.waitForSelector("text=权限规则", { timeout: 30000 });
  await page.waitForTimeout(800);
  const rulesText = await page.locator("body").innerText();
  expect(
    !rulesText.includes("加载失败") && !rulesText.includes("无法访问"),
    "权限规则编辑器加载成功",
  );

  // [5] /studio/skills 列表 + 建技能 + 详情
  console.log("[5] /studio/skills（?withSync=1）");
  const created = await page.evaluate(async (name) => {
    const response = await fetch("/studio/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description: "阶段③前置改造冒烟用（可删）" }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, SKILL_NAME);
  expect(
    created.status === 200 || created.status === 409,
    `建技能（200 新建 / 409 已存在），实际 ${created.status}`,
    created.body,
  );

  await page.goto(`${NEX}/studio/skills`);
  await page.waitForSelector("text=技能", { timeout: 30000 });
  await page.waitForTimeout(800);
  const skillsText = await page.locator("body").innerText();
  expect(
    skillsText.includes(SKILL_NAME) || skillsText.includes("暂无技能"),
    "技能列表加载",
    skillsText.slice(0, 160),
  );
  const skillLink = page.locator(`a:has-text("${SKILL_NAME}")`).first();
  if ((await skillLink.count()) > 0) {
    const href = await skillLink.getAttribute("href");
    const skillId = href?.split("/").pop();
    console.log("    技能详情：", skillId);
    await page.goto(`${NEX}/studio/skills/${skillId}`);
    await page.waitForSelector("text=版本记录", { timeout: 30000 });
    const detailText = await page.locator("body").innerText();
    expect(detailText.includes(SKILL_NAME), "技能详情渲染（标题）");
    expect(detailText.includes("本地创建"), "详情元信息（本地创建）");
    expect(detailText.includes("版本内容对比"), "详情区块完整");
    await page.screenshot({ path: "tmp/studio-shell-skill-detail.png" });
  } else {
    expect(false, "技能详情（列表无链接，跳过）");
  }

  // [6] /studio/resources
  console.log("[6] /studio/resources（快照断言 + 工作区）");
  await page.goto(`${NEX}/studio/resources`);
  await page.waitForSelector("text=智能体", { timeout: 30000 });
  await page.waitForTimeout(800);
  const resText = await page.locator("body").innerText();
  expect(!resText.includes("无法访问"), "资源工作区加载");
  expect(
    resText.includes("登记"),
    "登记入口可见（canRegisterContract 快照断言）",
    resText.slice(0, 200),
  );

  // [7] /studio/agents/[agent_id]
  console.log("[7] /studio/agents/[id]（control-plane-client）");
  await page.goto(`${NEX}/studio/agents/${AGENT_ID}`);
  await page.waitForSelector("text=登记状态", { timeout: 30000 });
  const agentText = await page.locator("body").innerText();
  expect(agentText.includes("控制台冒烟智能体"), "agent 详情渲染（display_name）");
  expect(agentText.includes("已登记"), "生命周期状态渲染");
  await page.screenshot({ path: "tmp/studio-shell-agent-detail.png" });

  // [8] operations / runtime / security / settings
  console.log("[8] operations · runtime · security · settings");
  await page.goto(`${NEX}/studio/operations`);
  await page.waitForSelector("text=运营", { timeout: 30000 });
  expect(!(await page.locator("body").innerText()).includes("无法访问"), "运营页加载");

  await page.goto(`${NEX}/studio/runtime`);
  await page.waitForSelector("text=运行服务与环境", { timeout: 30000 });
  expect(true, "Runtime 页加载");

  await page.goto(`${NEX}/studio/security`);
  await page.waitForSelector("text=成员角色", { timeout: 30000 });
  const secHref = await page
    .locator('a:has-text("前往管理台")')
    .first()
    .getAttribute("href")
    .catch(() => null);
  expect(
    secHref === `${AC}/console/settings`,
    "安全页外链（context 下发的 authCenterBaseUrl）",
    secHref,
  );

  await page.goto(`${NEX}/studio/settings`);
  await page.waitForSelector("text=平台设置", { timeout: 30000 });
  const setHref = await page
    .locator('a:has-text("前往管理台")')
    .first()
    .getAttribute("href")
    .catch(() => null);
  expect(setHref === `${AC}/console/settings`, "设置页外链", setHref);

  // [9] capabilities / observability
  console.log("[9] capabilities · observability（静态页）");
  await page.goto(`${NEX}/studio/capabilities`);
  await page.waitForSelector("text=能力与知识", { timeout: 30000 });
  expect(true, "能力与知识页加载");
  await page.goto(`${NEX}/studio/observability`);
  await page.waitForSelector("text=观测与评测", { timeout: 30000 });
  expect(true, "观测与评测页加载");

  // [10] /chat（AuthGate）
  console.log("[10] /chat（AuthGate 客户端门禁）");
  await page.goto(`${NEX}/chat`);
  await page.waitForSelector("textarea", { timeout: 40000 });
  expect(!page.url().includes("login"), "已登录直接进入 /chat");

  await browser.close();
  console.log(`\n== 结果：${checks - failures}/${checks} 通过 ==\n`);
  if (failures > 0) process.exitCode = 1;
}

void main();
