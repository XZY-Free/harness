/**
 * S10-W02：GET /api/v1/threads/{thread_id}/turns 集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - 返回 Turn 列表（按 turn_sequence 升序）。
 * - 支持 limit 参数。
 * - limit 非法 → 400 REQUEST_SCHEMA_INVALID。
 * - 非 owner → 404 隐藏式。
 * - 跨租户（不存在的 thread_id）→ 404 隐藏式。
 */
import { GET } from "@/app/api/v1/threads/[thread_id]/turns/route";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildV11Request } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { acceptUserMessageTurn } from "@/lib/v11/conversation/turn-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

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
    agentKey: "finance-agent",
    displayName: "Finance Agent",
    ownerUserId: identity.id,
    lifecycleState: "enabled",
  });
  return { tenantId: tenant.id, userIdentityId: identity.id, agent };
}

describe("GET /api/v1/threads/{thread_id}/turns", () => {
  it("返回 Turn 列表（按 turn_sequence 升序）", async () => {
    const { tenantId, userIdentityId, agent } = await seedContext();

    const { thread } = await createThread({
      tenantId,
      ownerUserId: userIdentityId,
      primaryAgentId: agent.id,
      actorId: userIdentityId,
    });

    const { turn: turn1 } = await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: userIdentityId,
      content: { text: "Message 1", client_message_id: "msg-1" },
      actorId: userIdentityId,
    });
    const { turn: turn2 } = await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: userIdentityId,
      content: { text: "Message 2", client_message_id: "msg-2" },
      actorId: userIdentityId,
    });
    const { turn: turn3 } = await acceptUserMessageTurn({
      tenantId,
      threadId: thread.id,
      ownerUserId: userIdentityId,
      content: { text: "Message 3", client_message_id: "msg-3" },
      actorId: userIdentityId,
    });

    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: `/threads/${thread.id}/turns`,
    });

    const response = await GET(request, {
      params: Promise.resolve({ thread_id: thread.id }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.turns).toHaveLength(3);
    expect(body.turns[0].id).toBe(turn1.id);
    expect(body.turns[0].turn_sequence).toBe(1);
    expect(body.turns[1].id).toBe(turn2.id);
    expect(body.turns[1].turn_sequence).toBe(2);
    expect(body.turns[2].id).toBe(turn3.id);
    expect(body.turns[2].turn_sequence).toBe(3);
  });

  it("支持 limit 参数（截断 Turn 列表）", async () => {
    const { tenantId, userIdentityId, agent } = await seedContext();

    const { thread } = await createThread({
      tenantId,
      ownerUserId: userIdentityId,
      primaryAgentId: agent.id,
      actorId: userIdentityId,
    });

    for (let i = 1; i <= 3; i++) {
      await acceptUserMessageTurn({
        tenantId,
        threadId: thread.id,
        ownerUserId: userIdentityId,
        content: { text: `Message ${i}`, client_message_id: `msg-${i}` },
        actorId: userIdentityId,
      });
    }

    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: `/threads/${thread.id}/turns?limit=2`,
    });

    const response = await GET(request, {
      params: Promise.resolve({ thread_id: thread.id }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.turns).toHaveLength(2);
    // 截断的是头 2 个 Turn（按 turn_sequence 升序）
    expect(body.turns[0].turn_sequence).toBe(1);
    expect(body.turns[1].turn_sequence).toBe(2);
  });

  it("limit 超过 200 → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId, userIdentityId, agent } = await seedContext();

    const { thread } = await createThread({
      tenantId,
      ownerUserId: userIdentityId,
      primaryAgentId: agent.id,
      actorId: userIdentityId,
    });

    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: `/threads/${thread.id}/turns?limit=999`,
    });

    const response = await GET(request, {
      params: Promise.resolve({ thread_id: thread.id }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("limit 非数字 → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId, userIdentityId, agent } = await seedContext();

    const { thread } = await createThread({
      tenantId,
      ownerUserId: userIdentityId,
      primaryAgentId: agent.id,
      actorId: userIdentityId,
    });

    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: `/threads/${thread.id}/turns?limit=abc`,
    });

    const response = await GET(request, {
      params: Promise.resolve({ thread_id: thread.id }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("无 Turn → 返回空数组", async () => {
    const { tenantId, userIdentityId, agent } = await seedContext();

    const { thread } = await createThread({
      tenantId,
      ownerUserId: userIdentityId,
      primaryAgentId: agent.id,
      actorId: userIdentityId,
    });

    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: `/threads/${thread.id}/turns`,
    });

    const response = await GET(request, {
      params: Promise.resolve({ thread_id: thread.id }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.turns).toEqual([]);
  });

  it("非 owner → 404 隐藏式", async () => {
    const { tenantId, agent } = await seedContext();

    const otherOwner = "other-owner-002";
    const { thread } = await createThread({
      tenantId,
      ownerUserId: otherOwner,
      primaryAgentId: agent.id,
      actorId: otherOwner,
    });

    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: `/threads/${thread.id}/turns`,
    });

    const response = await GET(request, {
      params: Promise.resolve({ thread_id: thread.id }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("跨租户（不存在的 thread_id）→ 404 隐藏式", async () => {
    await seedContext();

    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/threads/non-existent-thread-id/turns",
    });

    const response = await GET(request, {
      params: Promise.resolve({ thread_id: "non-existent-thread-id" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });
});
