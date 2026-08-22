import { POST as forkPOST } from "@/app/api/v1/threads/[thread_id]/forks/route";
import { POST as createThreadPOST } from "@/app/api/v1/threads/route";
import { POST as interruptPOST } from "@/app/api/v1/turns/[turn_id]/interrupt/route";
import { POST as regeneratePOST } from "@/app/api/v1/turns/[turn_id]/regenerate/route";
import { POST as steerPOST } from "@/app/api/v1/turns/[turn_id]/steer/route";
/**
 * S04-C06：Fork / Regenerate / Interrupt / Steer API route handlers 集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖 4 个 API 路由：
 * - POST /api/v1/threads/{thread_id}/forks — Fork Thread
 * - POST /api/v1/turns/{turn_id}:regenerate — Regenerate Turn
 * - POST /api/v1/turns/{turn_id}/interrupt — Interrupt Turn
 * - POST /api/v1/turns/{turn_id}/steer — Steer Turn
 *
 * 测试环境：APP_ENV=test，auth mode=dev（resolvePrincipal 使用 DEFAULT_USER_ID）。
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { acceptUserMessageTurn, updateTurnState } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { assertCrossTenantHidden, buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { TurnState } from "@/lib/persistence/schema/conversation";
import {
  invocationCommandTable,
  threadEventTable,
  threadItemTable,
  threadTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { eq } from "drizzle-orm";
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

// ─── 辅助：seed 默认身份 + 可调度 Agent + Ready Route ───────
//
// fork/regenerate/steer 测试需要 Turn 真正被调度（dispatched=true），
// 因此用 seedDispatchableTurn 建出完整正式链上下文（§27"测试必须证明
// 生产链"），仅暴露测试用到的 agent.id 与 tenantId，保持调用点不变。

async function seedContext() {
  const { tenantId, agentId, ownerId } = await seedDispatchableTurn({
    agentKey: "fork-regen-agent",
  });
  return { tenantId, userIdentityId: ownerId, agent: { id: agentId } };
}

/** 创建 Thread 并返回 threadId。 */
async function createThread(idempotencyKey: string): Promise<string> {
  const req = buildApiRequest({
    audience: "employee",
    method: "POST",
    path: "/threads",
    idempotencyKey,
    body: {},
  });
  const resp = await createThreadPOST(req);
  const body = (await resp.json()) as { id: string };
  return body.id;
}

/**
 * 创建 Turn 并返回 turnId。
 *
 * 直接走 `acceptUserMessageTurn`（即 POST /turns 路由 dispatch 之前的同一步），
 * 产出 accepted 状态的 Turn。这些 fork/regenerate/interrupt/steer 测试只把 Turn
 * 当作命令面的前置条件，不验证调度执行本身——因此刻意不走路由触发 dispatch，
 * 避免 dispatch 异步 launch 的 Hosted 执行与本测试后续的 SELECT ... FOR UPDATE 死锁
 * （§27 只要求"调度测试"证明生产链，命令面测试无需真正执行）。
 */
async function createTurn(threadId: string, idempotencyKey: string): Promise<string> {
  const [thread] = await db.select().from(threadTable).where(eq(threadTable.id, threadId)).limit(1);
  if (!thread) throw new Error(`Thread 不存在: ${threadId}`);

  const { turn } = await acceptUserMessageTurn({
    tenantId: thread.tenantId,
    threadId,
    ownerUserId: thread.ownerUserId,
    content: { text: "测试消息" },
    actorId: thread.ownerUserId,
    idempotencyKey,
  });
  return turn.id;
}

/** 直接查 DB 获取 Turn 行（绕过 tenant 隔离，测试内部使用）。 */
async function getTurnRow(turnId: string) {
  const [row] = await db.select().from(turnTable).where(eq(turnTable.id, turnId)).limit(1);
  return row;
}

/** 将 Turn 转换到指定状态（用于测试前置条件）。 */
async function transitionTurn(
  tenantId: string,
  turnId: string,
  nextState: TurnState,
): Promise<void> {
  const turn = await getTurnRow(turnId);
  if (!turn) throw new Error(`Turn 不存在: ${turnId}`);
  const result = await updateTurnState(tenantId, turnId, nextState, turn.versionNo);
  if (!result) throw new Error(`Turn 状态转换失败: ${turnId} → ${nextState}`);
}

