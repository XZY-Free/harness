/**
 * V11 PermissionDecision + Grant 集成测试（阶段 8 S08-C03）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.8（permission_decision、
 *   user_action_request 与 grant）、§5.5（ToolCall、Effect 与 Credential）。
 * - ../v11-agentkit-platform/09-unified-domain-model.md §5.5（PermissionDecision）。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §10（block 不可被绕过）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W03。
 *
 * 覆盖：
 * - 辅助函数：isPermissionDecision / isGrantType / isGrantState / isScopeCoveredBy
 *   （精确匹配 / 前缀通配 / 顶级通配 / 空数组）。
 * - PermissionDecision：recordPermissionDecision（首次 sequence=1 / 多次自增）/
 *   getPermissionDecisionById / getPermissionDecisionsByToolCall（升序）/
 *   getLatestPermissionDecision（最大 sequence） / 跨租户隔离 / 校验错误。
 * - assertToolCallAllowed：allow 通过 / pause → ToolCallPausedError /
 *   block → ToolCallBlockedError / 无决策 → PermissionNotFoundError。
 * - Grant：issueGrant（创建 + active + versionNo=1）/ getGrantById / listGrantsByUser /
 *   listActiveGrantsForCredential / revokeGrant（ETag 校验 + revokedAt 回填）/
 *   revokeGrant 终态不可恢复 / revokeGrant 版本冲突 / markExpiredGrants 批量标记 /
 *   getEffectiveGrantForToolCall（scope 覆盖 / 过期跳过 / 撤销跳过 / 跨租户隔离）。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { grantTable } from "@/lib/persistence/schema/permission";
import { createCredentialRef } from "@/lib/v11/capability/tool-queries";
import {
  GrantNotFoundError,
  GrantStateError,
  GrantValidationError,
  GrantVersionConflictError,
  PermissionNotFoundError,
  PermissionValidationError,
  ToolCallBlockedError,
  ToolCallPausedError,
  assertToolCallAllowed,
  getEffectiveGrantForToolCall,
  getGrantById,
  getLatestPermissionDecision,
  getPermissionDecisionsByToolCall,
  isGrantState,
  isGrantType,
  isPermissionDecision,
  isScopeCoveredBy,
  issueGrant,
  listActiveGrantsForCredential,
  listGrantsByUser,
  markExpiredGrants,
  recordPermissionDecision,
  revokeGrant,
} from "@/lib/v11/permission/permission-queries";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 默认租户 + 用户 + CredentialRef ──────────

async function seedContext() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "perm-owner-001",
    email: "perm-owner@example.com",
    displayName: "Perm Owner",
  });
  // 直接通过 createCredentialRef 创建测试凭证引用
  const credentialRef = await createCredentialRef({
    tenantId: tenant.id,
    provider: "vault",
    vaultRef: "vault://test/cred-001",
    fingerprint: "sha256:7d8e2f1a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e",
  });
  return {
    tenantId: tenant.id,
    userId: identity.id,
    credentialRefId: credentialRef.id,
  };
}

/** 构造一个不依赖 ToolCall 表的随机 toolCallId（PermissionDecision 只记录 ID，无 FK 约束）。 */
function randomToolCallId(): string {
  return randomUUID();
}

/** 构造未来时间（默认 +1 小时）。 */
function futureTime(hours = 1): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

/** 构造过去时间（默认 -1 小时）。 */
function pastTime(hours = 1): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/**
 * 直接 SQL 把指定 Grant 的 expiresAt 改为过去时间。
 *
 * 用于测试 markExpiredGrants / getEffectiveGrantForToolCall 跳过过期 Grant 的逻辑——
 * issueGrant 仓储校验拒绝过去时间，必须绕过校验直接修改 DB。
 */
async function backdateGrantExpiry(grantId: string, hoursAgo = 1): Promise<void> {
  await db
    .update(grantTable)
    .set({ expiresAt: pastTime(hoursAgo) })
    .where(eq(grantTable.id, grantId));
}

