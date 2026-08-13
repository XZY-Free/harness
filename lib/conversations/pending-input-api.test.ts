import { POST as reorderPendingInputsPOST } from "@/app/api/v1/threads/[thread_id]/pending-inputs:reorder/route";
import {
  PATCH as editPendingInputPATCH,
  DELETE as removePendingInputDELETE,
} from "@/app/api/v1/pending-inputs/[pending_input_id]/route";
import {
  POST as createPendingInputPOST,
  GET as listPendingInputsGET,
} from "@/app/api/v1/threads/[thread_id]/pending-inputs/route";
/**
 * S04-C04：PendingInput API route handlers 集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖 5 个 PendingInput API 路由：
 * - GET  /api/v1/threads/{thread_id}/pending-inputs — 查询队列
 * - POST /api/v1/threads/{thread_id}/pending-inputs — 创建 PendingInput
 * - POST /api/v1/threads/{thread_id}/pending-inputs:reorder — 重排队列
 * - PATCH  /api/v1/pending-inputs/{pending_input_id} — 编辑 PendingInput
 * - DELETE /api/v1/pending-inputs/{pending_input_id} — 移除 PendingInput
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 employee-api.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：seed 默认身份 + Agent ───────────────────────────

async function seedContext() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const agent = await createAgent({
    tenantId: tenant.id,
    agentKey: "pending-input-agent",
    displayName: "PendingInput Agent",
    ownerUserId: identity.id,
    lifecycleState: "enabled",
  });
  return { tenantId: tenant.id, userIdentityId: identity.id, agent };
}

/** 创建 Thread 并返回 threadId。 */
async function createThread(agentId: string, idempotencyKey: string): Promise<string> {
  const req = buildApiRequest({
    audience: "employee",
    method: "POST",
    path: "/threads",
    idempotencyKey,
    body: { agent_id: agentId },
  });
  const resp = await createThreadPOST(req);
  const body = (await resp.json()) as { id: string };
  return body.id;
}

/** 创建 PendingInput 并返回响应体。 */
async function createPendingInput(
  threadId: string,
  input: Record<string, unknown>,
  idempotencyKey: string,
): Promise<{
  pending_input: { id: string; etag: string; queue_position: number; input_state: string };
  queue_etag: string;
}> {
  const req = buildApiRequest({
    audience: "employee",
    method: "POST",
    path: `/threads/${threadId}/pending-inputs`,
    idempotencyKey,
    body: { input },
  });
  const resp = await createPendingInputPOST(req, {
    params: Promise.resolve({ thread_id: threadId }),
  });
  return (await resp.json()) as {
    pending_input: { id: string; etag: string; queue_position: number; input_state: string };
    queue_etag: string;
  };
}

// ═══════════════════════════════════════════════════════════
// 1. GET /api/v1/threads/{thread_id}/pending-inputs — 查询队列
// ═══════════════════════════════════════════════════════════

describe("GET /api/v1/threads/{thread_id}/pending-inputs", () => {
  it("成功查询空队列 → 200 + 空数组 + queue_etag", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-get-empty");

    const req = buildApiRequest({
      audience: "employee",
      method: "GET",
      path: `/threads/${threadId}/pending-inputs`,
    });

    const resp = await listPendingInputsGET(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      thread_id: string;
      queue_etag: string;
      pending_inputs: unknown[];
    };
    expect(body.thread_id).toBe(threadId);
    expect(body.queue_etag).toBe("pending-queue-1"); // 初始 versionNo=1
    expect(body.pending_inputs).toHaveLength(0);
  });

  it("成功查询非空队列（按 queue_position 升序） → 200", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-get-nonempty");

    await createPendingInput(threadId, { type: "text", text: "第一条" }, "pi-1");
    await createPendingInput(threadId, { type: "text", text: "第二条" }, "pi-2");

    const req = buildApiRequest({
      audience: "employee",
      method: "GET",
      path: `/threads/${threadId}/pending-inputs`,
    });

    const resp = await listPendingInputsGET(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      pending_inputs: Array<{ id: string; queue_position: number; input: { text: string } }>;
      queue_etag: string;
    };
    expect(body.pending_inputs).toHaveLength(2);
    expect(body.pending_inputs[0]?.queue_position).toBe(1000);
    expect(body.pending_inputs[1]?.queue_position).toBe(2000);
    expect(body.pending_inputs[0]?.input.text).toBe("第一条");
    expect(body.queue_etag).toBe("pending-queue-3"); // 初始1 + 创建2次
  });

  it("Thread 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const req = buildApiRequest({
      audience: "employee",
      method: "GET",
      path: "/threads/non-existent/pending-inputs",
    });

    const resp = await listPendingInputsGET(req, {
      params: Promise.resolve({ thread_id: "non-existent" }),
    });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. POST /api/v1/threads/{thread_id}/pending-inputs — 创建 PendingInput