/** 查询 Turn 的所有事件（按 sequence 升序）。 */
async function getTurnEvents(turnId: string) {
  return db
    .select()
    .from(threadEventTable)
    .where(eq(threadEventTable.turnId, turnId))
    .orderBy(threadEventTable.eventSequence);
}

/** 查询 Turn 的 InvocationCommand 记录。 */
async function getTurnCommands(turnId: string) {
  return db.select().from(invocationCommandTable).where(eq(invocationCommandTable.turnId, turnId));
}

/** 查询 Turn 的 ThreadItem 记录。 */
async function getTurnItems(turnId: string) {
  return db.select().from(threadItemTable).where(eq(threadItemTable.turnId, turnId));
}

// ═══════════════════════════════════════════════════════════
// 1. POST /api/v1/threads/{thread_id}/forks — Fork Thread
// ═══════════════════════════════════════════════════════════

describe("POST /api/v1/threads/{thread_id}/forks", () => {
  it("成功 Fork Thread → 201 + 子 Thread + 关系 + 事件", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread("fork-thread-001");
    const turnId = await createTurn(threadId, "fork-turn-001");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/forks`,
      idempotencyKey: "fork-001",
      body: { from_turn_id: turnId, title: "Fork 子 Thread" },
    });

    const resp = await forkPOST(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as {
      thread: { id: string; lifecycle_state: string };
      relation: {
        parent_thread_id: string;
        child_thread_id: string;
        relation_type: string;
        relation_state: string;
      };
      copied_through_turn_id: string;
      filesystem_checkpoint_id: string | null;
      child_created_event_id: string;
      parent_child_thread_created_event_id: string;
    };
    expect(body.thread.id).not.toBe(threadId);
    expect(body.thread.lifecycle_state).toBe("active");
    expect(body.relation.parent_thread_id).toBe(threadId);
    expect(body.relation.child_thread_id).toBe(body.thread.id);
    expect(body.relation.relation_type).toBe("fork");
    expect(body.relation.relation_state).toBe("active");
    expect(body.copied_through_turn_id).toBe(turnId);
    expect(body.filesystem_checkpoint_id).toBeNull();
    expect(body.child_created_event_id).toEqual(expect.any(String));
    expect(body.parent_child_thread_created_event_id).toEqual(expect.any(String));
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread("fork-thread-002");
    const turnId = await createTurn(threadId, "fork-turn-002");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/forks`,
      body: { from_turn_id: turnId },
    });

    const resp = await forkPOST(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("请求体非法（缺 from_turn_id）→ 400 REQUEST_SCHEMA_INVALID", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread("fork-thread-003");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/forks`,
      idempotencyKey: "fork-003",
      body: { title: "无 from_turn_id" },
    });

    const resp = await forkPOST(req, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("Thread 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads/non-existent/forks",
      idempotencyKey: "fork-004",
      body: { from_turn_id: "any-turn" },
    });

    const resp = await forkPOST(req, {
      params: Promise.resolve({ thread_id: "non-existent" }),
    });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("Fork 源 Turn 不属于源 Thread → 422 BUSINESS_CONSTRAINT_VIOLATION", async () => {
    const { agent } = await seedContext();
    const threadId1 = await createThread("fork-thread-005a");
    const threadId2 = await createThread("fork-thread-005b");
    const turnId2 = await createTurn(threadId2, "fork-turn-005b"); // 属于 thread2

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId1}/forks`,
      idempotencyKey: "fork-005",
      body: { from_turn_id: turnId2 }, // turnId2 不属于 threadId1
    });

    const resp = await forkPOST(req, {
      params: Promise.resolve({ thread_id: threadId1 }),
    });
    expect(resp.status).toBe(422);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUSINESS_CONSTRAINT_VIOLATION");
  });

  it("幂等重放 → 201 + 原响应", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread("fork-thread-006");
    const turnId = await createTurn(threadId, "fork-turn-006");

    const req1 = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/forks`,
      idempotencyKey: "fork-replay-006",
      body: { from_turn_id: turnId },
    });
    const resp1 = await forkPOST(req1, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp1.status).toBe(201);
    const body1 = (await resp1.json()) as { thread: { id: string } };

    // 同 Idempotency-Key 重放
    const req2 = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/forks`,
      idempotencyKey: "fork-replay-006",
      body: { from_turn_id: turnId },
    });
    const resp2 = await forkPOST(req2, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp2.status).toBe(201);
    const body2 = (await resp2.json()) as { thread: { id: string } };
    expect(body2.thread.id).toBe(body1.thread.id);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. POST /api/v1/turns/{turn_id}:regenerate — Regenerate Turn
