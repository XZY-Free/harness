/**
 * §20.4 Web 正式执行链 E2E — 0-Agent 场景。
 *
 * 方案 §20.4 要求至少覆盖：
 *
 *   打开 Web → 创建 Thread → 发送消息 → 创建 Turn → 服务端生成 Invocation
 *   → ExecutionBinding 存在 → 时间线收到 Event → Agent 回复显示
 *
 * 本用例跑在 e2e-bootstrap 的**基础 Harness Route**（§8.3 base route，
 * agentRevisionId=null）之上，即专题01 的 **0-Agent True E2E**：Agent 目录为空
 * （Agent 空表合法，§6.2/§33.1），Thread 创建不要求、不 fallback Agent（§35）。
 *
 * 断言策略：
 * - 结构性事实全部断言（Thread / Turn / Invocation / ExecutionBinding / Event /
 *   非空 Agent 回复），因为这些是确定的，CI 需要明确的通过/失败信号（§21）。
 * - **不断言回复文本内容**——模型措辞不是被测对象，写死会造成脆弱断言。
 *   回复原文打到测试日志，供人工与 CI 日志核对是否正常。
 * - ExecutionBinding 逐字段核对：route + runtime 无条件证据必填（§8.1），
 *   冻结架构下 ExecutionBinding 不再携带任何 Agent evidence 字段（Batch4 移除，字段缺席）；
 *   并明确拒绝 §18.6 禁止的全零占位摘要。
 *
 * 事实源：docs/V12/01/SnowHarness 专题 01 最终收口实施总方案.md §8.1 / §10.3 / §18.6 / §20.4
 */
import { expect, test } from "@playwright/test";

const ADMIN_BASE = "/admin/api/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** §18.6 明确禁止出现在正式链上的占位摘要。 */
const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

/** 管理面列表端点统一返回 { items, total }。 */
interface AdminListResponse<T> {
  items: readonly T[];
  total: number;
}

interface InvocationItem {
  id: string;
  turn_id: string;
  invocation_sequence: number;
  execution_state: string;
}

interface ThreadEventItem {
  id: string;
  event_sequence: number;
  event_type: string;
  turn_id: string | null;
  invocation_id: string | null;
  item_id: string | null;
  payload_json: {
    item_type?: string;
    source?: string;
    finish_reason?: string;
    [key: string]: unknown;
  } | null;
}

interface ExecutionBindingResponse {
  invocation_id: string;
  runtime_revision_id: string;
  deployment_route_id: string;
  route_revision_id: string;
  route_activation_id: string;
  route_content_digest: string;
  runtime_artifact_digest: string;
  runtime_config_digest: string;
  capability_manifest_digest: string;
  runtime_attestation_ids: readonly string[];
  runtime_publication_record_id: string;
  conformance_run_id: string;
  resolution_input_digest: string;
  projection_version_no: number;
  model_id: string;
}

interface ThreadEventsResponse {
  items: readonly ThreadEventItem[];
  total: number;
}

/** 从 /chat/<id> 提取 threadId。 */
function threadIdFromUrl(url: string): string {
  return new URL(url).pathname.replace("/chat/", "");
}

