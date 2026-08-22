/**
 * §20.5 Desktop 正式执行链 E2E（真启动 Electron）。
 *
 * 方案 §20.5 要求至少覆盖：
 *
 *   Desktop 启动 → 创建/打开 Thread → 发送消息 → 使用同一 Conversation API
 *   → 使用正式 ExecutionBinding → Timeline 恢复 → Workspace / Environment 正常
 *
 * 实现方式：Playwright `_electron.launch()` 真启动 `desktop/package-app`，
 * 通过 `SNOW_SERVER_ORIGIN` 指向 e2e 测试服务器。Electron 主进程会起本地 renderer
 * server 承载 UI，并把 `/api/*` 代理到该 origin——即 Desktop 与 Web 共用同一套
 * Conversation API（§0.8）。
 *
 * 前置：`pnpm build:desktop` + `pnpm rebuild:desktop-native`。
 * 未构建时**明确失败**而非跳过（§22 禁止把 skip 当作完成）。
 *
 * 断言策略与 Web 一致：结构性事实全断言，回复文本只记日志不校验。
 *
 * 本用例跑在 e2e-bootstrap 的**基础 Harness Route**（§8.3 base route，
 * agentRevisionId=null）之上，即专题01 的 0-Agent 场景：ExecutionBinding 的
 * Agent Evidence 为条件性完整组的「全空」终态（canonical null，§10.3/§18）。
 * Agent-backed 场景由 agent-execution-chain.spec.ts（J-3 集成侧）+ 场景21 覆盖。
 */
import { type Page, expect, test } from "@playwright/test";
import { E2E_ORIGIN } from "../playwright.config";
import { type LaunchedDesktop, launchDesktopApp } from "./support/launch-desktop";

const ADMIN_BASE = "/admin/api/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

/** 从 desktop 路由中提取 threadId（/desktop/chat/<id>）。 */
function desktopThreadId(url: string): string {
  return new URL(url).pathname.replace("/desktop/chat/", "");
}

/** 等待 renderer 完成 shell 加载（助手列表就绪 → 输入框可用）。 */
async function waitForShell(window: Page): Promise<void> {
  await expect(window.getByLabel("消息输入框")).toBeEnabled({ timeout: 90_000 });
}

test.describe("§20.5 Desktop 正式执行链", () => {
  let desktop: LaunchedDesktop;
  let window: Page;

  test.beforeAll(async () => {
    desktop = await launchDesktopApp();
    window = await desktop.app.firstWindow();
    window.on("console", (message) => {
      if (message.type() === "error") console.log(`[e2e][desktop][console] ${message.text()}`);
    });
  });

  test.afterAll(async () => {
    await desktop?.dispose();
  });

  test("Desktop 启动 → 发送消息 → 正式 ExecutionBinding → Timeline 恢复", async ({ request }) => {
    // ─── 1. Desktop 启动，renderer 连上同一 Conversation API ──
    await waitForShell(window);

    // 本地 renderer server 承载 UI（非服务端页面）。
    const rendererUrl = window.url();
    expect(rendererUrl).toContain("/desktop");
    console.log(`[e2e][desktop] renderer=${rendererUrl} server=${E2E_ORIGIN}`);

    // ─── 2. 发送消息（创建 Thread + 首个 Turn）───────────────
    const input = window.getByLabel("消息输入框");
    await input.fill("Desktop 端发送的第一条消息。");
    await input.press("Enter");

    await window.waitForURL(
      (url) => UUID_PATTERN.test(url.pathname.replace("/desktop/chat/", "")),
      { timeout: 90_000 },
    );
    const threadId = desktopThreadId(window.url());
    expect(threadId).toMatch(UUID_PATTERN);

    // ─── 3. Desktop 变体渲染（桌面标题栏存在）──────────────
    await expect(window.getByTestId("desktop-thread-titlebar")).toBeVisible({ timeout: 30_000 });

    // ─── 4. Agent 回复渲染（结构性断言）────────────────────
    const agentMessage = window.getByTestId("agent-message").first();
    await expect(agentMessage).toBeVisible({ timeout: 90_000 });
    await expect
      .poll(async () => (await agentMessage.innerText()).trim().length, { timeout: 90_000 })
      .toBeGreaterThan(0);
    console.log(
      `[e2e][desktop] thread=${threadId} Agent 回复原文：${(await agentMessage.innerText()).trim()}`,
    );

    // ─── 5. 走的是同一 Conversation API + 正式 ExecutionBinding ──
    const invocationsResponse = await request.get(
      `${E2E_ORIGIN}${ADMIN_BASE}/threads/${threadId}/invocations`,
    );
    expect(invocationsResponse.status()).toBe(200);
    const invocations = (await invocationsResponse.json()) as {
      items: ReadonlyArray<{ id: string }>;
    };
    expect(invocations.items.length).toBeGreaterThan(0);
    const invocationId = invocations.items[0]?.id ?? "";
    expect(invocationId).toMatch(UUID_PATTERN);

    const bindingResponse = await request.get(
      `${E2E_ORIGIN}${ADMIN_BASE}/invocations/${invocationId}/execution-binding`,
    );
    expect(bindingResponse.status()).toBe(200);
    const binding = (await bindingResponse.json()) as Record<string, unknown>;

    // Desktop 必须使用与 Web 完全相同的正式 Binding 模型（§0.8：不存在 Desktop Runtime V2）。
    expect(binding.route_revision_id).toMatch(UUID_PATTERN);
    expect(binding.route_activation_id).toMatch(UUID_PATTERN);
    expect(binding.runtime_publication_record_id).toMatch(UUID_PATTERN);
    expect(binding.conformance_run_id).toMatch(UUID_PATTERN);
    expect(binding.resolution_input_digest).toMatch(SHA256_PATTERN);
    expect(binding.resolution_input_digest).not.toBe(PLACEHOLDER_DIGEST);
    // §10.3/§18：0-Agent 基础 Harness Route — Agent Evidence 条件性完整组为「全空」（canonical null）。
    // Desktop 与 Web 走同一正式 Binding 模型；Agent 不是执行前置（§35）。
    expect(binding.agent_revision_id).toBeNull();
    expect(binding.agent_artifact_digest).toBeNull();
    expect(binding.agent_attestation_ids).toBeNull();
    expect(binding.agent_publication_record_id).toBeNull();
    expect((binding.runtime_attestation_ids as string[]).length).toBeGreaterThan(0);

    // ─── 6. Workspace / Environment 正常 ────────────────────
    const environmentResponse = await request.get(
      `${E2E_ORIGIN}/api/v1/threads/${threadId}/environment`,
    );
    // 200（已绑定）或 404（尚未绑定环境）都属正常；5xx 不可接受。
    expect(environmentResponse.status()).toBeLessThan(500);

    // ─── 7. Timeline 恢复（重载 renderer 后历史仍在）────────
    await window.reload();
    await waitForShell(window);
    await expect(window.getByTestId("agent-message").first()).toBeVisible({ timeout: 90_000 });
    const restoredText = (await window.getByTestId("agent-message").first().innerText()).trim();
    expect(restoredText.length).toBeGreaterThan(0);

    console.log(
      `[e2e][desktop] 正式链断言通过：thread=${threadId} invocation=${invocationId} ` +
        `timeline 恢复 ${restoredText.length} 字符`,
    );
  });
});