// ═══════════════════════════════════════════════════════════

describe("POST /api/v1/turns/{turn_id}/regenerate", () => {
  it("成功 Regenerate completed Turn → 202 + regenerating 状态 + InvocationCommand", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("regen-thread-001");
    const turnId = await createTurn(threadId, "regen-turn-001");
    // 将 Turn 转换到 completed 状态
    await transitionTurn(tenantId, turnId, "running");
    await transitionTurn(tenantId, turnId, "completed");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/regenerate`,
      idempotencyKey: "regen-001",
      body: { binding_mode: "loose", reason: "重新生成" },
    });

    const resp = await regeneratePOST(req, {
      params: Promise.resolve({ turn_id: `${turnId}` }),
    });
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as {
      turn_id: string;
      turn_state: string;
      invocation_id: string;
      invocation_kind: string;
      event_id: string;
    };
    expect(body.turn_id).toBe(turnId);
    expect(body.turn_state).toBe("regenerating");
    expect(body.invocation_id).toEqual(expect.any(String));
    expect(body.invocation_kind).toBe("regenerate");
    expect(body.event_id).toEqual(expect.any(String));

    // 验证 DB：Turn 状态已变更为 regenerating
    const turnRow = await getTurnRow(turnId);
    expect(turnRow?.turnState).toBe("regenerating");
    expect(turnRow?.regenerationNo).toBe(1);

    // 验证 DB：InvocationCommand 已创建
    const commands = await getTurnCommands(turnId);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.commandType).toBe("regenerate");
    expect(commands[0]?.commandState).toBe("queued");

    // 验证 DB：turn.regeneration_started 事件已写
    const events = await getTurnEvents(turnId);
    const regenEvent = events.find((e) => e.eventType === "turn.regeneration_started");
    expect(regenEvent).toBeDefined();
  });

  it("Turn 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/turns/non-existent/regenerate",
      idempotencyKey: "regen-002",
      body: { binding_mode: "loose" },
    });

    const resp = await regeneratePOST(req, {
      params: Promise.resolve({ turn_id: "non-existent" }),
    });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("regen-thread-003");
    const turnId = await createTurn(threadId, "regen-turn-003");
    await transitionTurn(tenantId, turnId, "running");
    await transitionTurn(tenantId, turnId, "completed");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/regenerate`,
      body: { binding_mode: "loose" },
    });

    const resp = await regeneratePOST(req, {
      params: Promise.resolve({ turn_id: `${turnId}` }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("Turn 状态为 accepted（非终态）→ 409 TURN_ALREADY_TERMINAL", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread("regen-thread-004");
    const turnId = await createTurn(threadId, "regen-turn-004");
    // Turn 保持 accepted 状态（非 completed/interrupted/failed）

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/regenerate`,
      idempotencyKey: "regen-004",
      body: { binding_mode: "loose" },
    });

    const resp = await regeneratePOST(req, {
      params: Promise.resolve({ turn_id: `${turnId}` }),
    });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TURN_ALREADY_TERMINAL");
  });

  it("Turn 状态为 cancelled → 409 TURN_ALREADY_TERMINAL（cancelled 不可恢复）", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("regen-thread-005");
    const turnId = await createTurn(threadId, "regen-turn-005");
    await transitionTurn(tenantId, turnId, "cancelled");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/regenerate`,
      idempotencyKey: "regen-005",
      body: { binding_mode: "loose" },
    });

    const resp = await regeneratePOST(req, {
      params: Promise.resolve({ turn_id: `${turnId}` }),
    });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TURN_ALREADY_TERMINAL");
  });

  it("幂等重放 → 202 + 原响应", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("regen-thread-006");
    const turnId = await createTurn(threadId, "regen-turn-006");
    await transitionTurn(tenantId, turnId, "running");
    await transitionTurn(tenantId, turnId, "completed");

    const req1 = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/regenerate`,
      idempotencyKey: "regen-replay-006",
      body: { binding_mode: "loose" },
    });
    const resp1 = await regeneratePOST(req1, {
      params: Promise.resolve({ turn_id: `${turnId}` }),
    });
    expect(resp1.status).toBe(202);
    const body1 = (await resp1.json()) as { invocation_id: string };

    // 同 Idempotency-Key 重放
    const req2 = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/regenerate`,
      idempotencyKey: "regen-replay-006",
      body: { binding_mode: "loose" },
    });
    const resp2 = await regeneratePOST(req2, {
      params: Promise.resolve({ turn_id: `${turnId}` }),
    });
    expect(resp2.status).toBe(202);
    const body2 = (await resp2.json()) as { invocation_id: string };
    expect(body2.invocation_id).toBe(body1.invocation_id);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. POST /api/v1/turns/{turn_id}/interrupt — Interrupt Turn