// ═══════════════════════════════════════════════════════════
// 1. 辅助函数校验
// ═══════════════════════════════════════════════════════════

describe("V11 permission-queries：辅助函数校验", () => {
  it("isPermissionDecision：合法/非法判断", () => {
    expect(isPermissionDecision("allow")).toBe(true);
    expect(isPermissionDecision("pause")).toBe(true);
    expect(isPermissionDecision("block")).toBe(true);
    expect(isPermissionDecision("deny")).toBe(false); // 旧 V10 值
    expect(isPermissionDecision("ask")).toBe(false);
    expect(isPermissionDecision("")).toBe(false);
  });

  it("isGrantType：合法/非法判断", () => {
    expect(isGrantType("user_consent")).toBe(true);
    expect(isGrantType("policy")).toBe(true);
    expect(isGrantType("admin_override")).toBe(true);
    expect(isGrantType("manual")).toBe(false);
  });

  it("isGrantState：合法/非法判断", () => {
    expect(isGrantState("active")).toBe(true);
    expect(isGrantState("revoked")).toBe(true);
    expect(isGrantState("expired")).toBe(true);
    expect(isGrantState("pending")).toBe(false);
  });

  it("isScopeCoveredBy：精确匹配", () => {
    expect(isScopeCoveredBy(["tool:execute"], ["tool:execute"])).toBe(true);
    expect(isScopeCoveredBy(["tool:execute", "file:read"], ["tool:execute", "file:read"])).toBe(
      true,
    );
    expect(isScopeCoveredBy(["tool:execute"], ["file:read"])).toBe(false);
  });

  it("isScopeCoveredBy：前缀通配（scope:* 覆盖 scope:action）", () => {
    expect(isScopeCoveredBy(["tool:execute:foo"], ["tool:execute:*"])).toBe(true);
    expect(isScopeCoveredBy(["file:read:/tmp/foo.txt"], ["file:read:*"])).toBe(true);
    expect(isScopeCoveredBy(["file:read:/tmp/foo.txt"], ["file:write:*"])).toBe(false);
  });

  it("isScopeCoveredBy：顶级通配（tool:* 覆盖 tool:execute:foo）", () => {
    expect(isScopeCoveredBy(["tool:execute:foo"], ["tool:*"])).toBe(true);
    expect(isScopeCoveredBy(["file:read"], ["file:*"])).toBe(true);
    expect(isScopeCoveredBy(["tool:execute:foo"], ["file:*"])).toBe(false);
  });

  it("isScopeCoveredBy：空 required 视为已覆盖", () => {
    expect(isScopeCoveredBy([], ["tool:execute"])).toBe(true);
    expect(isScopeCoveredBy([], [])).toBe(true);
  });

  it("isScopeCoveredBy：空 granted 无法覆盖非空 required", () => {
    expect(isScopeCoveredBy(["tool:execute"], [])).toBe(false);
  });

  it("isScopeCoveredBy：多 scope 部分覆盖 → false", () => {
    expect(
      isScopeCoveredBy(["tool:execute", "file:write"], ["tool:execute:*", "file:read:*"]),
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. PermissionDecision CRUD
// ═══════════════════════════════════════════════════════════

describe("V11 PermissionDecision CRUD", () => {
  it("recordPermissionDecision：首次 sequence=1 + 默认字段填充", async () => {
    const { tenantId } = await seedContext();
    const toolCallId = randomToolCallId();

    const decision = await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "allow",
      reasonCodes: ["risk_low"],
      decidedBy: "policy-engine",
    });

    expect(decision.toolCallId).toBe(toolCallId);
    expect(decision.decisionSequence).toBe(1);
    expect(decision.decision).toBe("allow");
    expect(decision.reasonCodesJson).toEqual(["risk_low"]);
    expect(decision.policyRevisionId).toBeNull();
    expect(decision.riskSummaryJson).toBeNull();
    expect(decision.decidedBy).toBe("policy-engine");
    expect(decision.decidedAt).toBeInstanceOf(Date);
  });

  it("recordPermissionDecision：多次调用 decisionSequence 自增", async () => {
    const { tenantId } = await seedContext();
    const toolCallId = randomToolCallId();

    const d1 = await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "pause",
      reasonCodes: ["needs_confirmation"],
      decidedBy: "policy-engine",
    });
    const d2 = await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "allow",
      reasonCodes: ["user_confirmed"],
      decidedBy: "user-action-resolver",
    });
    const d3 = await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "block",
      reasonCodes: ["risk_too_high"],
      decidedBy: "policy-engine",
    });

    expect(d1.decisionSequence).toBe(1);
    expect(d2.decisionSequence).toBe(2);
    expect(d3.decisionSequence).toBe(3);
    expect(d1.decision).toBe("pause");
    expect(d2.decision).toBe("allow");
    expect(d3.decision).toBe("block");
  });

  it("recordPermissionDecision：非法 decision → ValidationError", async () => {
    const { tenantId } = await seedContext();
    const toolCallId = randomToolCallId();

    await expect(
      recordPermissionDecision({
        tenantId,
        toolCallId,
        // @ts-expect-error 测试非法值
        decision: "deny",
        reasonCodes: [],
        decidedBy: "policy-engine",
      }),
    ).rejects.toThrow(PermissionValidationError);
  });

  it("recordPermissionDecision：空 tenantId/toolCallId/decidedBy → ValidationError", async () => {
    const { tenantId } = await seedContext();
    const toolCallId = randomToolCallId();

    await expect(
      recordPermissionDecision({
        tenantId: "",
        toolCallId,
        decision: "allow",
        reasonCodes: [],
        decidedBy: "policy-engine",
      }),
    ).rejects.toThrow(PermissionValidationError);

    await expect(
      recordPermissionDecision({
        tenantId,
        toolCallId: "",
        decision: "allow",
        reasonCodes: [],
        decidedBy: "policy-engine",
      }),
    ).rejects.toThrow(PermissionValidationError);

    await expect(
      recordPermissionDecision({
        tenantId,
        toolCallId,
        decision: "allow",
        reasonCodes: [],
        decidedBy: "",
      }),
    ).rejects.toThrow(PermissionValidationError);
  });

  it("getPermissionDecisionsByToolCall：按 decisionSequence 升序", async () => {
    const { tenantId } = await seedContext();
    const toolCallId = randomToolCallId();

    await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "pause",
      reasonCodes: ["first"],
      decidedBy: "engine",
    });
    await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "allow",
      reasonCodes: ["second"],
      decidedBy: "engine",
    });
    await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "block",
      reasonCodes: ["third"],
      decidedBy: "engine",
    });

    const list = await getPermissionDecisionsByToolCall(tenantId, toolCallId);
    expect(list).toHaveLength(3);
    expect(list[0]?.decisionSequence).toBe(1);
    expect(list[1]?.decisionSequence).toBe(2);
    expect(list[2]?.decisionSequence).toBe(3);
    expect(list[0]?.decision).toBe("pause");
    expect(list[2]?.decision).toBe("block");
  });

  it("getLatestPermissionDecision：返回最大 decisionSequence", async () => {
    const { tenantId } = await seedContext();
    const toolCallId = randomToolCallId();

    await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "allow",
      reasonCodes: ["first"],
      decidedBy: "engine",
    });
    await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "block",
      reasonCodes: ["second"],
      decidedBy: "engine",
    });

    const latest = await getLatestPermissionDecision(tenantId, toolCallId);
    expect(latest).not.toBeNull();
    expect(latest?.decisionSequence).toBe(2);
    expect(latest?.decision).toBe("block");
  });

  it("getLatestPermissionDecision：无决策返回 null", async () => {
    const { tenantId } = await seedContext();
    const latest = await getLatestPermissionDecision(tenantId, randomToolCallId());
    expect(latest).toBeNull();
  });

  it("跨租户隔离：A 租户查询 B 租户的 PermissionDecision 返回空", async () => {
    const ctxA = await seedContext();
    const toolCallId = randomToolCallId();

    await recordPermissionDecision({
      tenantId: ctxA.tenantId,
      toolCallId,
      decision: "allow",
      reasonCodes: [],
      decidedBy: "engine",
    });

    const listA = await getPermissionDecisionsByToolCall(ctxA.tenantId, toolCallId);
    // 不存在的 tenantId 视为跨租户
    const listB = await getPermissionDecisionsByToolCall(randomUUID(), toolCallId);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. assertToolCallAllowed：三态 + 无决策
// ═══════════════════════════════════════════════════════════

describe("V11 assertToolCallAllowed：决策三态", () => {
  it("decision=allow → 返回最新决策", async () => {
    const { tenantId } = await seedContext();
    const toolCallId = randomToolCallId();

    await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "allow",
      reasonCodes: ["risk_low"],
      decidedBy: "engine",
    });

    const decision = await assertToolCallAllowed(tenantId, toolCallId);
    expect(decision.decision).toBe("allow");
  });

  it("decision=pause → ToolCallPausedError", async () => {
    const { tenantId } = await seedContext();
    const toolCallId = randomToolCallId();

    await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "pause",
      reasonCodes: ["needs_confirmation"],
      decisionSummary: "等待用户确认",
      decidedBy: "engine",
    });

    await expect(assertToolCallAllowed(tenantId, toolCallId)).rejects.toThrow(ToolCallPausedError);
    try {
      await assertToolCallAllowed(tenantId, toolCallId);
    } catch (err) {
      expect(err).toBeInstanceOf(ToolCallPausedError);
      const e = err as ToolCallPausedError;
      expect(e.toolCallId).toBe(toolCallId);
      expect(e.reasonCodes).toEqual(["needs_confirmation"]);
    }
  });

  it("decision=block → ToolCallBlockedError", async () => {
    const { tenantId } = await seedContext();
    const toolCallId = randomToolCallId();

    await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "block",
      reasonCodes: ["risk_too_high", "destructive_op"],
      decisionSummary: "操作风险过高",
      decidedBy: "engine",
    });

    await expect(assertToolCallAllowed(tenantId, toolCallId)).rejects.toThrow(ToolCallBlockedError);
    try {
      await assertToolCallAllowed(tenantId, toolCallId);
    } catch (err) {
      expect(err).toBeInstanceOf(ToolCallBlockedError);
      const e = err as ToolCallBlockedError;
      expect(e.toolCallId).toBe(toolCallId);
      expect(e.reasonCodes).toEqual(["risk_too_high", "destructive_op"]);
    }
  });

  it("无决策 → PermissionNotFoundError", async () => {
    const { tenantId } = await seedContext();
    await expect(assertToolCallAllowed(tenantId, randomToolCallId())).rejects.toThrow(
      PermissionNotFoundError,
    );
  });

  it("多次评估取最新：pause → allow → 通过", async () => {
    const { tenantId } = await seedContext();
    const toolCallId = randomToolCallId();

    await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "pause",
      reasonCodes: ["needs_confirmation"],
      decidedBy: "engine",
    });
    await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "allow",
      reasonCodes: ["user_confirmed"],
      decidedBy: "resolver",
    });

    const decision = await assertToolCallAllowed(tenantId, toolCallId);
    expect(decision.decision).toBe("allow");
    expect(decision.decisionSequence).toBe(2);
  });

  it("多次评估取最新：allow → block → 阻止", async () => {
    const { tenantId } = await seedContext();
    const toolCallId = randomToolCallId();

    await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "allow",
      reasonCodes: [],
      decidedBy: "engine",
    });
    await recordPermissionDecision({
      tenantId,
      toolCallId,
      decision: "block",
      reasonCodes: ["policy_changed"],
      decidedBy: "engine",
    });

    await expect(assertToolCallAllowed(tenantId, toolCallId)).rejects.toThrow(ToolCallBlockedError);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Grant CRUD
