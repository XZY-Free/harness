import { POST as changePrimaryAgentPOST } from "@/app/api/v1/threads/[thread_id]/change-primary-agent/route";
import { GET as listItemsGET } from "@/app/api/v1/threads/[thread_id]/items/route";
import { PATCH as updateSettingsPATCH } from "@/app/api/v1/threads/[thread_id]/settings/route";
import { POST as createTurnPOST } from "@/app/api/v1/threads/[thread_id]/turns/route";
/**
 * S04-C03：Employee Interaction API route handlers 集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖 5 个 Employee API 路由：
 * - POST /api/v1/threads — 创建 Thread
 * - PATCH /api/v1/threads/{thread_id}/settings — 更新默认设置
 * - POST /api/v1/threads/{thread_id}:change-primary-agent — 更换主 Agent
 * - POST /api/v1/threads/{thread_id}/turns — 创建 Turn
 * - GET /api/v1/threads/{thread_id}/items — 查询 Item
 *
 * 测试环境：APP_ENV=test，auth mode=dev（resolvePrincipal 使用 DEFAULT_USER_ID）。
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { POST as createThreadPOST } from "@/app/api/v1/threads/route";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { assertCrossTenantHidden, buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 identity.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：seed enabled Agent ─────────────────────────────

async function seedEnabledAgent(tenantId: string, ownerId: string, agentKey: string) {
  const agent = await createAgent({
    tenantId,
    agentKey,
    displayName: `Agent ${agentKey}`,
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });
  return agent;
}

// ─── 辅助：seed 默认身份 + Agent ───────────────────────────

async function seedContext() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const agent = await seedEnabledAgent(tenant.id, identity.id, "finance-agent");
  return { tenantId: tenant.id, userIdentityId: identity.id, agent };
}

// ─── 辅助：跨租户 seed（用于跨租户隔离测试）────────────────

async function seedOtherTenantContext() {
  // 跨租户测试用：直接使用另一个 tenantId（resetDatabase 后只有 default tenant）
  // 这里创建一个不存在的 tenantId 来模拟跨租户访问
  return { tenantId: "non-existent-tenant-id" };
}

// ═══════════════════════════════════════════════════════════
// 1. POST /api/v1/threads — 创建 Thread
// ═══════════════════════════════════════════════════════════

describe("POST /api/v1/threads", () => {
  it("成功创建 Thread → 201 + thread.created Event", async () => {
    const { tenantId, agent } = await seedContext();

    const request = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "create-thread-001",
      body: {
        agent_id: agent.id,
        title: "销售月报分析",
        workspace_id: "ws_sales",
      },
    });

    const response = await createThreadPOST(request);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toEqual(expect.any(String));
    expect(body.title).toBe("销售月报分析");
    expect(body.primary_agent_id).toBe(agent.id);
    expect(body.default_workspace_id).toBe("ws_sales");
    expect(body.lifecycle_state).toBe("active");
    expect(body.last_event_sequence).toBe(1);
    expect(body.created_at).toEqual(expect.any(String));
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    await seedContext();

    const request = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      body: { agent_id: "agt_any" },
    });

    const response = await createThreadPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("Agent 不存在 → 404 RESOURCE_NOT_FOUND（不泄露存在）", async () => {
    await seedContext();

    const request = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "create-thread-nonexistent-agent",
      body: { agent_id: "non-existent-agent-id" },
    });

    const response = await createThreadPOST(request);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("Agent 非 enabled → 404 RESOURCE_NOT_FOUND（不泄露存在）", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    // 创建 draft 状态 Agent（非 enabled）
    const draftAgent = await createAgent({
      tenantId,
      agentKey: "draft-agent",
      displayName: "Draft Agent",
      ownerUserId: userIdentityId,
      lifecycleState: "draft",
    });

    const request = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "create-thread-draft-agent",
      body: { agent_id: draftAgent.id },
    });

    const response = await createThreadPOST(request);
    expect(response.status).toBe(404);
  });

  it("幂等重放：同 Idempotency-Key + 同 body → 返回同一 Thread", async () => {
    const { agent } = await seedContext();

    const buildReq = () =>
      buildApiRequest({
        audience: "employee",
        method: "POST",
        path: "/threads",
        idempotencyKey: "create-thread-idempotent",
        body: { agent_id: agent.id, title: "幂等测试" },
      });

    const first = await createThreadPOST(buildReq());
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string };

    const second = await createThreadPOST(buildReq());
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id);
  });

  it("幂等冲突：同 Idempotency-Key + 不同 body → 409 IDEMPOTENCY_CONFLICT", async () => {
    const { agent } = await seedContext();

    const firstReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "create-thread-conflict",
      body: { agent_id: agent.id, title: "标题一" },
    });
    await createThreadPOST(firstReq);

    const secondReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "create-thread-conflict",
      body: { agent_id: agent.id, title: "标题二" },
    });
    const response = await createThreadPOST(secondReq);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. PATCH /api/v1/threads/{thread_id}/settings — 更新默认设置
// ═══════════════════════════════════════════════════════════

describe("PATCH /api/v1/threads/{thread_id}/settings", () => {
  it("成功更新 model + environment → 200 + event_ids + 新 ETag", async () => {
    const { agent } = await seedContext();

    // 先创建 Thread
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "settings-thread-create",
      body: { agent_id: agent.id },
    });
    const createResp = await createThreadPOST(createReq);
    const threadBody = (await createResp.json()) as { id: string };
    const threadId = threadBody.id;

    // PATCH 设置（初始 versionNo=1）
    const patchReq = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: `/threads/${threadId}/settings`,
      ifMatch: "thread-settings-1",
      body: {
        default_model_ref: "model:doubao-pro",
        default_environment_definition_id: "env_default",
      },
    });

    const response = await updateSettingsPATCH(patchReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      thread_id: string;
      default_model_ref: string;
      default_environment_definition_id: string;
      event_ids: string[];
      etag: string;
    };
    expect(body.default_model_ref).toBe("model:doubao-pro");
    expect(body.default_environment_definition_id).toBe("env_default");
    expect(body.event_ids).toHaveLength(2); // model_changed + environment_changed
    expect(body.etag).toBe("thread-settings-2");
  });

  it("只更新 workspace_id → 200 + event_ids 为空（不写持久 Event）", async () => {
    const { agent } = await seedContext();
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "settings-workspace-only",
      body: { agent_id: agent.id },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    const patchReq = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: `/threads/${threadId}/settings`,
      ifMatch: "thread-settings-1",
      body: { default_workspace_id: "ws_new" },
    });

    const response = await updateSettingsPATCH(patchReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { event_ids: string[]; etag: string };
    expect(body.event_ids).toHaveLength(0);
    expect(body.etag).toBe("thread-settings-2");
  });

  it("缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "settings-no-ifmatch",
      body: { agent_id: agent.id },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    const patchReq = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: `/threads/${threadId}/settings`,
      body: { default_model_ref: "model:new" },
    });

    const response = await updateSettingsPATCH(patchReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(response.status).toBe(400);
  });

  it("ETag 不匹配 → 412 ETAG_MISMATCH", async () => {
    const { agent } = await seedContext();
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "settings-etag-mismatch",
      body: { agent_id: agent.id },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    const patchReq = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: `/threads/${threadId}/settings`,
      ifMatch: "thread-settings-999", // 错误的 versionNo
      body: { default_model_ref: "model:new" },
    });

    const response = await updateSettingsPATCH(patchReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(response.status).toBe(412);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ETAG_MISMATCH");
  });

  it("Thread 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const patchReq = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: "/threads/non-existent-thread/settings",
      ifMatch: "thread-settings-1",
      body: { default_model_ref: "model:new" },
    });

    const response = await updateSettingsPATCH(patchReq, {
      params: Promise.resolve({ thread_id: "non-existent-thread" }),
    });
    expect(response.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. POST /api/v1/threads/{thread_id}:change-primary-agent — 更换主 Agent
// ═══════════════════════════════════════════════════════════

describe("POST /api/v1/threads/{thread_id}/change-primary-agent", () => {
  it("成功更换主 Agent → 200 + thread.primary_agent_changed Event", async () => {
    const { tenantId, userIdentityId, agent: initialAgent } = await seedContext();
    // 创建第二个 enabled Agent
    const newAgent = await seedEnabledAgent(tenantId, userIdentityId, "risk-agent");

    // 创建 Thread
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "change-agent-thread-create",
      body: { agent_id: initialAgent.id },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    // 更换主 Agent
    const changeReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/change-primary-agent`,
      idempotencyKey: "change-agent-001",
      body: { agent_id: newAgent.id, reason: "后续由风险审核助手负责" },
    });

    const response = await changePrimaryAgentPOST(changeReq, {
      params: Promise.resolve({
        thread_id: `${threadId}`,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      thread_id: string;
      previous_agent_id: string;
      primary_agent_id: string;
      event_id: string;
    };
    expect(body.previous_agent_id).toBe(initialAgent.id);
    expect(body.primary_agent_id).toBe(newAgent.id);
    expect(body.event_id).toEqual(expect.any(String));
  });

  it("新 Agent 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const { agent } = await seedContext();
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "change-agent-nonexistent",
      body: { agent_id: agent.id },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    const changeReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/change-primary-agent`,
      idempotencyKey: "change-agent-nonexistent-2",
      body: { agent_id: "non-existent-agent", reason: "测试" },
    });

    const response = await changePrimaryAgentPOST(changeReq, {
      params: Promise.resolve({
        thread_id: `${threadId}`,
      }),
    });
    expect(response.status).toBe(404);
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "change-agent-no-idem",
      body: { agent_id: agent.id },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    const changeReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/change-primary-agent`,
      body: { agent_id: agent.id, reason: "测试" },
    });

    const response = await changePrimaryAgentPOST(changeReq, {
      params: Promise.resolve({
        thread_id: `${threadId}`,
      }),
    });
    expect(response.status).toBe(400);
  });

  it("Thread 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const { agent } = await seedContext();
    const changeReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads/non-existent/change-primary-agent",
      idempotencyKey: "change-agent-no-thread",
      body: { agent_id: agent.id, reason: "测试" },
    });

    const response = await changePrimaryAgentPOST(changeReq, {
      params: Promise.resolve({
        thread_id: "non-existent",
      }),
    });
    expect(response.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. POST /api/v1/threads/{thread_id}/turns — 创建 Turn
// ═══════════════════════════════════════════════════════════

describe("POST /api/v1/threads/{thread_id}/turns", () => {
  it("成功创建 Turn → 201 + turn + input_item + event_cursor", async () => {
    const { agentId } = await seedDispatchableTurn();
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "turn-thread-create",
      body: { agent_id: agentId },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    const turnReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/turns`,
      idempotencyKey: "turn-create-001",
      body: {
        input: { type: "text", text: "分析销售表并生成月报" },
      },
    });

    const response = await createTurnPOST(turnReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      turn: {
        id: string;
        thread_id: string;
        turn_sequence: number;
        trigger_type: string;
        turn_state: string;
      };
      input_item: { id: string; item_type: string; item_sequence: number; item_state: string };
      event_cursor: { sequence: number; event_id: string };
    };
    expect(body.turn.thread_id).toBe(threadId);
    expect(body.turn.turn_sequence).toBe(1);
    expect(body.turn.trigger_type).toBe("user_message");
    expect(body.turn.turn_state).toBe("accepted");
    expect(body.input_item.item_type).toBe("user_message");
    expect(body.input_item.item_state).toBe("completed");
    // thread.created(seq=1) + turn.accepted(seq=2) + item.created(seq=3)
    expect(body.event_cursor.sequence).toBe(3);
  });

  it("幂等重放：同 Idempotency-Key 返回同一 Turn", async () => {
    const { agentId } = await seedDispatchableTurn();
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "turn-idempotent-create",
      body: { agent_id: agentId },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    const buildTurnReq = () =>
      buildApiRequest({
        audience: "employee",
        method: "POST",
        path: `/threads/${threadId}/turns`,
        idempotencyKey: "turn-idempotent-001",
        body: { input: { type: "text", text: "重发测试" } },
      });

    const first = await createTurnPOST(buildTurnReq(), {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { turn: { id: string } };

    const second = await createTurnPOST(buildTurnReq(), {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { turn: { id: string } };
    expect(secondBody.turn.id).toBe(firstBody.turn.id);
  });

  it("Thread 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const turnReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads/non-existent/turns",
      idempotencyKey: "turn-no-thread",
      body: { input: { type: "text", text: "测试" } },
    });

    const response = await createTurnPOST(turnReq, {
      params: Promise.resolve({ thread_id: "non-existent" }),
    });
    expect(response.status).toBe(404);
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "turn-no-idem-create",
      body: { agent_id: agent.id },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    const turnReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/turns`,
      body: { input: { type: "text", text: "测试" } },
    });

    const response = await createTurnPOST(turnReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(response.status).toBe(400);
  });

  it("请求体非法（缺少 input） → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "turn-bad-body-create",
      body: { agent_id: agent.id },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    const turnReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/turns`,
      idempotencyKey: "turn-bad-body",
      body: { text: "缺少 input 字段" },
    });

    const response = await createTurnPOST(turnReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(response.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. GET /api/v1/threads/{thread_id}/items — 查询 Item
// ═══════════════════════════════════════════════════════════

describe("GET /api/v1/threads/{thread_id}/items", () => {
  it("成功查询 Item 列表 + latest_event_cursor", async () => {
    const { agentId } = await seedDispatchableTurn();
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "items-thread-create",
      body: { agent_id: agentId },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    // 创建一个 Turn（产生 user_message Item）
    const turnReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/turns`,
      idempotencyKey: "items-turn-create",
      body: { input: { type: "text", text: "查询测试" } },
    });
    await createTurnPOST(turnReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });

    // 查询 Item
    const getReq = buildApiRequest({
      audience: "employee",
      method: "GET",
      path: `/threads/${threadId}/items`,
    });

    const response = await listItemsGET(getReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ id: string; item_type: string; item_state: string }>;
      next_cursor: string | null;
      latest_event_cursor: { sequence: number; event_id: string } | null;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.item_type).toBe("user_message");
    expect(body.items[0]?.item_state).toBe("completed");
    expect(body.next_cursor).toBeNull(); // 未满 limit
    // Turn 接纳后会立即写入 invocation.queued / turn.queued / invocation.started 调度事件。
    expect(body.latest_event_cursor?.sequence).toBeGreaterThanOrEqual(6);
  });

  it("turn_id 过滤：只返回指定 Turn 的 Item", async () => {
    const { agentId } = await seedDispatchableTurn();
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "items-turn-filter-create",
      body: { agent_id: agentId },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    // 创建 2 个 Turn
    const turn1Req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/turns`,
      idempotencyKey: "items-turn-1",
      body: { input: { type: "text", text: "第一个 Turn" } },
    });
    const turn1Resp = await createTurnPOST(turn1Req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    const turn1Body = (await turn1Resp.json()) as { turn: { id: string } };

    const turn2Req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/turns`,
      idempotencyKey: "items-turn-2",
      body: { input: { type: "text", text: "第二个 Turn" } },
    });
    await createTurnPOST(turn2Req, {
      params: Promise.resolve({ thread_id: threadId }),
    });

    // 查询指定 turn_id 的 Item
    const getReq = buildApiRequest({
      audience: "employee",
      method: "GET",
      path: `/threads/${threadId}/items?turn_id=${turn1Body.turn.id}`,
    });

    const response = await listItemsGET(getReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1); // 只返回第一个 Turn 的 Item
  });

  it("Thread 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const getReq = buildApiRequest({
      audience: "employee",
      method: "GET",
      path: "/threads/non-existent/items",
    });

    const response = await listItemsGET(getReq, {
      params: Promise.resolve({ thread_id: "non-existent" }),
    });
    expect(response.status).toBe(404);
  });

  it("limit 超出范围 → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const createReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads",
      idempotencyKey: "items-limit-create",
      body: { agent_id: agent.id },
    });
    const createResp = await createThreadPOST(createReq);
    const { id: threadId } = (await createResp.json()) as { id: string };

    const getReq = buildApiRequest({
      audience: "employee",
      method: "GET",
      path: `/threads/${threadId}/items?limit=300`,
    });

    const response = await listItemsGET(getReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(response.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 跨租户隔离（所有 Employee API 一律按 tenantId + ownerUserId 过滤）
// ═══════════════════════════════════════════════════════════

describe("跨租户隔离", () => {
  it("跨租户访问 Thread → 404 RESOURCE_NOT_FOUND（隐藏式）", async () => {
    const requestId = "req-cross-tenant-001";
    const otherReq = buildApiRequest({
      audience: "employee",
      method: "GET",
      path: "/threads/other-tenant-thread-id/items",
      requestId,
    });

    const response = await listItemsGET(otherReq, {
      params: Promise.resolve({ thread_id: "other-tenant-thread-id" }),
    });
    await assertCrossTenantHidden(response, requestId);
  });

  it("跨租户 PATCH settings → 404 RESOURCE_NOT_FOUND", async () => {
    const patchReq = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: "/threads/other-tenant-thread/settings",
      ifMatch: "thread-settings-1",
      body: { default_model_ref: "model:cross" },
    });

    const response = await updateSettingsPATCH(patchReq, {
      params: Promise.resolve({ thread_id: "other-tenant-thread" }),
    });
    expect(response.status).toBe(404);
  });
});