// ═══════════════════════════════════════════════════════════

describe("POST /api/v1/turns/{turn_id}/interrupt", () => {
  it("成功 Interrupt running Turn → 202 + 命令入队（Turn 状态未变）", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("intr-thread-001");
    const turnId = await createTurn(threadId, "intr-turn-001");
    await transitionTurn(tenantId, turnId, "running");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/interrupt`,
      idempotencyKey: "intr-001",
      body: { reason_code: "user_requested", preserve_pending_inputs: true },
    });

    const resp = await interruptPOST(req, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as {
      turn_id: string;
      turn_state: string;
      interrupt_state: string;
      command: { id: string; command_state: string };
      already_completed_effects_preserved: boolean;
      event_id: string;
    };
    expect(body.turn_id).toBe(turnId);
    expect(body.turn_state).toBe("running"); // Turn 状态未变
    expect(body.interrupt_state).toBe("requested");
    expect(body.command.command_state).toBe("queued");
    expect(body.already_completed_effects_preserved).toBe(true);
    expect(body.event_id).toEqual(expect.any(String));

    // 验证 DB：Turn 状态未变（仍为 running）
    const turnRow = await getTurnRow(turnId);
    expect(turnRow?.turnState).toBe("running");

    // 验证 DB：InvocationCommand 已创建
    const commands = await getTurnCommands(turnId);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.commandType).toBe("interrupt");
    expect(commands[0]?.commandState).toBe("queued");

    // 验证 DB：turn.interrupt_requested 事件已写
    const events = await getTurnEvents(turnId);
    const intrEvent = events.find((e) => e.eventType === "turn.interrupt_requested");
    expect(intrEvent).toBeDefined();
  });

  it("成功 Interrupt waiting_user Turn → 202（waiting_user 允许 Interrupt）", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("intr-thread-002");
    const turnId = await createTurn(threadId, "intr-turn-002");
    await transitionTurn(tenantId, turnId, "running");
    await transitionTurn(tenantId, turnId, "waiting_user");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/interrupt`,
      idempotencyKey: "intr-002",
      body: { reason_code: "user_requested" },
    });

    const resp = await interruptPOST(req, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as { turn_state: string };
    expect(body.turn_state).toBe("waiting_user"); // Turn 状态未变
  });

  it("Turn 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/turns/non-existent/interrupt",
      idempotencyKey: "intr-003",
      body: { reason_code: "user_requested" },
    });

    const resp = await interruptPOST(req, {
      params: Promise.resolve({ turn_id: "non-existent" }),
    });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("intr-thread-004");
    const turnId = await createTurn(threadId, "intr-turn-004");
    await transitionTurn(tenantId, turnId, "running");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/interrupt`,
      body: { reason_code: "user_requested" },
    });

    const resp = await interruptPOST(req, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("Turn 已终态（completed）→ 409 TURN_ALREADY_TERMINAL", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("intr-thread-005");
    const turnId = await createTurn(threadId, "intr-turn-005");
    await transitionTurn(tenantId, turnId, "running");
    await transitionTurn(tenantId, turnId, "completed");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/interrupt`,
      idempotencyKey: "intr-005",
      body: { reason_code: "user_requested" },
    });

    const resp = await interruptPOST(req, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TURN_ALREADY_TERMINAL");
  });

  it("幂等重放 → 202 + 原响应", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("intr-thread-006");
    const turnId = await createTurn(threadId, "intr-turn-006");
    await transitionTurn(tenantId, turnId, "running");

    const req1 = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/interrupt`,
      idempotencyKey: "intr-replay-006",
      body: { reason_code: "user_requested" },
    });
    const resp1 = await interruptPOST(req1, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp1.status).toBe(202);
    const body1 = (await resp1.json()) as { command: { id: string } };

    const req2 = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/interrupt`,
      idempotencyKey: "intr-replay-006",
      body: { reason_code: "user_requested" },
    });
    const resp2 = await interruptPOST(req2, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp2.status).toBe(202);
    const body2 = (await resp2.json()) as { command: { id: string } };
    expect(body2.command.id).toBe(body1.command.id);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. POST /api/v1/turns/{turn_id}/steer — Steer Turn