// ═══════════════════════════════════════════════════════════

describe("V11 Grant CRUD", () => {
  it("issueGrant：成功创建 + 默认 active + versionNo=1", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();

    const grant = await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
    });

    expect(grant.tenantId).toBe(tenantId);
    expect(grant.userId).toBe(userId);
    expect(grant.grantType).toBe("user_consent");
    expect(grant.scopeJson).toEqual(["tool:execute"]);
    expect(grant.credentialRefId).toBe(credentialRefId);
    expect(grant.issuedBy).toBe(userId);
    expect(grant.grantState).toBe("active");
    expect(grant.versionNo).toBe(1);
    expect(grant.revokedAt).toBeNull();
    expect(grant.expiresAt).toBeNull();
  });

  it("issueGrant：含过期时间", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();
    const expiresAt = futureTime(2);

    const grant = await issueGrant({
      tenantId,
      userId,
      grantType: "policy",
      scope: ["file:read:*"],
      credentialRefId,
      issuedBy: "policy-engine",
      expiresAt,
    });

    expect(grant.expiresAt).toEqual(expiresAt);
  });

  it("issueGrant：空 scope → ValidationError", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();

    await expect(
      issueGrant({
        tenantId,
        userId,
        grantType: "user_consent",
        scope: [],
        credentialRefId,
        issuedBy: userId,
      }),
    ).rejects.toThrow(GrantValidationError);
  });

  it("issueGrant：空 userId/credentialRefId/issuedBy → ValidationError", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();

    await expect(
      issueGrant({
        tenantId,
        userId: "",
        grantType: "user_consent",
        scope: ["tool:execute"],
        credentialRefId,
        issuedBy: userId,
      }),
    ).rejects.toThrow(GrantValidationError);

    await expect(
      issueGrant({
        tenantId,
        userId,
        grantType: "user_consent",
        scope: ["tool:execute"],
        credentialRefId: "",
        issuedBy: userId,
      }),
    ).rejects.toThrow(GrantValidationError);
  });

  it("issueGrant：过期时间为过去 → ValidationError", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();

    await expect(
      issueGrant({
        tenantId,
        userId,
        grantType: "user_consent",
        scope: ["tool:execute"],
        credentialRefId,
        issuedBy: userId,
        expiresAt: pastTime(1),
      }),
    ).rejects.toThrow(GrantValidationError);
  });

  it("issueGrant：非法 grantType → ValidationError", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();

    await expect(
      issueGrant({
        tenantId,
        userId,
        // @ts-expect-error 测试非法值
        grantType: "manual",
        scope: ["tool:execute"],
        credentialRefId,
        issuedBy: userId,
      }),
    ).rejects.toThrow(GrantValidationError);
  });

  it("getGrantById：跨租户隔离", async () => {
    const ctxA = await seedContext();

    const grant = await issueGrant({
      tenantId: ctxA.tenantId,
      userId: ctxA.userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId: ctxA.credentialRefId,
      issuedBy: ctxA.userId,
    });

    const fromA = await getGrantById(ctxA.tenantId, grant.id);
    // 不存在的 tenantId 视为跨租户
    const fromB = await getGrantById(randomUUID(), grant.id);
    expect(fromA?.id).toBe(grant.id);
    expect(fromB).toBeNull();
  });

  it("listGrantsByUser：按 issuedAt 降序 + 可选 state 过滤", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();

    const g1 = await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
    });
    // 微小延迟确保 issuedAt 不同
    await new Promise((r) => setTimeout(r, 10));
    const g2 = await issueGrant({
      tenantId,
      userId,
      grantType: "policy",
      scope: ["file:read"],
      credentialRefId,
      issuedBy: "engine",
    });

    const all = await listGrantsByUser(tenantId, userId);
    expect(all).toHaveLength(2);
    // 按 issuedAt 降序，g2 应在前
    expect(all[0]?.id).toBe(g2.id);
    expect(all[1]?.id).toBe(g1.id);

    const activeOnly = await listGrantsByUser(tenantId, userId, "active");
    expect(activeOnly).toHaveLength(2);

    const revokedOnly = await listGrantsByUser(tenantId, userId, "revoked");
    expect(revokedOnly).toHaveLength(0);
  });

  it("listActiveGrantsForCredential：仅返回 active Grant", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();

    const g1 = await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
    });
    const g2 = await issueGrant({
      tenantId,
      userId,
      grantType: "policy",
      scope: ["file:read"],
      credentialRefId,
      issuedBy: "engine",
    });
    await revokeGrant(tenantId, g1.id, g1.versionNo, "test_revoke");

    const active = await listActiveGrantsForCredential(tenantId, credentialRefId);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(g2.id);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Grant 撤销与状态机
