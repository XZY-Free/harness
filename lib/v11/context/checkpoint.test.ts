/**
 * V11 Context Checkpoint 集成测试（阶段 7 S07-C02）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §6（压缩）、§7（Trace）、§15（失败与恢复）。
 * - ../v11-agentkit-platform/10-core-data-model.md §7.5（context_checkpoint 表）。
 * - ../v11-agentkit-platform/13-memory-and-job-api.md §3（Context Checkpoint API）。
 *
 * 覆盖：
 * - checkpoint-queries：computeSourceRangesHash / createContextCheckpoint / findContextCheckpointByUniqueKey / getContextCheckpointById / getContextCheckpointsByInvocation。
 * - POST /gateway/v1/context-checkpoints：鉴权 / 请求体校验 / 幂等 / 创建 / 跨租户隔离 / 重复去重。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。Gateway Token 由 issueWorkloadToken 构造。
 */
import { randomUUID } from "node:crypto";
import { contextCheckpointPOST } from "@/app/gateway/v1/context-checkpoints/route";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildV11Request, withRollback } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  computeSourceRangesHash,
  computeSummaryHash,
  createContextCheckpoint,
  findContextCheckpointByUniqueKey,
  getContextCheckpointById,
  getContextCheckpointsByInvocation,
  isValidSummaryHash,
} from "@/lib/v11/context/checkpoint-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { type WorkloadTokenClaims, issueWorkloadToken } from "@/lib/identity/workload-token";
import { contextCheckpoint } from "@/lib/v11/schema/context-checkpoint";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：seed 默认租户 + 用户身份 ────────────────────────

async function seedContext() {
  const t = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: t.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  return { tenantId: t.id, userIdentityId: identity.id };
}

/** 构造 Gateway Workload Token。 */
function makeGatewayToken(
  tenantId: string,
  invocationId: string,
  overrides: Partial<Omit<WorkloadTokenClaims, "issuedAt">> = {},
): string {
  const claims: Omit<WorkloadTokenClaims, "issuedAt"> = {
    type: "gateway",
    tenantId,
    jti: "jti-gateway-checkpoint-001",
    invocationId,
    audience: "gateway",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
  return issueWorkloadToken(claims);
}

/** 构造合法 source_ranges（API 格式，snake_case）。 */
function makeSourceRanges() {
  return [
    {
      type: "thread_item",
      from_sequence: 1,
      to_sequence: 10,
      range_hash: `sha256:${"a".repeat(64)}`,
    },
  ];
}

/** 构造合法请求体。 */
function makeBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  const summaryText = "用户要求分析销售异常，已确认口径……";
  return {
    invocation_id: "inv_test_001",
    checkpoint_type: "compression",
    source_ranges: makeSourceRanges(),
    summary: { text: summaryText },
    summary_hash: computeSummaryHash(summaryText),
    token_accounting: { input: 32000, retained: 7200, compressed: 24800 },
    ...overrides,
  };
}

