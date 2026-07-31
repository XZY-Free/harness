/**
 * S09-C07：V11 共享父任务总预算 + Child Thread 新预算字段集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - computeSharedBudgetUsage（纯函数，4 例）：空 relations / 单 relation / 多 relation 累加 /
 *   非法值视为 0 / unknownEffect 取或
 * - validateSharedBudgetPolicy（纯函数，2 例）：合法值通过 / 负值或非有限数抛错
 * - getSharedBudgetUsage（DB，3 例）：无 sibling 返回零值 / 多 sibling 聚合 /
 *   终态 sibling（completed/failed/cancelled）不计入聚合
 * - assertSharedBudgetNotExhausted（DB，3 例）：未超限通过 / tokens 聚合超限 /
 *   child_count 聚合超限
 * - recordChildThreadBudgetUsage 新字段（DB，2 例）：maxToolCalls/maxChildCount/maxSandboxSeconds/
 *   maxArtifactBytes 比对 + childCount/sandboxSeconds/artifactBytes 累积
 * - assertChildThreadBudgetNotExhausted 新字段（DB，1 例）：maxToolCalls 超限
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  type ChildThreadBudgetUsage,
  type DelegationBudgetPolicy,
  assertChildThreadBudgetNotExhausted,
  recordChildThreadBudgetUsage,
} from "@/lib/v11/conversation/child-thread-queries";
import { SharedBudgetExhaustedError } from "@/lib/v11/conversation/errors";
import {
  type SharedBudgetPolicy,
  type SharedBudgetUsage,
  assertSharedBudgetNotExhausted,
  computeSharedBudgetUsage,
  getSharedBudgetUsage,
  validateSharedBudgetPolicy,
} from "@/lib/v11/conversation/shared-budget-queries";
import { createThread } from "@/lib/v11/conversation/thread-queries";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { v11ThreadRelation } from "@/lib/v11/schema/conversation";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 默认租户 + 用户身份 ───────────────────────

async function seedContext() {
  const t = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: t.id,
    externalSubject: "budget-user-1",
    email: "budget-user-1@example.com",
    displayName: "Budget User",
  });
  const binding = await upsertPrincipalBinding({
    tenantId: t.id,
    subjectType: "user",
    externalId: "budget-user-1",
    displayName: "Budget User",
    userIdentityId: identity.id,
  });
  return { tenantId: t.id, userId: identity.id, principalBindingId: binding.id };
}

async function seedThread(tenantId: string, userId: string, agentId: string) {
  const { thread } = await createThread({
    tenantId,
    ownerUserId: userId,
    primaryAgentId: agentId,
    title: "Budget Test Thread",
    actorId: userId,
  });
  return thread;
}

const TEST_PARENT_AGENT_ID = "00000000-0000-4000-8000-000000000020";
const TEST_CHILD_AGENT_ID = "00000000-0000-4000-8000-000000000021";

/** 直接 INSERT 一个 ThreadRelation 行（delegate 类型，可指定 state 与 budgetUsedJson）。 */
async function seedRelation(params: {
  tenantId: string;
  parentThreadId: string;
  childThreadId: string;
  relationState?: "creating" | "active" | "cancel_requested" | "completed" | "failed" | "cancelled";
  budgetPolicyJson?: DelegationBudgetPolicy | null;
  budgetUsedJson?: ChildThreadBudgetUsage | null;
}): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(v11ThreadRelation).values({
    id,
    parentThreadId: params.parentThreadId,
    childThreadId: params.childThreadId,
    relationType: "delegate",
    sourceTurnId: null,
    sourceItemId: null,
    sourceInvocationId: null,
    targetAgentId: null,
    taskPayloadRef: null,
    taskPayloadHash: null,
    contextTransferPolicyJson: null,
    budgetPolicyJson: (params.budgetPolicyJson ?? null) as Record<string, unknown> | null,
    budgetUsedJson: (params.budgetUsedJson ?? null) as Record<string, unknown> | null,
    relationState: params.relationState ?? "active",
    itemId: null,
    resultItemId: null,
    resultRef: null,
    resultHash: null,
    createdAt: now,
    completedAt: null,
  });
  return id;
}