test("Web 正式执行链：创建 Thread → Turn → Invocation → ExecutionBinding → Event → Agent 回复", async ({
  page,
  request,
}) => {
  // ─── 1. 打开 Web 新会话页 ────────────────────────────────
  await page.goto("/chat");

  const input = page.getByLabel("消息输入框");
  await expect(input).toBeEnabled({ timeout: 60_000 });

  // ─── 1b. 首屏发送前的 Agent 目录与选择器空态（§24.1/§25）──
  // 初始 URL 必须是干净的真实会话入口：pathname 精确为 /chat，绝不含假 new 路由。
  const initialPath = new URL(page.url()).pathname;
  expect(initialPath).toBe("/chat");
  expect(initialPath).not.toContain("/new");

  // Fresh DB：真实 Agent 目录必须为空数组（§24.1 count=0），不能 fallback 出任何 Agent。
  const agentsResponse = await request.get(
    "/api/v1/catalog/options?resource_type=agent&lifecycle_state=enabled",
  );
  expect(agentsResponse.status()).toBe(200);
  const agentsBody = (await agentsResponse.json()) as { items: readonly unknown[] };
  expect(agentsBody.items).toEqual([]);

  // Agent selector 空态：触发按钮可点（aria-label 稳定为"助手"），打开 popover
  // 后必须显示权威要求的空态文案「还没有智能体」（§24.1/§25：不阻止输入，不伪造 Agent）。
  const agentTrigger = page.getByRole("button", { name: "助手" });
  await expect(agentTrigger).toBeVisible({ timeout: 30_000 });
  await agentTrigger.click();
  await expect(page.getByText("还没有智能体")).toBeVisible({ timeout: 15_000 });

  // popover 打开与关闭后，消息输入框都保持 enabled（空态不阻止输入）。
  await expect(input).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(input).toBeEnabled();

  // ─── 2. 发送首条消息（同时创建 Thread + 首个 Turn）──────
  await input.fill("请用一句话介绍 SnowHarness。");
  await input.press("Enter");

  // 提交成功后 shell 原地把地址换成真实 threadId。
  await page.waitForURL((url) => UUID_PATTERN.test(url.pathname.replace("/chat/", "")), {
    timeout: 60_000,
  });
  const threadId = threadIdFromUrl(page.url());
  expect(threadId).toMatch(UUID_PATTERN);

  // ─── 3. Agent 回复在时间线渲染（结构性断言，不校验文本）──
  const agentMessage = page.getByTestId("assistant-message").first();
  await expect(agentMessage).toBeVisible({ timeout: 90_000 });
  await expect
    .poll(async () => (await agentMessage.innerText()).trim().length, { timeout: 90_000 })
    .toBeGreaterThan(0);

  const replyText = (await agentMessage.innerText()).trim();
  // 回复原文入日志：内容是否正常由人工/CI 日志判断，不做脆弱断言。
  console.log(`[e2e][web] thread=${threadId} Agent 回复原文：${replyText}`);

  // ─── 4. 服务端确实生成了 Turn ───────────────────────────
  const turnsResponse = await request.get(`/api/v1/threads/${threadId}/turns`);
  expect(turnsResponse.status()).toBe(200);
  const turnsBody = (await turnsResponse.json()) as {
    turns: ReadonlyArray<{ id: string; turn_state: string; latest_invocation_id: string | null }>;
  };
  expect(turnsBody.turns.length).toBeGreaterThan(0);
  const turn = turnsBody.turns[0];
  expect(turn?.id).toMatch(UUID_PATTERN);
  const turnId = turn?.id ?? "";

  // ─── 5. 服务端生成 Invocation ───────────────────────────
  const invocationsResponse = await request.get(`${ADMIN_BASE}/threads/${threadId}/invocations`);
  expect(invocationsResponse.status()).toBe(200);
  const invocationsBody = (await invocationsResponse.json()) as AdminListResponse<InvocationItem>;
  expect(invocationsBody.items.length).toBeGreaterThan(0);
  const invocation = invocationsBody.items[0];
  const invocationId = invocation?.id ?? "";
  expect(invocationId).toMatch(UUID_PATTERN);
  // Invocation 必须挂在刚创建的 Turn 上。
  expect(invocation?.turn_id).toBe(turnId);

  // ─── 6. ExecutionBinding 存在且冻结了完整证据（§8.1）────
  const bindingResponse = await request.get(
    `${ADMIN_BASE}/invocations/${invocationId}/execution-binding`,
  );
  expect(bindingResponse.status()).toBe(200);
  const binding = (await bindingResponse.json()) as ExecutionBindingResponse;

  expect(binding.invocation_id).toBe(invocationId);

  // §8.1：Route 权威三元组必填。
  expect(binding.route_revision_id).toMatch(UUID_PATTERN);
  expect(binding.route_activation_id).toMatch(UUID_PATTERN);
  expect(binding.deployment_route_id).toMatch(UUID_PATTERN);
  expect(binding.route_content_digest).toMatch(SHA256_PATTERN);

  // §8.1：Runtime Artifact / Config / Capability 摘要必填（Runtime Evidence 无条件完整）。
  expect(binding.runtime_artifact_digest).toMatch(SHA256_PATTERN);
  expect(binding.runtime_config_digest).toMatch(SHA256_PATTERN);
  expect(binding.capability_manifest_digest).toMatch(SHA256_PATTERN);

  // 冻结架构（专题01 §5/§6）：ExecutionBinding 只绑定 Harness Runtime，不再携带任何 Agent evidence。
  // serializeExecutionBinding 已彻底移除 agent_revision_id / agent_contract_* / agent_publication_record_id
  // 字段（Batch4 删除，非 null 而是字段缺席 undefined）。Agent 不是 Thread 或基础 Harness 执行的前置条件（§35）。
  expect((binding as unknown as Record<string, unknown>).agent_revision_id).toBeUndefined();
  expect(
    (binding as unknown as Record<string, unknown>).agent_contract_snapshot_id,
  ).toBeUndefined();
  expect((binding as unknown as Record<string, unknown>).agent_contract_digest).toBeUndefined();
  expect(
    (binding as unknown as Record<string, unknown>).agent_publication_record_id,
  ).toBeUndefined();

  // §8.5：Runtime Attestation 集合必须非空（不是"子集"，是当时的完整集合）。
  expect(binding.runtime_attestation_ids.length).toBeGreaterThan(0);

  // §8.6：Publication 精确绑定 — Runtime 无条件（ExecutionBinding 只冻结 Runtime Publication）。
  expect(binding.runtime_publication_record_id).toMatch(UUID_PATTERN);

  // §8.4：冻结的是确切的 ConformanceRun（Runtime Publication Conformance 无条件严格）。
  expect(binding.conformance_run_id).toMatch(UUID_PATTERN);

  // §7：真实 Resolver 输入摘要，且非全零占位（§18.6）。
  expect(binding.resolution_input_digest).toMatch(SHA256_PATTERN);
  expect(binding.resolution_input_digest).not.toBe(PLACEHOLDER_DIGEST);
  expect(binding.projection_version_no).toBeGreaterThan(0);

  // Revision 绑定：Runtime 必填、Agent 为 null（§10.3）。
  expect(binding.runtime_revision_id).toMatch(UUID_PATTERN);

  // 全部「必填」摘要字段都不得是占位值（route + runtime 无条件字段）。
  for (const [field, value] of Object.entries({
    route_content_digest: binding.route_content_digest,
    runtime_artifact_digest: binding.runtime_artifact_digest,
    runtime_config_digest: binding.runtime_config_digest,
    capability_manifest_digest: binding.capability_manifest_digest,
  })) {
    expect(value, `${field} 不得为全零占位摘要`).not.toBe(PLACEHOLDER_DIGEST);
  }

  // ─── 7. 时间线收到 Event ────────────────────────────────
  const eventsResponse = await request.get(`${ADMIN_BASE}/threads/${threadId}/events`);
  expect(eventsResponse.status()).toBe(200);
  const eventsBody = (await eventsResponse.json()) as ThreadEventsResponse;
  expect(eventsBody.items.length).toBeGreaterThan(0);
  // Event sequence 必须严格递增（同一 Thread 的顺序事实）。
  const sequences = eventsBody.items.map((event) => event.event_sequence);
  expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);

  // 不能只断言 items>0 和排序：必须找到与本次 turn/invocation / assistant 完成
  // 有关的运行时事件，否则任何"空跑"都会误判为通过（§20.4 / §21）。
  // 本次 Web 链产生的真实运行时事件（事实源 lib/runtime/event-ingress-queries.ts）：
  //   - item.created   payload.item_type="user_message"（用户输入）
  //   - item.created   payload.item_type="assistant_message" payload.source="response.completed"（Harness 最终回答落地）
  //   - invocation.completed  payload.finish_reason="execution.completed"（本次 Invocation 完成；
  //     终态 Authority 拆分后由 execution.completed 唯一写入，专题01 c98cf91）
  //
  // 冻结架构（专题01 §19）：顶层正式回答统一为 assistant_message（由 Harness 生成），
  // 外部 Agent 原始输出经 AgentCall result 持久化，绝不冒充顶层 agent_message。
  //
  // 关联规则（§事件溯源）：用户消息 item.created 在 Invocation 创建**之前**写入，
  // 故不带 invocation_id，只能按 turn_id 关联；assistant_message / invocation.completed
  // 属于本次 Invocation 内部事件，按 invocation_id + turn_id 关联。
  const turnEvents = eventsBody.items.filter((event) => event.turn_id === turnId);
  expect(turnEvents.length, `本次 Turn(${turnId}) 必须产生运行时事件`).toBeGreaterThan(0);
  for (const event of turnEvents) {
    expect(event.turn_id).toBe(turnId);
  }

  // 用户消息 item.created：Invocation 前写入 → 不含 invocation_id，只按 turn_id 找。
  const userItemEvent = turnEvents.find(
    (event) =>
      event.event_type === "item.created" && event.payload_json?.item_type === "user_message",
  );
  expect(userItemEvent, "必须存在用户消息 item.created 运行时事件").toBeTruthy();
  expect(userItemEvent?.item_id).toMatch(UUID_PATTERN);

  // assistant_message / invocation.completed：属于本次 Invocation → 按 invocation_id + turn_id。
  const invocationEvents = eventsBody.items.filter(
    (event) => event.invocation_id === invocationId && event.turn_id === turnId,
  );
  expect(
    invocationEvents.length,
    `本次 Invocation(${invocationId}) 必须产生内部运行时事件`,
  ).toBeGreaterThan(0);
  for (const event of invocationEvents) {
    expect(event.invocation_id).toBe(invocationId);
    expect(event.turn_id).toBe(turnId);
  }

  const assistantItemEvent = invocationEvents.find(
    (event) =>
      event.event_type === "item.created" &&
      event.payload_json?.item_type === "assistant_message" &&
      event.payload_json?.source === "response.completed",
  );
  expect(
    assistantItemEvent,
    "必须存在 assistant_message 落地（response.completed）运行时事件",
  ).toBeTruthy();
  expect(assistantItemEvent?.item_id).toMatch(UUID_PATTERN);

  // 冻结架构（专题01）：invocation.completed 由 execution.completed 独立 Authority 异步写入
  // （response.completed 只落 assistant_message，不越权写终态；event-ingress §「response.completed」）。
  // 故必须轮询等待该终态事件出现，而非单次查询（避免与异步写入竞态）。
  let invocationCompletedEvent: ThreadEventItem | undefined;
  await expect
    .poll(
      async () => {
        const pollResponse = await request.get(`${ADMIN_BASE}/threads/${threadId}/events`);
        if (pollResponse.status() !== 200) return false;
        const pollBody = (await pollResponse.json()) as ThreadEventsResponse;
        invocationCompletedEvent = pollBody.items.find(
          (event) =>
            event.invocation_id === invocationId &&
            event.turn_id === turnId &&
            event.event_type === "invocation.completed" &&
            event.payload_json?.finish_reason === "execution.completed",
        );
        return invocationCompletedEvent !== undefined;
      },
      { timeout: 30_000, intervals: [250, 500, 1000, 2000] },
    )
    .toBe(true);
  expect(invocationCompletedEvent, "必须存在本次 Invocation 的 assistant 完成事件").toBeTruthy();
  expect(invocationCompletedEvent?.invocation_id).toBe(invocationId);

  console.log(
    `[e2e][web] 正式链断言通过：turn=${turn?.id} invocation=${invocationId} ` +
      `route=${binding.deployment_route_id} events=${eventsBody.items.length}`,
  );
});