describe("checkpoint-queries", () => {
  it("computeSourceRangesHash：返回 sha256: 前缀 + 64 hex", () => {
    const ranges = [
      {
        type: "thread_item" as const,
        fromSequence: 1,
        toSequence: 10,
        rangeHash: "sha256:abc",
      },
    ];
    const hash = computeSourceRangesHash(ranges);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("computeSourceRangesHash：相同内容不同顺序产生相同 hash", () => {
    const ranges1 = [
      { type: "thread_item" as const, rangeHash: "sha256:a" },
      { type: "thread_event" as const, rangeHash: "sha256:b" },
    ];
    const ranges2 = [
      { type: "thread_event" as const, rangeHash: "sha256:b" },
      { type: "thread_item" as const, rangeHash: "sha256:a" },
    ];
    expect(computeSourceRangesHash(ranges1)).toBe(computeSourceRangesHash(ranges2));
  });

  it("computeSourceRangesHash：不同内容产生不同 hash", () => {
    const ranges1 = [{ type: "thread_item" as const, rangeHash: "sha256:a" }];
    const ranges2 = [{ type: "thread_item" as const, rangeHash: "sha256:b" }];
    expect(computeSourceRangesHash(ranges1)).not.toBe(computeSourceRangesHash(ranges2));
  });

  it("isValidSummaryHash：合法格式 true / 非法 false", () => {
    expect(isValidSummaryHash(`sha256:${"0".repeat(64)}`)).toBe(true);
    expect(isValidSummaryHash("sha256:abc")).toBe(false);
    expect(isValidSummaryHash(`md5:${"0".repeat(64)}`)).toBe(false);
    expect(isValidSummaryHash("")).toBe(false);
  });

  it("computeSummaryHash：返回 sha256: 前缀 + 64 hex", () => {
    const hash = computeSummaryHash("测试摘要");
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("createContextCheckpoint：成功写入 + 查询回读", async () => {
    const { tenantId } = await seedContext();
    await withRollback(db, async (tx) => {
      const sourceRanges = [
        {
          type: "thread_item" as const,
          fromSequence: 1,
          toSequence: 5,
          rangeHash: `sha256:${"1".repeat(64)}`,
        },
      ];
      const checkpoint = await createContextCheckpoint({
        tenantId,
        invocationId: "inv_create_test",
        checkpointType: "compression",
        sourceRanges,
        summaryRedacted: "压缩摘要",
        summaryHash: computeSummaryHash("压缩摘要"),
        tokenAccounting: { input: 10000, retained: 3000, compressed: 7000 },
        tx,
      });

      expect(checkpoint.id).toBeDefined();
      expect(checkpoint.tenantId).toBe(tenantId);
      expect(checkpoint.invocationId).toBe("inv_create_test");
      expect(checkpoint.checkpointType).toBe("compression");
      expect(checkpoint.summaryRedacted).toBe("压缩摘要");
      expect(checkpoint.inputTokens).toBe(10000);
      expect(checkpoint.retainedTokens).toBe(3000);
      expect(checkpoint.compressedTokens).toBe(7000);
      expect(checkpoint.sourceRangesHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  it("findContextCheckpointByUniqueKey：相同来源范围找到已存在 Checkpoint", async () => {
    const { tenantId } = await seedContext();
    const sourceRanges = [
      {
        type: "thread_item" as const,
        fromSequence: 1,
        toSequence: 10,
        rangeHash: `sha256:${"2".repeat(64)}`,
      },
    ];
    const created = await createContextCheckpoint({
      tenantId,
      invocationId: "inv_find_test",
      checkpointType: "assembly",
      sourceRanges,
      summaryRedacted: "组装摘要",
      summaryHash: computeSummaryHash("组装摘要"),
      tokenAccounting: { input: 5000, retained: 5000, compressed: 0 },
    });
    try {
      const found = await findContextCheckpointByUniqueKey({
        tenantId,
        invocationId: "inv_find_test",
        checkpointType: "assembly",
        sourceRanges,
      });

      expect(found).not.toBeNull();
      expect(found?.invocationId).toBe("inv_find_test");
      expect(found?.checkpointType).toBe("assembly");
    } finally {
      await db.delete(contextCheckpoint).where(eq(contextCheckpoint.id, created.id));
    }
  });

  it("findContextCheckpointByUniqueKey：不同来源范围返回 null", async () => {
    const { tenantId } = await seedContext();
    const sourceRanges1 = [
      {
        type: "thread_item" as const,
        fromSequence: 1,
        toSequence: 10,
        rangeHash: `sha256:${"3".repeat(64)}`,
      },
    ];
    const created = await createContextCheckpoint({
      tenantId,
      invocationId: "inv_find_diff",
      checkpointType: "assembly",
      sourceRanges: sourceRanges1,
      summaryRedacted: "摘要1",
      summaryHash: computeSummaryHash("摘要1"),
      tokenAccounting: { input: 100, retained: 100, compressed: 0 },
    });
    try {
      const sourceRanges2 = [
        {
          type: "thread_item" as const,
          fromSequence: 1,
          toSequence: 20,
          rangeHash: `sha256:${"4".repeat(64)}`,
        },
      ];
      const found = await findContextCheckpointByUniqueKey({
        tenantId,
        invocationId: "inv_find_diff",
        checkpointType: "assembly",
        sourceRanges: sourceRanges2,
      });

      expect(found).toBeNull();
    } finally {
      await db.delete(contextCheckpoint).where(eq(contextCheckpoint.id, created.id));
    }
  });

  it("getContextCheckpointById：跨租户隔离", async () => {
    const { tenantId } = await seedContext();
    const otherTenantId = randomUUID();

    const checkpoint = await createContextCheckpoint({
      tenantId,
      invocationId: "inv_cross_tenant",
      checkpointType: "resume",
      sourceRanges: [
        {
          type: "thread_item",
          rangeHash: `sha256:${"5".repeat(64)}`,
        },
      ],
      summaryRedacted: "恢复点",
      summaryHash: computeSummaryHash("恢复点"),
      tokenAccounting: { input: 1000, retained: 500, compressed: 500 },
    });
    try {
      // 本租户可查
      const own = await getContextCheckpointById(tenantId, checkpoint.id);
      expect(own?.id).toBe(checkpoint.id);

      // 跨租户不可见
      const other = await getContextCheckpointById(otherTenantId, checkpoint.id);
      expect(other).toBeNull();
    } finally {
      await db.delete(contextCheckpoint).where(eq(contextCheckpoint.id, checkpoint.id));
    }
  });

  it("getContextCheckpointsByInvocation：按 createdAt 升序", async () => {
    const { tenantId } = await seedContext();
    const invocationId = "inv_list_test";
    const createdIds: string[] = [];
    try {
      // 创建 3 个 Checkpoint（不同 checkpointType 避免唯一约束冲突）
      for (const type of ["assembly", "compression", "resume"] as const) {
        const cp = await createContextCheckpoint({
          tenantId,
          invocationId,
          checkpointType: type,
          sourceRanges: [
            {
              type: "thread_item",
              rangeHash: `sha256:${type.padEnd(64, "0")}`,
            },
          ],
          summaryRedacted: `${type} 摘要`,
          summaryHash: computeSummaryHash(`${type} 摘要`),
          tokenAccounting: { input: 100, retained: 50, compressed: 50 },
        });
        createdIds.push(cp.id);
      }

      const list = await getContextCheckpointsByInvocation(tenantId, invocationId);
      expect(list).toHaveLength(3);
      // 验证升序
      const times = list.map((c) => c.createdAt.getTime());
      for (let i = 1; i < times.length; i++) {
        const curr = times[i];
        const prev = times[i - 1];
        if (curr !== undefined && prev !== undefined) {
          expect(curr).toBeGreaterThanOrEqual(prev);
        }
      }
    } finally {
      // 清理
      for (const id of createdIds) {
        await db.delete(contextCheckpoint).where(eq(contextCheckpoint.id, id));
      }
    }
  });
});

describe("POST /gateway/v1/context-checkpoints", () => {
  it("缺少 Token → 401 AUTHENTICATION_REQUIRED", async () => {
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      idempotencyKey: "idem-1",
      body: makeBody(),
    });
    const response = await contextCheckpointPOST(request);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_test_001");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      body: makeBody(),
    });
    const response = await contextCheckpointPOST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("请求体 invocation_id 与 Token invocationId 不一致 → 400", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_from_token");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      idempotencyKey: "idem-2",
      body: makeBody({ invocation_id: "inv_from_body" }),
    });
    const response = await contextCheckpointPOST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("非法 checkpoint_type → 400", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_test_001");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      idempotencyKey: "idem-3",
      body: makeBody({ checkpoint_type: "invalid_type" }),
    });
    const response = await contextCheckpointPOST(request);
    expect(response.status).toBe(400);
  });

  it("summary.text 与 summary.content_ref 都为空 → 400", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_test_001");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      idempotencyKey: "idem-4",
      body: makeBody({ summary: {} }),
    });
    const response = await contextCheckpointPOST(request);
    expect(response.status).toBe(400);
  });

  it("非法 summary_hash 格式 → 400", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_test_001");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      idempotencyKey: "idem-5",
      body: makeBody({ summary_hash: "not-a-hash" }),
    });
    const response = await contextCheckpointPOST(request);
    expect(response.status).toBe(400);
  });

  it("成功创建 compression Checkpoint → 201", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_success_001");
    const body = makeBody({ invocation_id: "inv_success_001" });
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      idempotencyKey: "idem-success-1",
      body,
    });
    const response = await contextCheckpointPOST(request);
    expect(response.status).toBe(201);
    const respBody = await response.json();
    expect(respBody.checkpoint_id).toBeDefined();
    expect(respBody.invocation_id).toBe("inv_success_001");
    expect(respBody.checkpoint_type).toBe("compression");
    expect(respBody.summary_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(respBody.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    // 清理
    await db.delete(contextCheckpoint).where(eq(contextCheckpoint.id, respBody.checkpoint_id));
  });

  it("成功创建 assembly Checkpoint（用 content_ref）→ 201", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_assembly_001");
    const summaryHash = computeSummaryHash("对象存储引用的摘要");
    const body = makeBody({
      invocation_id: "inv_assembly_001",
      checkpoint_type: "assembly",
      summary: { content_ref: "s3://buckets/checkpoints/abc.json" },
      summary_hash: summaryHash,
    });
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      idempotencyKey: "idem-assembly-1",
      body,
    });
    const response = await contextCheckpointPOST(request);
    expect(response.status).toBe(201);
    const respBody = await response.json();
    expect(respBody.checkpoint_type).toBe("assembly");

    // 清理
    await db.delete(contextCheckpoint).where(eq(contextCheckpoint.id, respBody.checkpoint_id));
  });

  it("幂等重放：同 Idempotency-Key 同 body → 返回原 201 响应", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_idempotent_001");
    const body = makeBody({ invocation_id: "inv_idempotent_001" });

    const request1 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      idempotencyKey: "idem-replay-1",
      body,
    });
    const response1 = await contextCheckpointPOST(request1);
    expect(response1.status).toBe(201);
    const respBody1 = await response1.json();

    const request2 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      idempotencyKey: "idem-replay-1",
      body,
    });
    const response2 = await contextCheckpointPOST(request2);
    expect(response2.status).toBe(201);
    const respBody2 = await response2.json();
    expect(respBody2.checkpoint_id).toBe(respBody1.checkpoint_id);

    // 清理
    await db.delete(contextCheckpoint).where(eq(contextCheckpoint.id, respBody1.checkpoint_id));
  });

  it("幂等冲突：同 Idempotency-Key 不同 body → 409 IDEMPOTENCY_CONFLICT", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_conflict_001");

    const body1 = makeBody({
      invocation_id: "inv_conflict_001",
      checkpoint_type: "compression",
    });
    const request1 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      idempotencyKey: "idem-conflict-1",
      body: body1,
    });
    const response1 = await contextCheckpointPOST(request1);
    expect(response1.status).toBe(201);
    const respBody1 = await response1.json();

    // 同 key 不同 body（checkpoint_type 不同）
    const body2 = makeBody({
      invocation_id: "inv_conflict_001",
      checkpoint_type: "assembly",
    });
    const request2 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      idempotencyKey: "idem-conflict-1",
      body: body2,
    });
    const response2 = await contextCheckpointPOST(request2);
    expect(response2.status).toBe(409);
    const respBody2 = await response2.json();
    expect(respBody2.error.code).toBe("IDEMPOTENCY_CONFLICT");

    // 清理
    await db.delete(contextCheckpoint).where(eq(contextCheckpoint.id, respBody1.checkpoint_id));
  });

  it("相同来源范围去重：同 invocation+type+ranges 不重复创建 → 返回已有 checkpoint", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_dedup_001");
    const body = makeBody({ invocation_id: "inv_dedup_001" });

    // 第一次创建
    const request1 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      idempotencyKey: "idem-dedup-1",
      body,
    });
    const response1 = await contextCheckpointPOST(request1);
    expect(response1.status).toBe(201);
    const respBody1 = await response1.json();

    // 第二次用不同 Idempotency-Key 但相同 body → 应去重返回已有 checkpoint
    const request2 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token,
      idempotencyKey: "idem-dedup-2",
      body,
    });
    const response2 = await contextCheckpointPOST(request2);
    expect(response2.status).toBe(201);
    const respBody2 = await response2.json();
    expect(respBody2.checkpoint_id).toBe(respBody1.checkpoint_id);

    // 验证 DB 只有一行
    const rows = await db
      .select()
      .from(contextCheckpoint)
      .where(eq(contextCheckpoint.invocationId, "inv_dedup_001"));
    expect(rows).toHaveLength(1);

    // 清理
    await db.delete(contextCheckpoint).where(eq(contextCheckpoint.id, respBody1.checkpoint_id));
  });

  it("跨租户隔离：不同租户 Token 创建各自 Checkpoint", async () => {
    const { tenantId: tenant1 } = await seedContext();
    // 创建第二个租户（ensureDefaultTenant 只返回默认租户，手动创建）
    const tenant2 = randomUUID();
    const { tenant: tenantTable } = await import("@/lib/v11/schema/identity");
    await db.insert(tenantTable).values({
      id: tenant2,
      key: `t-${tenant2.slice(0, 8)}`,
      name: "第二租户",
      status: "active",
    });

    const token1 = makeGatewayToken(tenant1, "inv_cross_001");
    const token2 = makeGatewayToken(tenant2, "inv_cross_001");

    const body = makeBody({ invocation_id: "inv_cross_001" });
    const request1 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token: token1,
      idempotencyKey: "idem-cross-1",
      body,
    });
    const response1 = await contextCheckpointPOST(request1);
    expect(response1.status).toBe(201);
    const respBody1 = await response1.json();

    const request2 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/context-checkpoints",
      token: token2,
      idempotencyKey: "idem-cross-2",
      body,
    });
    const response2 = await contextCheckpointPOST(request2);
    expect(response2.status).toBe(201);
    const respBody2 = await response2.json();

    // 不同租户产生不同 checkpoint
    expect(respBody2.checkpoint_id).not.toBe(respBody1.checkpoint_id);

    // 清理
    await db.delete(contextCheckpoint).where(eq(contextCheckpoint.id, respBody1.checkpoint_id));
    await db.delete(contextCheckpoint).where(eq(contextCheckpoint.id, respBody2.checkpoint_id));
  });
});