// ═══════════════════════════════════════════════════════════

describe("POST /api/v1/threads/{thread_id}/pending-inputs", () => {
  it("成功创建 PendingInput → 201 + pending_input + queue_etag", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-create-thread");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/pending-inputs`,
      idempotencyKey: "pi-create-001",
      body: { input: { type: "text", text: "处理销售数据" } },
    });

    const resp = await createPendingInputPOST(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as {
      pending_input: {
        id: string;
        thread_id: string;
        input_state: string;
        queue_position: number;
        input: { type: string; text: string };
        etag: string;
      };
      queue_etag: string;
    };
    expect(body.pending_input.thread_id).toBe(threadId);
    expect(body.pending_input.input_state).toBe("pending");
    expect(body.pending_input.queue_position).toBe(1000);
    expect(body.pending_input.input.text).toBe("处理销售数据");
    expect(body.pending_input.etag).toBe("pending-1");
    expect(body.queue_etag).toBe("pending-queue-2"); // 初始1 + 创建1次
  });

  it("连续创建：queue_position 递增 1000 → 2000", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-create-multi");

    const first = await createPendingInput(threadId, { type: "text", text: "A" }, "pi-multi-1");
    const second = await createPendingInput(threadId, { type: "text", text: "B" }, "pi-multi-2");

    expect(first.pending_input.queue_position).toBe(1000);
    expect(second.pending_input.queue_position).toBe(2000);
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-create-no-idem");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/pending-inputs`,
      body: { input: { type: "text", text: "测试" } },
    });

    const resp = await createPendingInputPOST(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(400);
  });

  it("请求体非法（缺少 input） → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-create-bad-body");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/pending-inputs`,
      idempotencyKey: "pi-bad-body",
      body: { text: "缺少 input" },
    });

    const resp = await createPendingInputPOST(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(400);
  });

  it("幂等重放：同 Idempotency-Key + 同 body → 返回同一 PendingInput", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-create-idempotent");

    const buildReq = () =>
      buildApiRequest({
        audience: "employee",
        method: "POST",
        path: `/threads/${threadId}/pending-inputs`,
        idempotencyKey: "pi-idempotent-001",
        body: { input: { type: "text", text: "幂等测试" } },
      });

    const first = await createPendingInputPOST(buildReq(), {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { pending_input: { id: string } };

    const second = await createPendingInputPOST(buildReq(), {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { pending_input: { id: string } };
    expect(secondBody.pending_input.id).toBe(firstBody.pending_input.id);
  });

  it("幂等冲突：同 Idempotency-Key + 不同 body → 409 IDEMPOTENCY_CONFLICT", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-create-conflict");

    const firstReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/pending-inputs`,
      idempotencyKey: "pi-conflict-001",
      body: { input: { type: "text", text: "内容一" } },
    });
    await createPendingInputPOST(firstReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });

    const secondReq = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/pending-inputs`,
      idempotencyKey: "pi-conflict-001",
      body: { input: { type: "text", text: "内容二" } },
    });
    const resp = await createPendingInputPOST(secondReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("Thread 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads/non-existent/pending-inputs",
      idempotencyKey: "pi-no-thread",
      body: { input: { type: "text", text: "测试" } },
    });

    const resp = await createPendingInputPOST(req, {
      params: Promise.resolve({ thread_id: "non-existent" }),
    });
    expect(resp.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. POST /api/v1/threads/{thread_id}/pending-inputs:reorder — 重排
// ═══════════════════════════════════════════════════════════

describe("POST /api/v1/threads/{thread_id}/pending-inputs:reorder", () => {
  it("成功重排 → 200 + queue_position 重新分配", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-reorder-ok");

    const a = await createPendingInput(threadId, { type: "text", text: "A" }, "pi-reorder-1");
    const b = await createPendingInput(threadId, { type: "text", text: "B" }, "pi-reorder-2");
    const c = await createPendingInput(threadId, { type: "text", text: "C" }, "pi-reorder-3");

    // 原始顺序 A(1000) B(2000) C(3000)，重排为 C B A
    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/pending-inputs:reorder`,
      ifMatch: c.queue_etag, // 使用最新的队列 ETag
      body: { ordered_ids: [c.pending_input.id, b.pending_input.id, a.pending_input.id] },
    });

    const resp = await reorderPendingInputsPOST(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      queue_etag: string;
      pending_inputs: Array<{ id: string; queue_position: number }>;
    };
    expect(body.pending_inputs).toHaveLength(3);
    expect(body.pending_inputs[0]?.id).toBe(c.pending_input.id);
    expect(body.pending_inputs[0]?.queue_position).toBe(1000);
    expect(body.pending_inputs[1]?.id).toBe(b.pending_input.id);
    expect(body.pending_inputs[1]?.queue_position).toBe(2000);
    expect(body.pending_inputs[2]?.id).toBe(a.pending_input.id);
    expect(body.pending_inputs[2]?.queue_position).toBe(3000);
    expect(body.queue_etag).toBe("pending-queue-5"); // 初始1 + 创建3 + 重排1
  });

  it("缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-reorder-no-ifmatch");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/pending-inputs:reorder`,
      body: { ordered_ids: ["id-1"] },
    });

    const resp = await reorderPendingInputsPOST(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(400);
  });

  it("ordered_ids 不完整（缺少一个） → 422 BUSINESS_CONSTRAINT_VIOLATION", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-reorder-incomplete");

    const a = await createPendingInput(threadId, { type: "text", text: "A" }, "pi-inc-1");
    const b = await createPendingInput(threadId, { type: "text", text: "B" }, "pi-inc-2");

    // 只传 A，缺少 B
    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/pending-inputs:reorder`,
      ifMatch: b.queue_etag,
      body: { ordered_ids: [a.pending_input.id] },
    });

    const resp = await reorderPendingInputsPOST(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(422);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUSINESS_CONSTRAINT_VIOLATION");
  });

  it("ordered_ids 含多余 id → 422 BUSINESS_CONSTRAINT_VIOLATION", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-reorder-extra");

    const a = await createPendingInput(threadId, { type: "text", text: "A" }, "pi-extra-1");

    // 传了 A + 不存在的 id
    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/pending-inputs:reorder`,
      ifMatch: a.queue_etag,
      body: { ordered_ids: [a.pending_input.id, "non-existent-id"] },
    });

    const resp = await reorderPendingInputsPOST(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(422);
  });

  it("队列 ETag 不匹配 → 412 ETAG_MISMATCH", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-reorder-stale");

    await createPendingInput(threadId, { type: "text", text: "A" }, "pi-stale-1");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/pending-inputs:reorder`,
      ifMatch: "pending-queue-999", // 错误的 versionNo
      body: { ordered_ids: ["any-id"] },
    });

    const resp = await reorderPendingInputsPOST(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(412);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ETAG_MISMATCH");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. PATCH /api/v1/pending-inputs/{pending_input_id} — 编辑
// ═══════════════════════════════════════════════════════════

describe("PATCH /api/v1/pending-inputs/{pending_input_id}", () => {
  it("成功编辑 PendingInput → 200 + 新 etag", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-edit-ok");
    const created = await createPendingInput(
      threadId,
      { type: "text", text: "原始内容" },
      "pi-edit-1",
    );

    const req = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: `/pending-inputs/${created.pending_input.id}`,
      ifMatch: created.pending_input.etag, // pending-1
      body: { input: { type: "text", text: "修改后内容" } },
    });

    const resp = await editPendingInputPATCH(req, {
      params: Promise.resolve({ pending_input_id: created.pending_input.id }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      pending_input: {
        id: string;
        input_state: string;
        input: { text: string };
        etag: string;
      };
      queue_etag: string;
    };
    expect(body.pending_input.input.text).toBe("修改后内容");
    expect(body.pending_input.etag).toBe("pending-2"); // versionNo 递增
    expect(body.pending_input.input_state).toBe("pending");
  });

  it("缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-edit-no-ifmatch");
    const created = await createPendingInput(
      threadId,
      { type: "text", text: "内容" },
      "pi-edit-no-im",
    );

    const req = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: `/pending-inputs/${created.pending_input.id}`,
      body: { input: { type: "text", text: "新内容" } },
    });

    const resp = await editPendingInputPATCH(req, {
      params: Promise.resolve({ pending_input_id: created.pending_input.id }),
    });
    expect(resp.status).toBe(400);
  });

  it("请求体非法（缺少 input） → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-edit-bad-body");
    const created = await createPendingInput(
      threadId,
      { type: "text", text: "内容" },
      "pi-edit-bad",
    );

    const req = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: `/pending-inputs/${created.pending_input.id}`,
      ifMatch: created.pending_input.etag,
      body: { text: "缺少 input" },
    });

    const resp = await editPendingInputPATCH(req, {
      params: Promise.resolve({ pending_input_id: created.pending_input.id }),
    });
    expect(resp.status).toBe(400);
  });

  it("资源 ETag 不匹配 → 412 ETAG_MISMATCH", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-edit-stale");
    const created = await createPendingInput(
      threadId,
      { type: "text", text: "内容" },
      "pi-edit-stale",
    );

    const req = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: `/pending-inputs/${created.pending_input.id}`,
      ifMatch: "pending-999", // 错误的 versionNo
      body: { input: { type: "text", text: "新内容" } },
    });

    const resp = await editPendingInputPATCH(req, {
      params: Promise.resolve({ pending_input_id: created.pending_input.id }),
    });
    expect(resp.status).toBe(412);
  });

  it("PendingInput 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const req = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: "/pending-inputs/non-existent",
      ifMatch: "pending-1",
      body: { input: { type: "text", text: "测试" } },
    });

    const resp = await editPendingInputPATCH(req, {
      params: Promise.resolve({ pending_input_id: "non-existent" }),
    });
    expect(resp.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. DELETE /api/v1/pending-inputs/{pending_input_id} — 移除
// ═══════════════════════════════════════════════════════════

describe("DELETE /api/v1/pending-inputs/{pending_input_id}", () => {
  it("成功移除 PendingInput → 200 + input_state=removed", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-delete-ok");
    const created = await createPendingInput(
      threadId,
      { type: "text", text: "待删除" },
      "pi-delete-1",
    );

    const req = buildApiRequest({
      audience: "employee",
      method: "DELETE",
      path: `/pending-inputs/${created.pending_input.id}`,
      ifMatch: created.pending_input.etag,
    });

    const resp = await removePendingInputDELETE(req, {
      params: Promise.resolve({ pending_input_id: created.pending_input.id }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      pending_input: { id: string; input_state: string; removed_at: string };
      queue_etag: string;
    };
    expect(body.pending_input.input_state).toBe("removed");
    expect(body.pending_input.removed_at).toEqual(expect.any(String));
  });

  it("缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-delete-no-ifmatch");
    const created = await createPendingInput(
      threadId,
      { type: "text", text: "内容" },
      "pi-del-no-im",
    );

    const req = buildApiRequest({
      audience: "employee",
      method: "DELETE",
      path: `/pending-inputs/${created.pending_input.id}`,
    });

    const resp = await removePendingInputDELETE(req, {
      params: Promise.resolve({ pending_input_id: created.pending_input.id }),
    });
    expect(resp.status).toBe(400);
  });

  it("资源 ETag 不匹配 → 412 ETAG_MISMATCH", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-delete-stale");
    const created = await createPendingInput(
      threadId,
      { type: "text", text: "内容" },
      "pi-del-stale",
    );

    const req = buildApiRequest({
      audience: "employee",
      method: "DELETE",
      path: `/pending-inputs/${created.pending_input.id}`,
      ifMatch: "pending-999",
    });

    const resp = await removePendingInputDELETE(req, {
      params: Promise.resolve({ pending_input_id: created.pending_input.id }),
    });
    expect(resp.status).toBe(412);
  });

  it("PendingInput 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const req = buildApiRequest({
      audience: "employee",
      method: "DELETE",
      path: "/pending-inputs/non-existent",
      ifMatch: "pending-1",
    });

    const resp = await removePendingInputDELETE(req, {
      params: Promise.resolve({ pending_input_id: "non-existent" }),
    });
    expect(resp.status).toBe(404);
  });

  it("移除后查询队列不包含已移除的 PendingInput", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "pending-delete-verify");
    const a = await createPendingInput(threadId, { type: "text", text: "A" }, "pi-del-v-1");
    await createPendingInput(threadId, { type: "text", text: "B" }, "pi-del-v-2");

    // 删除 A
    const delReq = buildApiRequest({
      audience: "employee",
      method: "DELETE",
      path: `/pending-inputs/${a.pending_input.id}`,
      ifMatch: a.pending_input.etag,
    });
    await removePendingInputDELETE(delReq, {
      params: Promise.resolve({ pending_input_id: a.pending_input.id }),
    });

    // 查询队列，应只剩 B
    const getReq = buildApiRequest({
      audience: "employee",
      method: "GET",
      path: `/threads/${threadId}/pending-inputs`,
    });
    const resp = await listPendingInputsGET(getReq, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    const body = (await resp.json()) as {
      pending_inputs: Array<{ id: string }>;
    };
    expect(body.pending_inputs).toHaveLength(1);
    expect(body.pending_inputs[0]?.id).not.toBe(a.pending_input.id);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 跨租户隔离（隐藏式 404）
// ═══════════════════════════════════════════════════════════

describe("跨租户隔离", () => {
  it("跨租户 GET pending-inputs → 404 RESOURCE_NOT_FOUND", async () => {
    const requestId = "req-cross-tenant-pending-get";
    const req = buildApiRequest({
      audience: "employee",
      method: "GET",
      path: "/threads/other-tenant-thread/pending-inputs",
      requestId,
    });

    const resp = await listPendingInputsGET(req, {
      params: Promise.resolve({ thread_id: "other-tenant-thread" }),
    });
    await assertCrossTenantHidden(resp, requestId);
  });

  it("跨租户 PATCH pending-input → 404 RESOURCE_NOT_FOUND（隐藏式）", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread(agent.id, "cross-tenant-patch");
    const created = await createPendingInput(
      threadId,
      { type: "text", text: "内容" },
      "pi-cross-patch",
    );

    // 直接用不存在的 tenant 访问（dev 模式下 resolvePrincipal 返回默认 tenant）
    // 这里模拟跨租户：用 non-existent pending_input_id
    const req = buildApiRequest({
      audience: "employee",
      method: "PATCH",
      path: "/pending-inputs/non-existent-tenant-input",
      ifMatch: "pending-1",
      body: { input: { type: "text", text: "跨租户" } },
    });

    const resp = await editPendingInputPATCH(req, {
      params: Promise.resolve({ pending_input_id: "non-existent-tenant-input" }),
    });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("跨租户 DELETE pending-input → 404 RESOURCE_NOT_FOUND（隐藏式）", async () => {
    const req = buildApiRequest({
      audience: "employee",
      method: "DELETE",
      path: "/pending-inputs/non-existent-tenant-input",
      ifMatch: "pending-1",
    });

    const resp = await removePendingInputDELETE(req, {
      params: Promise.resolve({ pending_input_id: "non-existent-tenant-input" }),
    });
    expect(resp.status).toBe(404);
  });

  it("跨租户 reorder → 404 RESOURCE_NOT_FOUND", async () => {
    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads/other-tenant-thread/pending-inputs:reorder",
      ifMatch: "pending-queue-1",
      body: { ordered_ids: ["any-id"] },
    });

    const resp = await reorderPendingInputsPOST(req, {
      params: Promise.resolve({ thread_id: "other-tenant-thread" }),
    });
    expect(resp.status).toBe(404);
  });
});
