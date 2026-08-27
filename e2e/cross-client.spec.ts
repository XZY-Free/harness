/**
 * §20.6 跨端一致性 E2E。
 *
 * 方案 §20.6 要求证明：
 *
 *   Web 创建 Thread   → Desktop 打开同一 Thread
 *   Desktop 发送 Turn → Web 通过 Event 看到结果
 *
 *   「两端不能分别走两套执行模型。」
 *
 * 本用例同时验证两个方向，并在服务端核对：两端产生的 Invocation 属于同一个
 * Thread、各自都有正式 ExecutionBinding，且绑定到同一条 DeploymentRoute
 * 与同一个 AgentRevision / RuntimeRevision——即同一套控制面事实（§0.8）。
 *
 * Web 侧不做刷新：第二条回复必须由 SSE Event 推到已打开的页面，
 * 才算真正证明「Web 通过 Event 看到 Desktop 的结果」。
 */
import { type Page, expect, test } from "@playwright/test";
import { type LaunchedDesktop, launchDesktopApp } from "./support/launch-desktop";

const ADMIN_BASE = "/admin/api/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InvocationItem {
  id: string;
  turn_id: string;
  invocation_sequence: number;
}

/**
 * ExecutionBinding 的诚实类型：0-Agent 基础 Harness Route 下 Agent Evidence 的
 * 条件性完整组为「全空」终态，故 agent_* 字段真实值为 null（§10.3/§18），
 * 不能用 Record<string, string> 把 null 伪装成字符串。
 */
interface ExecutionBinding {
  agent_revision_id: string | null;
  runtime_revision_id: string;
  deployment_route_id: string;
  route_revision_id: string;
  agent_contract_snapshot_id: string | null;
  agent_contract_digest: string | null;
  agent_publication_record_id: string | null;
  runtime_publication_record_id: string;
  conformance_run_id: string;
}

