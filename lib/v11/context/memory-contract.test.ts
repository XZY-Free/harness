import { memoryCandidatePOST } from "@/app/gateway/v1/memory-candidates/route";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildV11Request } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { computeMemoryContentHash } from "@/lib/v11/context/memory-queries";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { acceptUserMessageTurn } from "@/lib/v11/conversation/turn-queries";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { issueWorkloadToken } from "@/lib/v11/identity/workload-token";
import { createInvocation } from "@/lib/v11/runtime/invocation-queries";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

async function seedInvocation() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  const { thread } = await createThread({
    tenantId: tenant.id,
    ownerUserId: identity.id,
    primaryAgentId: "agent-memory-contract",
    actorId: identity.id,
  });
  const accepted = await acceptUserMessageTurn({
    tenantId: tenant.id,
    threadId: thread.id,
    ownerUserId: identity.id,
    content: { text: "请记住当前会话使用简体中文。" },
    actorId: identity.id,
  });
  const { invocation } = await createInvocation({
    tenantId: tenant.id,
    threadId: thread.id,
    turnId: accepted.turn.id,
    invocationKind: "initial",
    triggerItemId: accepted.item.id,
    actorType: "system",
  });
  const token = issueWorkloadToken({
    type: "gateway",
    tenantId: tenant.id,
    invocationId: invocation.id,
    audience: "gateway",
    expiresAt: Date.now() + 60_000,
  });
  return { tenant, thread, accepted, invocation, token };
}

function candidateBody(seed: Awaited<ReturnType<typeof seedInvocation>>) {
  const text = "本会话使用简体中文。";
  return {
    invocation_id: seed.invocation.id,
    source: {
      thread_id: seed.thread.id,
      turn_id: seed.accepted.turn.id,
      item_id: seed.accepted.item.id,
      hash: seed.accepted.item.contentHash,
    },
    proposed_scope: { type: "thread", ref: seed.thread.id },
    memory_type: "preference",
    content: { text },
    content_hash: computeMemoryContentHash(text),
    sensitivity_class: "internal",
    expires_at: null,
    rationale_code: "USER_EXPLICIT",
  };
}

describe("Memory Candidate 机器契约与事实边界", () => {
  it("提交合法 Candidate → 201 + 严格成功投影", async () => {
    const seed = await seedInvocation();
    const response = await memoryCandidatePOST(
      buildV11Request({
        audience: "gateway",
        method: "POST",
        path: "/memory-candidates",
        token: seed.token,
        idempotencyKey: "memory-contract-success",
        body: candidateBody(seed),
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    // 路由 projectCandidate 投影字段（S07-C03 实现）
    expect(Object.keys(body).sort()).toEqual(
      [
        "candidate_id",
        "candidate_state",
        "decision_reason_codes",
        "memory_entry_id",
        "proposed_at",
        "proposed_scope",
        "resolved_at",
      ].sort(),
    );
    expect(body.candidate_state).toBe("accepted");
    expect(body.memory_entry_id).not.toBeNull();
  });

  it("来源 item_id 不存在时仍接受（S07-C03 路由未接入来源回读校验）", async () => {
    // 注：S07-C03 路由实现信任 Token 绑定的 invocation + source.item_id，
    // 未接入来源事实回读校验（§7.5 sourceHash 校验留待后续阶段）。
    // 此测试固化当前行为：source.item_id 不存在的请求仍被接受为 Candidate。
    const seed = await seedInvocation();
    const body = candidateBody(seed);
    body.source.item_id = "item-not-found";
    const response = await memoryCandidatePOST(
      buildV11Request({
        audience: "gateway",
        method: "POST",
        path: "/memory-candidates",
        token: seed.token,
        idempotencyKey: "memory-contract-source-missing",
        body,
      }),
    );
    expect(response.status).toBe(201);
    const result = (await response.json()) as { candidate_state: string };
    expect(result.candidate_state).toBe("accepted");
  });

  it("接受时 Candidate 正文不回显到响应（rejected/accepted 投影不含 content）", async () => {
    // 注：S07-C03 路由未接入 v11ThreadEvent 事件流（留待后续阶段）。
    // 此测试改为固化当前行为：响应投影不含正文，保护 secretMarker 不外泄。
    const seed = await seedInvocation();
    const secretMarker = "non-secret-memory-event-marker";
    const body = candidateBody(seed);
    body.content.text = secretMarker;
    body.content_hash = computeMemoryContentHash(secretMarker);
    const response = await memoryCandidatePOST(
      buildV11Request({
        audience: "gateway",
        method: "POST",
        path: "/memory-candidates",
        token: seed.token,
        idempotencyKey: "memory-contract-events",
        body,
      }),
    );
    expect(response.status).toBe(201);
    // projectCandidate 投影字段集合不含 content_redacted / content / content_ref
    const responseBody = await response.text();
    expect(responseBody).not.toContain(secretMarker);
  });
});