/** seed 父 Thread + 多个子 Thread + delegate relations。 */
async function seedParentWithChildren(
  tenantId: string,
  userId: string,
  childrenCount: number,
): Promise<{
  parentThreadId: string;
  childThreadIds: string[];
  relationIds: string[];
}> {
  const parentThread = await seedThread(tenantId, userId, TEST_PARENT_AGENT_ID);
  const childThreadIds: string[] = [];
  const relationIds: string[] = [];
  for (let i = 0; i < childrenCount; i++) {
    const childThread = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);
    childThreadIds.push(childThread.id);
    const relationId = await seedRelation({
      tenantId,
      parentThreadId: parentThread.id,
      childThreadId: childThread.id,
    });
    relationIds.push(relationId);
  }
  return { parentThreadId: parentThread.id, childThreadIds, relationIds };
}

/** 取数组第 idx 项；不存在则抛错（替代非空断言）。 */
function nth<T>(arr: readonly T[], idx: number): T {
  const v = arr[idx];
  if (v === undefined) throw new Error(`数组第 ${idx} 项不存在`);
  return v;
}

// ═══════════════════════════════════════════════════════════
// 1. computeSharedBudgetUsage（纯函数）
// ═══════════════════════════════════════════════════════════

describe("S09-C07 computeSharedBudgetUsage（纯函数）", () => {
  it("空 relations 返回零值 + 空 contributingRelations", () => {
    const usage = computeSharedBudgetUsage([]);
    expect(usage.tokens).toBe(0);
    expect(usage.cost).toBe(0);
    expect(usage.toolCalls).toBe(0);
    expect(usage.wallClockMs).toBe(0);
    expect(usage.childCount).toBe(0);
    expect(usage.sandboxSeconds).toBe(0);
    expect(usage.artifactBytes).toBe(0);
    expect(usage.unknownEffect).toBe(false);
    expect(usage.contributingRelations).toHaveLength(0);
  });

  it("多 relation 累加所有数值字段", () => {
    const usage = computeSharedBudgetUsage([
      {
        id: "rel-1",
        budgetUsedJson: {
          tokens: 100,
          cost: 1.5,
          toolCalls: 5,
          wallClockMs: 1000,
          childCount: 2,
          sandboxSeconds: 30,
          artifactBytes: 1024,
          unknownEffect: false,
        },
      },
      {
        id: "rel-2",
        budgetUsedJson: {
          tokens: 200,
          cost: 2.5,
          toolCalls: 10,
          wallClockMs: 2000,
          childCount: 3,
          sandboxSeconds: 50,
          artifactBytes: 2048,
          unknownEffect: true,
        },
      },
    ]);

    expect(usage.tokens).toBe(300);
    expect(usage.cost).toBe(4);
    expect(usage.toolCalls).toBe(15);
    expect(usage.wallClockMs).toBe(3000);
    expect(usage.childCount).toBe(5);
    expect(usage.sandboxSeconds).toBe(80);
    expect(usage.artifactBytes).toBe(3072);
    expect(usage.unknownEffect).toBe(true);
    expect(usage.contributingRelations).toEqual(["rel-1", "rel-2"]);
  });

  it("budgetUsedJson 为 null/undefined 时数值视为 0", () => {
    const usage = computeSharedBudgetUsage([
      { id: "rel-null", budgetUsedJson: null },
      { id: "rel-undefined", budgetUsedJson: undefined },
      { id: "rel-empty", budgetUsedJson: {} },
    ]);
    expect(usage.tokens).toBe(0);
    expect(usage.cost).toBe(0);
    expect(usage.toolCalls).toBe(0);
    expect(usage.wallClockMs).toBe(0);
    expect(usage.childCount).toBe(0);
    expect(usage.sandboxSeconds).toBe(0);
    expect(usage.artifactBytes).toBe(0);
    expect(usage.unknownEffect).toBe(false);
    expect(usage.contributingRelations).toHaveLength(3);
  });

  it("非法值（字符串/NaN/Infinity）视为 0", () => {
    const usage = computeSharedBudgetUsage([
      {
        id: "rel-invalid",
        budgetUsedJson: {
          tokens: "100" as unknown as number,
          cost: Number.NaN,
          toolCalls: Number.POSITIVE_INFINITY,
          wallClockMs: -1, // 负值不算"非法"，会被累加（用于测试 Number.isFinite）
          childCount: undefined,
          sandboxSeconds: null as unknown as number,
          artifactBytes: "1kb" as unknown as number,
          unknownEffect: "yes" as unknown as boolean,
        },
      },
    ]);
    expect(usage.tokens).toBe(0); // 字符串视为 0
    expect(usage.cost).toBe(0); // NaN 视为 0
    expect(usage.toolCalls).toBe(0); // Infinity 视为 0
    expect(usage.wallClockMs).toBe(-1); // 负数仍是有限数，被累加
    expect(usage.childCount).toBe(0); // undefined 视为 0
    expect(usage.sandboxSeconds).toBe(0); // null 视为 0
    expect(usage.artifactBytes).toBe(0); // 字符串视为 0
    expect(usage.unknownEffect).toBe(true); // 任意 truthy 值转为 true
  });
});