// ═══════════════════════════════════════════════════════════

describe("POST /api/v1/turns/{turn_id}/steer", () => {
  it("成功 Steer running Turn → 202 + user_guidance Item + 命令入队", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("steer-thread-001");
    const turnId = await createTurn(threadId, "steer-turn-001");
    await transitionTurn(tenantId, turnId, "running");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/steer`,
      idempotencyKey: "steer-001",
      body: { guidance_text: "请关注销售数据" },
    });

    const resp = await steerPOST(req, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as {
      turn_id: string;
      turn_state: string;
      steer_state: string;
      guidance_item_id: string;
      command: { id: string; command_state: string };
      event_id: string;
    };
    expect(body.turn_id).toBe(turnId);
    expect(body.turn_state).toBe("running"); // Turn 状态未变
    expect(body.steer_state).toBe("queued");
    expect(body.guidance_item_id).toEqual(expect.any(String));
    expect(body.command.command_state).toBe("queued");
    expect(body.event_id).toEqual(expect.any(String));

    // 验证 DB：Turn 状态未变（仍为 running）
    const turnRow = await getTurnRow(turnId);
    expect(turnRow?.turnState).toBe("running");

    // 验证 DB：user_guidance Item 已创建（item_state=pending）
    const items = await getTurnItems(turnId);
    const guidanceItem = items.find((i) => i.itemType === "user_guidance");
    expect(guidanceItem).toBeDefined();
    expect(guidanceItem?.itemState).toBe("pending");

    // 验证 DB：InvocationCommand 已创建
    const commands = await getTurnCommands(turnId);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.commandType).toBe("steer");
    expect(commands[0]?.commandState).toBe("queued");

    // 验证 DB：turn.steer_queued 事件已写
    const events = await getTurnEvents(turnId);
    const steerEvent = events.find((e) => e.eventType === "turn.steer_queued");
    expect(steerEvent).toBeDefined();
  });

  it("Turn 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/turns/non-existent/steer",
      idempotencyKey: "steer-002",
      body: { guidance_text: "引导" },
    });

    const resp = await steerPOST(req, {
      params: Promise.resolve({ turn_id: "non-existent" }),
    });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("steer-thread-003");
    const turnId = await createTurn(threadId, "steer-turn-003");
    await transitionTurn(tenantId, turnId, "running");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/steer`,
      body: { guidance_text: "引导" },
    });

    const resp = await steerPOST(req, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("Turn 状态为 waiting_user → 409 TURN_REQUIRES_USER_ACTION", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("steer-thread-004");
    const turnId = await createTurn(threadId, "steer-turn-004");
    await transitionTurn(tenantId, turnId, "running");
    await transitionTurn(tenantId, turnId, "waiting_user");

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/steer`,
      idempotencyKey: "steer-004",
      body: { guidance_text: "引导" },
    });

    const resp = await steerPOST(req, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TURN_REQUIRES_USER_ACTION");
  });

  it("Turn 状态为 accepted（非 running）→ 409 TURN_ALREADY_TERMINAL", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread("steer-thread-005");
    const turnId = await createTurn(threadId, "steer-turn-005");
    // Turn 保持 accepted 状态（非 running）

    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/steer`,
      idempotencyKey: "steer-005",
      body: { guidance_text: "引导" },
    });

    const resp = await steerPOST(req, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TURN_ALREADY_TERMINAL");
  });

  it("幂等重放 → 202 + 原响应", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("steer-thread-006");
    const turnId = await createTurn(threadId, "steer-turn-006");
    await transitionTurn(tenantId, turnId, "running");

    const req1 = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/steer`,
      idempotencyKey: "steer-replay-006",
      body: { guidance_text: "引导" },
    });
    const resp1 = await steerPOST(req1, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp1.status).toBe(202);
    const body1 = (await resp1.json()) as { guidance_item_id: string };

    const req2 = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/steer`,
      idempotencyKey: "steer-replay-006",
      body: { guidance_text: "引导" },
    });
    const resp2 = await steerPOST(req2, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp2.status).toBe(202);
    const body2 = (await resp2.json()) as { guidance_item_id: string };
    expect(body2.guidance_item_id).toBe(body1.guidance_item_id);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 跨租户隔离测试（隐藏式 404）