test.describe("§20.6 跨端一致性", () => {
  let desktop: LaunchedDesktop;
  let desktopWindow: Page;

  test.beforeAll(async () => {
    desktop = await launchDesktopApp();
    desktopWindow = await desktop.app.firstWindow();
  });

  test.afterAll(async () => {
    await desktop?.dispose();
  });

  test("Web 创建 Thread → Desktop 打开同一 Thread → Desktop 发 Turn → Web 收到 Event", async ({
    page,
    request,
  }) => {
    // ─── 1. Web 创建 Thread 并发送首条消息 ────────────────
    const webFirstMessage = "跨端用例：这条来自 Web。";
    await page.goto("/chat");
    const webInput = page.getByLabel("消息输入框");
    await expect(webInput).toBeEnabled({ timeout: 90_000 });
    await webInput.fill(webFirstMessage);
    await webInput.press("Enter");

    await page.waitForURL((url) => UUID_PATTERN.test(url.pathname.replace("/chat/", "")), {
      timeout: 90_000,
    });
    const threadId = new URL(page.url()).pathname.replace("/chat/", "");
    expect(threadId).toMatch(UUID_PATTERN);

    // Web 侧第一条回复到达。
    await expect(page.getByTestId("agent-message").first()).toBeVisible({ timeout: 90_000 });
    await expect.poll(async () => page.getByTestId("agent-message").count()).toBe(1);

    // ─── 2. Desktop 打开同一个 Thread ─────────────────────
    const rendererOrigin = new URL(desktopWindow.url()).origin;
    await desktopWindow.goto(`${rendererOrigin}/desktop/chat/${threadId}`);

    // Desktop 必须看到 Web 写入的那条用户消息——同一 Conversation 事实。
    // 助手回复会回显用户文本，必须用 user-message 容器限定范围，避免与回复歧义。
    await expect(
      desktopWindow.getByTestId("user-message").filter({ hasText: webFirstMessage }),
    ).toBeVisible({ timeout: 90_000 });
    // 也必须看到 Web 那一轮的回复。
    await expect(desktopWindow.getByTestId("agent-message").first()).toBeVisible({
      timeout: 90_000,
    });
    console.log(`[e2e][cross] Desktop 已打开 Web 创建的 thread=${threadId}`);

    // ─── 3. Desktop 发送第二个 Turn ───────────────────────
    const desktopMessage = "跨端用例：这条来自 Desktop。";
    const desktopInput = desktopWindow.getByLabel("消息输入框");
    await expect(desktopInput).toBeEnabled({ timeout: 60_000 });
    await desktopInput.fill(desktopMessage);
    await desktopInput.press("Enter");

    // Desktop 侧出现第二条回复。
    await expect
      .poll(async () => desktopWindow.getByTestId("agent-message").count(), { timeout: 120_000 })
      .toBe(2);

    // ─── 4. Web 未刷新，通过 Event 看到 Desktop 的结果 ─────
    // 这一步是 §20.6 的核心：页面始终停留在同一个 Thread，靠 SSE 收敛。
    // 用 user-message 容器限定 Desktop 发起的这条用户消息，避免与回复回显歧义。
    await expect(page.getByTestId("user-message").filter({ hasText: desktopMessage })).toBeVisible({
      timeout: 120_000,
    });
    await expect
      .poll(async () => page.getByTestId("agent-message").count(), { timeout: 120_000 })
      .toBe(2);
    console.log("[e2e][cross] Web 已通过 Event 收到 Desktop 发起的轮次结果");

    // ─── 5. 服务端核对：两轮走的是同一套控制面事实 ─────────
    const invocationsResponse = await request.get(`${ADMIN_BASE}/threads/${threadId}/invocations`);
    expect(invocationsResponse.status()).toBe(200);
    const invocations = (await invocationsResponse.json()) as {
      items: readonly InvocationItem[];
    };
    expect(invocations.items.length).toBe(2);

    const bindings = await Promise.all(
      invocations.items.map(async (invocation) => {
        const response = await request.get(
          `${ADMIN_BASE}/invocations/${invocation.id}/execution-binding`,
        );
        expect(response.status()).toBe(200);
        return (await response.json()) as ExecutionBinding;
      }),
    );

    // 两个 Invocation 属于不同 Turn（一个来自 Web，一个来自 Desktop）。
    const turnIds = new Set(invocations.items.map((item) => item.turn_id));
    expect(turnIds.size).toBe(2);

    // 但都绑定到同一条 Route / 同一 AgentRevision / 同一 RuntimeRevision——
    // 即两端共用同一执行模型，不存在第二套控制面。
    const [webBinding, desktopBinding] = bindings;
    expect(webBinding?.deployment_route_id).toBe(desktopBinding?.deployment_route_id);
    expect(webBinding?.route_revision_id).toBe(desktopBinding?.route_revision_id);
    expect(webBinding?.agent_revision_id).toBe(desktopBinding?.agent_revision_id);
    expect(webBinding?.runtime_revision_id).toBe(desktopBinding?.runtime_revision_id);
    expect(webBinding?.agent_publication_record_id).toBe(
      desktopBinding?.agent_publication_record_id,
    );
    expect(webBinding?.runtime_publication_record_id).toBe(
      desktopBinding?.runtime_publication_record_id,
    );
    expect(webBinding?.conformance_run_id).toBe(desktopBinding?.conformance_run_id);

    // §10.3/§18：0-Agent 基础 Harness Route — 两端 Agent Evidence 条件性完整组都是
    // 「全空」终态。逐一显式断言四个 agent_* 字段为 null（诚实表达，不 stringify
    // 成空字符串，也不改占位值），同时仍核对 Route/Runtime/Publication/Conformance
    // 相同且非空。
    for (const [label, binding] of [
      ["Web", webBinding],
      ["Desktop", desktopBinding],
    ] as const) {
      expect(binding, `${label} Binding 应存在`).toBeTruthy();
      // Agent Evidence 全空：fresh DB 没有 Agent（§24.1 count=0）。
      expect(binding?.agent_revision_id, `${label} agent_revision_id 应为 null`).toBeNull();
      expect(
        binding?.agent_contract_snapshot_id,
        `${label} agent_contract_snapshot_id 应为 null（基础 Harness Route）`,
      ).toBeNull();
      expect(binding?.agent_contract_digest, `${label} agent_contract_digest 应为 null`).toBeNull();
      expect(
        binding?.agent_publication_record_id,
        `${label} agent_publication_record_id 应为 null`,
      ).toBeNull();
      // Route / Runtime / Publication / Conformance 仍必须相同且非空。
      expect(binding?.deployment_route_id, `${label} route 非空`).toMatch(UUID_PATTERN);
      expect(binding?.runtime_revision_id, `${label} runtimeRevision 非空`).toMatch(UUID_PATTERN);
      expect(binding?.runtime_publication_record_id, `${label} runtimePublication 非空`).toMatch(
        UUID_PATTERN,
      );
      expect(binding?.conformance_run_id, `${label} conformanceRun 非空`).toMatch(UUID_PATTERN);
    }

    console.log(
      `[e2e][cross] 两端共用控制面事实：route=${webBinding?.deployment_route_id} ` +
        `agentRevision=${webBinding?.agent_revision_id} runtimeRevision=${webBinding?.runtime_revision_id}`,
    );
  });
});