// ═══════════════════════════════════════════════════════════
// 2. validateSharedBudgetPolicy（纯函数）
// ═══════════════════════════════════════════════════════════

describe("S09-C07 validateSharedBudgetPolicy（纯函数）", () => {
  it("合法 policy（含全部字段）通过", () => {
    expect(() =>
      validateSharedBudgetPolicy({
        maxTokens: 1000,
        maxCost: 5,
        maxToolCalls: 50,
        maxWallClockMs: 60000,
        maxChildCount: 5,
        maxSandboxSeconds: 600,
        maxArtifactBytes: 1024 * 1024,
      }),
    ).not.toThrow();
  });

  it("负值或非有限数抛错", () => {
    expect(() => validateSharedBudgetPolicy({ maxTokens: -1 })).toThrow();
    expect(() => validateSharedBudgetPolicy({ maxCost: Number.NaN })).toThrow();
    expect(() => validateSharedBudgetPolicy({ maxToolCalls: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => validateSharedBudgetPolicy({ maxChildCount: -10 })).toThrow();
    expect(() => validateSharedBudgetPolicy({ maxSandboxSeconds: -0.1 })).toThrow();
    expect(() => validateSharedBudgetPolicy({ maxArtifactBytes: -100 })).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. getSharedBudgetUsage（DB 集成）
// ═══════════════════════════════════════════════════════════

describe("S09-C07 getSharedBudgetUsage（DB 集成）", () => {
  it("无 sibling 返回零值", async () => {
    const { tenantId, userId } = await seedContext();
    const parentThread = await seedThread(tenantId, userId, TEST_PARENT_AGENT_ID);

    const usage = await getSharedBudgetUsage(parentThread.id);
    expect(usage.tokens).toBe(0);
    expect(usage.contributingRelations).toHaveLength(0);
  });

  it("多 sibling 聚合 budgetUsedJson", async () => {
    const { tenantId, userId } = await seedContext();
    const { parentThreadId, childThreadIds, relationIds } = await seedParentWithChildren(
      tenantId,
      userId,
      2,
    );

    // 给两个 relation 写 budgetUsedJson
    await db
      .update(v11ThreadRelation)
      .set({
        budgetUsedJson: {
          tokens: 300,
          cost: 1.5,
          toolCalls: 5,
          wallClockMs: 10000,
          childCount: 1,
          sandboxSeconds: 30,
          artifactBytes: 1024,
          unknownEffect: false,
        } as unknown as Record<string, unknown>,
      })
      .where(eq(v11ThreadRelation.id, nth(relationIds, 0)));
    await db
      .update(v11ThreadRelation)
      .set({
        budgetUsedJson: {
          tokens: 500,
          cost: 2.5,
          toolCalls: 10,
          wallClockMs: 20000,
          childCount: 2,
          sandboxSeconds: 60,
          artifactBytes: 2048,
          unknownEffect: true,
        } as unknown as Record<string, unknown>,
      })
      .where(eq(v11ThreadRelation.id, nth(relationIds, 1)));

    const usage = await getSharedBudgetUsage(parentThreadId);
    expect(usage.tokens).toBe(800);
    expect(usage.cost).toBe(4);
    expect(usage.toolCalls).toBe(15);
    expect(usage.wallClockMs).toBe(30000);
    expect(usage.childCount).toBe(3);
    expect(usage.sandboxSeconds).toBe(90);
    expect(usage.artifactBytes).toBe(3072);
    expect(usage.unknownEffect).toBe(true);
    expect(usage.contributingRelations).toHaveLength(2);
  });

  it("终态 sibling（completed/failed/cancelled）不计入聚合", async () => {
    const { tenantId, userId } = await seedContext();
    const parentThread = await seedThread(tenantId, userId, TEST_PARENT_AGENT_ID);

    // 创建 3 个 child Thread + relation
    const child1 = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);
    const child2 = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);
    const child3 = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);

    const activeRelId = await seedRelation({
      tenantId,
      parentThreadId: parentThread.id,
      childThreadId: child1.id,
      relationState: "active",
      budgetUsedJson: { tokens: 100 },
    });
    const completedRelId = await seedRelation({
      tenantId,
      parentThreadId: parentThread.id,
      childThreadId: child2.id,
      relationState: "completed",
      budgetUsedJson: { tokens: 500 },
    });
    const cancelledRelId = await seedRelation({
      tenantId,
      parentThreadId: parentThread.id,
      childThreadId: child3.id,
      relationState: "cancelled",
      budgetUsedJson: { tokens: 300 },
    });

    const usage = await getSharedBudgetUsage(parentThread.id);
    // 只聚合 active relation（100），终态的 500 + 300 不计入
    expect(usage.tokens).toBe(100);
    expect(usage.contributingRelations).toEqual([activeRelId]);
    expect(usage.contributingRelations).not.toContain(completedRelId);
    expect(usage.contributingRelations).not.toContain(cancelledRelId);
  });

  it("cancel_requested 状态计入聚合（仍在取消流程中）", async () => {
    const { tenantId, userId } = await seedContext();
    const parentThread = await seedThread(tenantId, userId, TEST_PARENT_AGENT_ID);
    const child = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);

    await seedRelation({
      tenantId,
      parentThreadId: parentThread.id,
      childThreadId: child.id,
      relationState: "cancel_requested",
      budgetUsedJson: { tokens: 200 },
    });

    const usage = await getSharedBudgetUsage(parentThread.id);
    expect(usage.tokens).toBe(200); // cancel_requested 仍计入
    expect(usage.contributingRelations).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. assertSharedBudgetNotExhausted（DB 集成）
// ═══════════════════════════════════════════════════════════

describe("S09-C07 assertSharedBudgetNotExhausted（DB 集成）", () => {
  it("未超限通过 + 返回聚合用量", async () => {
    const { tenantId, userId } = await seedContext();
    const { parentThreadId, relationIds } = await seedParentWithChildren(tenantId, userId, 2);

    await db
      .update(v11ThreadRelation)
      .set({
        budgetUsedJson: { tokens: 300 } as unknown as Record<string, unknown>,
      })
      .where(eq(v11ThreadRelation.id, nth(relationIds, 0)));
    await db
      .update(v11ThreadRelation)
      .set({
        budgetUsedJson: { tokens: 400 } as unknown as Record<string, unknown>,
      })
      .where(eq(v11ThreadRelation.id, nth(relationIds, 1)));

    const policy: SharedBudgetPolicy = { maxTokens: 1000 };
    const usage = await assertSharedBudgetNotExhausted(parentThreadId, policy);
    expect(usage.tokens).toBe(700);
  });

  it("tokens 聚合超限抛 SharedBudgetExhaustedError", async () => {
    const { tenantId, userId } = await seedContext();
    const { parentThreadId, relationIds } = await seedParentWithChildren(tenantId, userId, 2);

    // sibling A 用了 800，sibling B 用了 300 → 总和 1100 > max=1000
    await db
      .update(v11ThreadRelation)
      .set({
        budgetUsedJson: { tokens: 800 } as unknown as Record<string, unknown>,
      })
      .where(eq(v11ThreadRelation.id, nth(relationIds, 0)));
    await db
      .update(v11ThreadRelation)
      .set({
        budgetUsedJson: { tokens: 300 } as unknown as Record<string, unknown>,
      })
      .where(eq(v11ThreadRelation.id, nth(relationIds, 1)));

    const policy: SharedBudgetPolicy = { maxTokens: 1000 };
    try {
      await assertSharedBudgetNotExhausted(parentThreadId, policy);
      throw new Error("应抛 SharedBudgetExhaustedError");
    } catch (err) {
      expect(err).toBeInstanceOf(SharedBudgetExhaustedError);
      const e = err as SharedBudgetExhaustedError;
      expect(e.parentThreadId).toBe(parentThreadId);
      expect(e.exceededField).toBe("tokens");
      expect(e.totalUsed).toBe(1100);
      expect(e.maxLimit).toBe(1000);
      expect(e.contributingRelations).toHaveLength(2);
    }
  });

  it("child_count 聚合超限抛 SharedBudgetExhaustedError", async () => {
    const { tenantId, userId } = await seedContext();
    const { parentThreadId, relationIds } = await seedParentWithChildren(tenantId, userId, 3);

    // 3 个 sibling 各有 childCount=2 → 总和 6 > max=5
    for (const relId of relationIds) {
      await db
        .update(v11ThreadRelation)
        .set({
          budgetUsedJson: { childCount: 2 } as unknown as Record<string, unknown>,
        })
        .where(eq(v11ThreadRelation.id, relId));
    }

    const policy: SharedBudgetPolicy = { maxChildCount: 5 };
    try {
      await assertSharedBudgetNotExhausted(parentThreadId, policy);
      throw new Error("应抛 SharedBudgetExhaustedError");
    } catch (err) {
      expect(err).toBeInstanceOf(SharedBudgetExhaustedError);
      const e = err as SharedBudgetExhaustedError;
      expect(e.exceededField).toBe("child_count");
      expect(e.totalUsed).toBe(6);
      expect(e.maxLimit).toBe(5);
    }
  });

  it("缺省字段（undefined）不校验", async () => {
    const { tenantId, userId } = await seedContext();
    const { parentThreadId, relationIds } = await seedParentWithChildren(tenantId, userId, 1);

    // 写入巨大 tokens 但 policy 不设 maxTokens
    await db
      .update(v11ThreadRelation)
      .set({
        budgetUsedJson: { tokens: 1_000_000 } as unknown as Record<string, unknown>,
      })
      .where(eq(v11ThreadRelation.id, nth(relationIds, 0)));

    // 只设 maxChildCount=5，tokens 不设上限
    const policy: SharedBudgetPolicy = { maxChildCount: 5 };
    const usage = await assertSharedBudgetNotExhausted(parentThreadId, policy);
    expect(usage.tokens).toBe(1_000_000);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. recordChildThreadBudgetUsage 新字段（DB 集成）
// ═══════════════════════════════════════════════════════════

describe("S09-C07 recordChildThreadBudgetUsage 新字段", () => {
  it("累积 childCount/sandboxSeconds/artifactBytes", async () => {
    const { tenantId, userId } = await seedContext();
    const parentThread = await seedThread(tenantId, userId, TEST_PARENT_AGENT_ID);
    const childThread = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);
    const relationId = await seedRelation({
      tenantId,
      parentThreadId: parentThread.id,
      childThreadId: childThread.id,
      budgetPolicyJson: {
        maxChildCount: 5,
        maxSandboxSeconds: 100,
        maxArtifactBytes: 1024 * 1024,
        maxToolCalls: 20,
      },
    });

    const first = await recordChildThreadBudgetUsage({
      tenantId,
      relationId,
      delta: {
        childCount: 1,
        sandboxSeconds: 30,
        artifactBytes: 1024,
        toolCalls: 5,
      },
    });

    expect(first.budgetUsed.childCount).toBe(1);
    expect(first.budgetUsed.sandboxSeconds).toBe(30);
    expect(first.budgetUsed.artifactBytes).toBe(1024);
    expect(first.budgetUsed.toolCalls).toBe(5);
    expect(first.exhausted).toBe(false);

    const second = await recordChildThreadBudgetUsage({
      tenantId,
      relationId,
      delta: {
        childCount: 1,
        sandboxSeconds: 40,
        artifactBytes: 2048,
        toolCalls: 10,
      },
    });

    expect(second.budgetUsed.childCount).toBe(2);
    expect(second.budgetUsed.sandboxSeconds).toBe(70);
    expect(second.budgetUsed.artifactBytes).toBe(3072);
    expect(second.budgetUsed.toolCalls).toBe(15);
    expect(second.exhausted).toBe(false);
  });

  it("maxToolCalls/maxChildCount/maxSandboxSeconds/maxArtifactBytes 各自超限", async () => {
    const { tenantId, userId } = await seedContext();
    const parentThread = await seedThread(tenantId, userId, TEST_PARENT_AGENT_ID);
    const childThread = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);
    const relationId = await seedRelation({
      tenantId,
      parentThreadId: parentThread.id,
      childThreadId: childThread.id,
      budgetPolicyJson: {
        maxToolCalls: 10,
        maxChildCount: 2,
        maxSandboxSeconds: 60,
        maxArtifactBytes: 1024,
      },
    });

    // maxToolCalls 超限
    const toolCallsExceeded = await recordChildThreadBudgetUsage({
      tenantId,
      relationId,
      delta: { toolCalls: 11 },
    });
    expect(toolCallsExceeded.exhausted).toBe(true);
    expect(toolCallsExceeded.exceededField).toBe("tool_calls");

    // 新 relation 测试 maxChildCount
    const childThread2 = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);
    const relationId2 = await seedRelation({
      tenantId,
      parentThreadId: parentThread.id,
      childThreadId: childThread2.id,
      budgetPolicyJson: { maxChildCount: 2 },
    });
    const childCountExceeded = await recordChildThreadBudgetUsage({
      tenantId,
      relationId: relationId2,
      delta: { childCount: 3 },
    });
    expect(childCountExceeded.exhausted).toBe(true);
    expect(childCountExceeded.exceededField).toBe("child_count");

    // maxSandboxSeconds 超限
    const childThread3 = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);
    const relationId3 = await seedRelation({
      tenantId,
      parentThreadId: parentThread.id,
      childThreadId: childThread3.id,
      budgetPolicyJson: { maxSandboxSeconds: 60 },
    });
    const sandboxExceeded = await recordChildThreadBudgetUsage({
      tenantId,
      relationId: relationId3,
      delta: { sandboxSeconds: 90 },
    });
    expect(sandboxExceeded.exhausted).toBe(true);
    expect(sandboxExceeded.exceededField).toBe("sandbox_seconds");

    // maxArtifactBytes 超限
    const childThread4 = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);
    const relationId4 = await seedRelation({
      tenantId,
      parentThreadId: parentThread.id,
      childThreadId: childThread4.id,
      budgetPolicyJson: { maxArtifactBytes: 1024 },
    });
    const artifactExceeded = await recordChildThreadBudgetUsage({
      tenantId,
      relationId: relationId4,
      delta: { artifactBytes: 2048 },
    });
    expect(artifactExceeded.exhausted).toBe(true);
    expect(artifactExceeded.exceededField).toBe("artifact_bytes");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. assertChildThreadBudgetNotExhausted 新字段（DB 集成）
// ═══════════════════════════════════════════════════════════

describe("S09-C07 assertChildThreadBudgetNotExhausted 新字段", () => {
  it("maxToolCalls 超限 → ChildThreadBudgetExhaustedError", async () => {
    const { tenantId, userId } = await seedContext();
    const parentThread = await seedThread(tenantId, userId, TEST_PARENT_AGENT_ID);
    const childThread = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);
    const relationId = await seedRelation({
      tenantId,
      parentThreadId: parentThread.id,
      childThreadId: childThread.id,
      budgetPolicyJson: { maxToolCalls: 5 },
      budgetUsedJson: { toolCalls: 10 },
    });

    await expect(assertChildThreadBudgetNotExhausted(relationId)).rejects.toThrow(
      /Child Thread 预算耗尽/,
    );
  });

  it("maxArtifactBytes 未超限通过", async () => {
    const { tenantId, userId } = await seedContext();
    const parentThread = await seedThread(tenantId, userId, TEST_PARENT_AGENT_ID);
    const childThread = await seedThread(tenantId, userId, TEST_CHILD_AGENT_ID);
    const relationId = await seedRelation({
      tenantId,
      parentThreadId: parentThread.id,
      childThreadId: childThread.id,
      budgetPolicyJson: { maxArtifactBytes: 10_000 },
      budgetUsedJson: { artifactBytes: 5_000 },
    });

    // 未超限不抛错
    await assertChildThreadBudgetNotExhausted(relationId);
  });
});