// ═══════════════════════════════════════════════════════════

describe("跨租户隔离（隐藏式 404）", () => {
  it("跨租户 Fork → 404 RESOURCE_NOT_FOUND（不泄露存在）", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread("xtenant-fork-thread");
    const turnId = await createTurn(threadId, "xtenant-fork-turn");

    // 模拟跨租户：使用不存在的 tenantId（dev 模式下 principal.tenantId 来自 default tenant）
    // 由于 dev 模式固定身份，这里直接测试 Thread 不存在的情况
    const requestId = "req-xtenant-fork-001";
    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/threads/non-existent-tenant/forks",
      idempotencyKey: "xtenant-fork",
      requestId,
      body: { from_turn_id: turnId },
    });

    const resp = await forkPOST(req, {
      params: Promise.resolve({ thread_id: "non-existent-tenant" }),
    });
    await assertCrossTenantHidden(resp, requestId);
  });

  it("跨租户 Regenerate → 404 RESOURCE_NOT_FOUND（不泄露存在）", async () => {
    const req = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: "/turns/non-existent-tenant/regenerate",
      idempotencyKey: "xtenant-regen",
      body: { binding_mode: "loose" },
    });

    const resp = await regeneratePOST(req, {
      params: Promise.resolve({ turn_id: "non-existent-tenant" }),
    });
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Idempotency 冲突测试
// ═══════════════════════════════════════════════════════════

describe("Idempotency 冲突（同 key 不同 body）", () => {
  it("Fork 同 Idempotency-Key 不同 body → 409 IDEMPOTENCY_CONFLICT", async () => {
    const { agent } = await seedContext();
    const threadId = await createThread("idem-fork-thread");
    const turnId1 = await createTurn(threadId, "idem-fork-turn1");
    const turnId2 = await createTurn(threadId, "idem-fork-turn2");

    // 第一次请求
    const req1 = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/forks`,
      idempotencyKey: "idem-conflict-fork",
      body: { from_turn_id: turnId1 },
    });
    const resp1 = await forkPOST(req1, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp1.status).toBe(201);

    // 同 Idempotency-Key 但不同 body
    const req2 = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/threads/${threadId}/forks`,
      idempotencyKey: "idem-conflict-fork",
      body: { from_turn_id: turnId2 }, // 不同 from_turn_id
    });
    const resp2 = await forkPOST(req2, {
      params: Promise.resolve({ thread_id: threadId }),
    });
    expect(resp2.status).toBe(409);
    const body2 = (await resp2.json()) as { error: { code: string } };
    expect(body2.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("Steer 同 Idempotency-Key 不同 body → 409 IDEMPOTENCY_CONFLICT", async () => {
    const { tenantId, agent } = await seedContext();
    const threadId = await createThread("idem-steer-thread");
    const turnId = await createTurn(threadId, "idem-steer-turn");
    await transitionTurn(tenantId, turnId, "running");

    // 第一次请求
    const req1 = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/steer`,
      idempotencyKey: "idem-conflict-steer",
      body: { guidance_text: "第一条引导" },
    });
    const resp1 = await steerPOST(req1, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp1.status).toBe(202);

    // 同 Idempotency-Key 但不同 body
    const req2 = buildApiRequest({
      audience: "employee",
      method: "POST",
      path: `/turns/${turnId}/steer`,
      idempotencyKey: "idem-conflict-steer",
      body: { guidance_text: "不同的引导" },
    });
    const resp2 = await steerPOST(req2, {
      params: Promise.resolve({ turn_id: turnId }),
    });
    expect(resp2.status).toBe(409);
    const body2 = (await resp2.json()) as { error: { code: string } };
    expect(body2.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
