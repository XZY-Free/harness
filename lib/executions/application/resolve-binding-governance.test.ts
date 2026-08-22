/**
 * 02-6 P4 ExecutionBinding 治理冻结解析集成测试（真实 MySQL 8 · 冻结方案 §9 / §10 / §11 / §41 / §42 / §54-P4）。
 *
 * 覆盖（§54-P4 resolver 层）：
 * - Route 无显式 PolicyRevision → Tenant PolicySet("tool-execution").currentRevisionId fallback（effective 永远非空）。
 * - Route 显式 PolicyRevision → 使用该 Revision（非 current）。
 * - withdrawn Revision → 拒绝。
 * - PolicySet 生命周期 disabled → 拒绝（fail-closed）。
 * - GovernanceConfigSet disabled → 拒绝（fail-closed）。
 * - 跨租户引用 PolicyRevision → 拒绝。
 *
 * Store 层权威 fail-closed（digest 重算 / currentRevision race）由
 * dispatcher / end-to-end 集成测试覆盖；本文件专注 resolver 解析语义。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  BindingGovernanceResolutionError,
  resolveBindingGovernance,
} from "@/lib/executions/application/resolve-binding-governance";
import { GOVERNANCE_CONFIG_SET_KEY } from "@/lib/governance/config";
import {
  DEFAULT_TENANT_ID,
  computePolicyRulesHash,
  ensureDefaultTenant,
} from "@/lib/identity/tenant-bootstrap";
import {
  POLICY_SET_KEY,
  type PolicyRuleInput,
  createPolicyRevision,
  loadPolicySetAndRevision,
  withdrawPolicyRevision,
} from "@/lib/permission/policy-queries";
import { governanceConfigSetTable } from "@/lib/persistence/schema/governance-config";
import { policySetTable } from "@/lib/persistence/schema/permission";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ACTOR = { tenantId: DEFAULT_TENANT_ID, actorType: "user" as const, actorId: "test-admin" };

function rule(patch: Partial<PolicyRuleInput>): PolicyRuleInput {
  return {
    ruleKey: "r1",
    toolPattern: "tool.writeFile",
    argMatcher: null,
    decision: "allow",
    scope: { type: "tenant" },
    priority: 0,
    reason: null,
    ...patch,
  };
}

beforeEach(async () => {
  await resetDatabase(db);
  process.env.SNOW_AUTH_MODE = "dev";
  await ensureDefaultTenant();
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = "dev";
});

describe("resolveBindingGovernance（02-6 P4 §10/§11/§41/§54-P4）", () => {
  it("fallback：Route 无显式 PolicyRevision → Tenant baseline currentRevisionId + rulesHash，Governance current + configDigest", async () => {
    const resolved = await resolveBindingGovernance(db, DEFAULT_TENANT_ID, null);

    const policy = await loadPolicySetAndRevision(db, DEFAULT_TENANT_ID, POLICY_SET_KEY);
    expect(policy.revision).not.toBeNull();
    expect(resolved.policyRevisionId).toBe(policy.revision!.id);
    expect(resolved.policyRulesDigest).toBe(policy.revision!.rulesHash);
    expect(resolved.policyRulesDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resolved.governanceConfigRevisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolved.governanceConfigDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("explicit：Route 显式 PolicyRevision → 使用该 Revision（非 current，满足 §41 覆盖语义）", async () => {
    const baseline = await loadPolicySetAndRevision(db, DEFAULT_TENANT_ID, POLICY_SET_KEY);
    const explicit = await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "allow",
      rules: [rule({})],
      expectedVersionNo: baseline.set.versionNo,
      actor: ACTOR,
      requestId: "req-explicit-1",
    });

    const resolved = await resolveBindingGovernance(db, DEFAULT_TENANT_ID, explicit.revision.id);
    expect(resolved.policyRevisionId).toBe(explicit.revision.id);
    expect(resolved.policyRulesDigest).toBe(explicit.revision.rulesHash);

    // 即便 currentRevisionId 已切到新 revision，显式引用仍指向显式 revision。
    const now = await loadPolicySetAndRevision(db, DEFAULT_TENANT_ID, POLICY_SET_KEY);
    expect(now.revision!.id).toBe(explicit.revision.id);
  });

  it("withdrawn：显式引用已 withdraw 的 Revision → 拒绝（§10 fail-closed）", async () => {
    const baseline = await loadPolicySetAndRevision(db, DEFAULT_TENANT_ID, POLICY_SET_KEY);
    const created = await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "allow",
      rules: [rule({})],
      expectedVersionNo: baseline.set.versionNo,
      actor: ACTOR,
      requestId: "req-withdraw-1",
    });
    await withdrawPolicyRevision(DEFAULT_TENANT_ID, POLICY_SET_KEY, created.revision.id);

    await expect(
      resolveBindingGovernance(db, DEFAULT_TENANT_ID, created.revision.id),
    ).rejects.toThrow(BindingGovernanceResolutionError);
  });

  it("disabled：PolicySet 生命周期 disabled → fallback 拒绝（fail-closed，不 Binding）", async () => {
    const policy = await loadPolicySetAndRevision(db, DEFAULT_TENANT_ID, POLICY_SET_KEY);
    await db
      .update(policySetTable)
      .set({ lifecycleState: "disabled" })
      .where(eq(policySetTable.id, policy.set.id));

    await expect(resolveBindingGovernance(db, DEFAULT_TENANT_ID, null)).rejects.toThrow(
      BindingGovernanceResolutionError,
    );
  });

  it("disabled：GovernanceConfigSet disabled → 拒绝（§11 fail-closed）", async () => {
    const [set] = await db
      .select({ id: governanceConfigSetTable.id })
      .from(governanceConfigSetTable)
      .where(
        and(
          eq(governanceConfigSetTable.tenantId, DEFAULT_TENANT_ID),
          eq(governanceConfigSetTable.configSetKey, GOVERNANCE_CONFIG_SET_KEY),
        ),
      )
      .limit(1);
    expect(set).toBeDefined();
    await db
      .update(governanceConfigSetTable)
      .set({ lifecycleState: "disabled" })
      .where(eq(governanceConfigSetTable.id, set!.id));

    await expect(resolveBindingGovernance(db, DEFAULT_TENANT_ID, null)).rejects.toThrow(
      BindingGovernanceResolutionError,
    );
  });

  it("cross tenant：显式引用的 PolicyRevision 属于其它租户 → 拒绝", async () => {
    const baseline = await loadPolicySetAndRevision(db, DEFAULT_TENANT_ID, POLICY_SET_KEY);
    const created = await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "allow",
      rules: [rule({})],
      expectedVersionNo: baseline.set.versionNo,
      actor: ACTOR,
      requestId: "req-x-tenant-1",
    });

    // 用不同 tenantId 解析属于 DEFAULT_TENANT 的 revision → 跨租户拒绝。
    await expect(resolveBindingGovernance(db, "tenant-other", created.revision.id)).rejects.toThrow(
      BindingGovernanceResolutionError,
    );
  });

  it("explicit 引用不存在的 Revision → 拒绝（fail-closed）", async () => {
    await expect(
      resolveBindingGovernance(db, DEFAULT_TENANT_ID, "no-such-revision"),
    ).rejects.toThrow(BindingGovernanceResolutionError);
  });

  it("fallback 结果可复算：policyRulesDigest === computePolicyRulesHash(defaultDecision, [])", async () => {
    const resolved = await resolveBindingGovernance(db, DEFAULT_TENANT_ID, null);
    const policy = await loadPolicySetAndRevision(db, DEFAULT_TENANT_ID, POLICY_SET_KEY);
    expect(resolved.policyRulesDigest).toBe(
      computePolicyRulesHash(policy.revision!.defaultDecision, []),
    );
  });
});