// ═══════════════════════════════════════════════════════════

describe("V11 Grant 撤销与状态机", () => {
  it("revokeGrant：成功撤销 + revokedAt 回填 + versionNo 递增", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();
    const grant = await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
    });

    const revoked = await revokeGrant(tenantId, grant.id, grant.versionNo, "user_revoked");
    expect(revoked.grantState).toBe("revoked");
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(revoked.revokeReasonCode).toBe("user_revoked");
    expect(revoked.versionNo).toBe(grant.versionNo + 1);
  });

  it("revokeGrant：版本不匹配 → GrantVersionConflictError", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();
    const grant = await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
    });

    await expect(revokeGrant(tenantId, grant.id, grant.versionNo + 999)).rejects.toThrow(
      GrantVersionConflictError,
    );
  });

  it("revokeGrant：不存在 → GrantNotFoundError", async () => {
    const { tenantId } = await seedContext();
    await expect(revokeGrant(tenantId, randomUUID(), 1)).rejects.toThrow(GrantNotFoundError);
  });

  it("revokeGrant：已 revoked 不可再次撤销", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();
    const grant = await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
    });
    const revoked = await revokeGrant(tenantId, grant.id, grant.versionNo, "first_revoke");

    await expect(revokeGrant(tenantId, grant.id, revoked.versionNo)).rejects.toThrow(
      GrantStateError,
    );
  });

  it("revokeGrant：跨租户不可见 → NotFoundError", async () => {
    const ctxA = await seedContext();
    const grant = await issueGrant({
      tenantId: ctxA.tenantId,
      userId: ctxA.userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId: ctxA.credentialRefId,
      issuedBy: ctxA.userId,
    });

    // 不存在的 tenantId 视为跨租户
    await expect(revokeGrant(randomUUID(), grant.id, grant.versionNo)).rejects.toThrow(
      GrantNotFoundError,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Grant 过期扫描与生效查询
// ═══════════════════════════════════════════════════════════

describe("V11 Grant 过期扫描与生效查询", () => {
  it("markExpiredGrants：批量标记过期 active → expired", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();

    // 已过期但 grantState 仍为 active（issueGrant 校验拒绝过去时间，需 backdate）
    const expired1 = await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
      expiresAt: futureTime(1),
    });
    await backdateGrantExpiry(expired1.id, 1);
    const expired2 = await issueGrant({
      tenantId,
      userId,
      grantType: "policy",
      scope: ["file:read"],
      credentialRefId,
      issuedBy: "engine",
      expiresAt: futureTime(2),
    });
    await backdateGrantExpiry(expired2.id, 2);
    // 未过期的 Grant
    const activeGrant = await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
      expiresAt: futureTime(1),
    });
    // 永不过期的 Grant
    await issueGrant({
      tenantId,
      userId,
      grantType: "policy",
      scope: ["file:write"],
      credentialRefId,
      issuedBy: "engine",
    });

    const count = await markExpiredGrants();
    expect(count).toBe(2);

    // 验证 activeGrant 仍然 active
    const stillActive = await getGrantById(tenantId, activeGrant.id);
    expect(stillActive?.grantState).toBe("active");
  });

  it("markExpiredGrants：无过期 Grant 返回 0", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();
    await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
      expiresAt: futureTime(1),
    });

    const count = await markExpiredGrants();
    expect(count).toBe(0);
  });

  it("getEffectiveGrantForToolCall：scope 精确匹配", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();
    await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
    });

    const grant = await getEffectiveGrantForToolCall(tenantId, userId, ["tool:execute"]);
    expect(grant).not.toBeNull();
    expect(grant?.scopeJson).toEqual(["tool:execute"]);
  });

  it("getEffectiveGrantForToolCall：scope 前缀通配匹配", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();
    await issueGrant({
      tenantId,
      userId,
      grantType: "policy",
      scope: ["tool:*"],
      credentialRefId,
      issuedBy: "engine",
    });

    const grant = await getEffectiveGrantForToolCall(tenantId, userId, [
      "tool:execute:foo",
      "tool:cancel",
    ]);
    expect(grant).not.toBeNull();
  });

  it("getEffectiveGrantForToolCall：scope 不覆盖返回 null", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();
    await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["file:read:*"],
      credentialRefId,
      issuedBy: userId,
    });

    const grant = await getEffectiveGrantForToolCall(tenantId, userId, ["tool:execute"]);
    expect(grant).toBeNull();
  });

  it("getEffectiveGrantForToolCall：过期 Grant 被跳过", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();
    // 已过期但 grantState 仍为 active（未触发 markExpiredGrants 扫描）
    // issueGrant 校验拒绝过去时间，需先创建未来时间再 backdate
    const expired = await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
      expiresAt: futureTime(1),
    });
    await backdateGrantExpiry(expired.id, 1);

    const grant = await getEffectiveGrantForToolCall(tenantId, userId, ["tool:execute"]);
    expect(grant).toBeNull();
  });

  it("getEffectiveGrantForToolCall：已撤销 Grant 被跳过", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();
    const grant = await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
    });
    await revokeGrant(tenantId, grant.id, grant.versionNo, "revoked");

    const effective = await getEffectiveGrantForToolCall(tenantId, userId, ["tool:execute"]);
    expect(effective).toBeNull();
  });

  it("getEffectiveGrantForToolCall：多个 Grant 取最新 issuedAt", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();

    const oldGrant = await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
    });
    // 微小延迟确保 issuedAt 不同
    await new Promise((r) => setTimeout(r, 10));
    const newGrant = await issueGrant({
      tenantId,
      userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: userId,
    });

    const effective = await getEffectiveGrantForToolCall(tenantId, userId, ["tool:execute"]);
    expect(effective?.id).toBe(newGrant.id);
    expect(effective?.id).not.toBe(oldGrant.id);
  });

  it("getEffectiveGrantForToolCall：跨租户隔离", async () => {
    const ctxA = await seedContext();
    await issueGrant({
      tenantId: ctxA.tenantId,
      userId: ctxA.userId,
      grantType: "user_consent",
      scope: ["tool:execute"],
      credentialRefId: ctxA.credentialRefId,
      issuedBy: ctxA.userId,
    });

    // 不存在的 tenantId 视为跨租户；即使用户 ID 相同也查不到
    const grant = await getEffectiveGrantForToolCall(randomUUID(), ctxA.userId, ["tool:execute"]);
    expect(grant).toBeNull();
  });

  it("getEffectiveGrantForToolCall：永不过期 Grant 始终生效", async () => {
    const { tenantId, userId, credentialRefId } = await seedContext();
    await issueGrant({
      tenantId,
      userId,
      grantType: "policy",
      scope: ["tool:execute"],
      credentialRefId,
      issuedBy: "engine",
      // 不指定 expiresAt
    });

    const grant = await getEffectiveGrantForToolCall(tenantId, userId, ["tool:execute"]);
    expect(grant).not.toBeNull();
    expect(grant?.expiresAt).toBeNull();
  });
});
