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
 * agentRevisionId=null）之上，即专题01 的 0-Agent 场景：冻结架构下 ExecutionBinding
 * 不携带任何 Agent evidence 字段（serializeExecutionBinding 已移除，字段缺席）。
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
    const input = window.getByLabel("消息输入框");

    // ─── 1b. 首屏发送前的 Agent 目录与选择器空态（§24.1/§25）──
    // renderer 初始路由必须精确为 /desktop（允许尾斜杠时做规范化），绝不含假 new 路由。
    const rendererUrl = window.url();
    const rendererPath = new URL(rendererUrl).pathname.replace(/\/+$/, "");
    expect(rendererPath).toBe("/desktop");
    expect(rendererUrl).not.toContain("/new");
    console.log(`[e2e][desktop] renderer=${rendererUrl} server=${E2E_ORIGIN}`);

    // Fresh DB：真实 Agent 目录必须为空数组；Desktop 的 Agent API 请求必须指向 E2E_ORIGIN
    //（Desktop 只把服务端当 API 提供方，UI 来自本机打包 renderer，§0.8）。
    const agentsResponse = await request.get(
      `${E2E_ORIGIN}/api/v1/catalog/options?resource_type=agent&lifecycle_state=enabled`,
    );
    expect(agentsResponse.status()).toBe(200);
    const agentsBody = (await agentsResponse.json()) as { items: readonly unknown[] };
    expect(agentsBody.items).toEqual([]);

    // Agent selector 空态：触发按钮可点（aria-label 稳定为"优先助手"），打开 popover
    // 后必须显示权威要求的空态文案「还没有智能体」（§24.1/§25：不阻止输入，不伪造 Agent）。
    const agentTrigger = window.getByRole("button", { name: "优先助手" });
    await expect(agentTrigger).toBeVisible({ timeout: 30_000 });
    await agentTrigger.click();
    await expect(window.getByText("当前问题需要时优先咨询；简单问题可能直接回答。")).toBeVisible();
    await expect(window.getByText("还没有智能体")).toBeVisible({ timeout: 15_000 });

    // popover 打开与关闭后，消息输入框都保持 enabled（空态不阻止输入）。
    await expect(input).toBeEnabled();
    await window.keyboard.press("Escape");
    await expect(input).toBeEnabled();

    // 连续调整真实 BrowserWindow 尺寸，确认 Desktop 共用的输入区没有遮挡或横向溢出。
    for (const size of [
      { width: 1280, height: 900 },
      { width: 960, height: 760 },
      { width: 720, height: 700 },
    ]) {
      await desktop.app.evaluate(({ BrowserWindow }, nextSize) => {
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (!mainWindow) throw new Error("Desktop 主窗口不存在");
        mainWindow.setSize(nextSize.width, nextSize.height);
      }, size);
      await expect(agentTrigger).toBeVisible();
      await expect(input).toBeVisible();
      await expect(input).toBeEnabled();
      expect(
        await window.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth),
      ).toBe(true);
    }

    // ─── 2. 发送消息（创建 Thread + 首个 Turn）───────────────
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
    const agentMessage = window.getByTestId("assistant-message").first();
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
    // 冻结架构（专题01 §5/§6）：ExecutionBinding 只绑定 Harness Runtime，不再携带任何 Agent evidence。
    // serializeExecutionBinding 已彻底移除 agent_revision_id / agent_contract_* / agent_publication_record_id
    // 字段（Batch4 删除，字段缺席 undefined，非 null）。Desktop 与 Web 走同一正式 Binding 模型。
    expect(binding.agent_revision_id).toBeUndefined();
    expect(binding.agent_contract_snapshot_id).toBeUndefined();
    expect(binding.agent_contract_digest).toBeUndefined();
    expect(binding.agent_publication_record_id).toBeUndefined();
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
    await expect(window.getByTestId("assistant-message").first()).toBeVisible({ timeout: 90_000 });
    const restoredText = (await window.getByTestId("assistant-message").first().innerText()).trim();
    expect(restoredText.length).toBeGreaterThan(0);

    console.log(
      `[e2e][desktop] 正式链断言通过：thread=${threadId} invocation=${invocationId} ` +
        `timeline 恢复 ${restoredText.length} 字符`,
    );
  });
});
