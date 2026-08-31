/**
 * 02-6 P1 Tenant Bootstrap 集成测试（真实 MySQL 8 · 冻结方案 §8）。
 *
 * 覆盖：
 * - ensureDefaultTenant 首次创建 tenant 时同事务建立 Governance + Policy 双 baseline。
 * - GovernanceConfigSet("runtime-execution", enabled) + initial Revision(revisionNo=1,
 *   published, INITIAL_GOVERNANCE_CONFIG)，回填 currentRevisionId。
 * - PolicySet("tool-execution", enabled) + initial PolicyRevision(revisionNo=1,
 *   published, defaultDecision=pause, Policy rows=[])，回填 currentRevisionId。
 * - 重复 ensure 幂等（不重复建 baseline）。
 * - 并发 ensure 幂等（仅一个事务实际落库）。
 * - INITIAL_GOVERNANCE_CONFIG digest 稳定；rulesHash 对空规则稳定且带 sha256: 前缀。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  DEFAULT_TENANT_ID,
  GOVERNANCE_CONFIG_SET_KEY,
  INITIAL_GOVERNANCE_CONFIG,
  POLICY_SET_KEY,
  computeGovernanceConfigDigest,
  computePolicyRulesHash,
  ensureDefaultTenant,
} from "@/lib/identity/tenant-bootstrap";
import {
  governanceConfigRevisionTable,
  governanceConfigSetTable,
} from "@/lib/persistence/schema/governance-config";
import { policyRevisionTable, policySetTable } from "@/lib/persistence/schema/permission";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function setAuthMode(mode: string | undefined) {
  process.env.SNOW_AUTH_MODE = mode;
}

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  await resetDatabase(db);
  setAuthMode("dev");
});

afterEach(() => {
  setAuthMode(ORIGINAL_AUTH_MODE);
});

describe("tenant-bootstrap（02-6 P1 §8）", () => {
  it("首次 ensureDefaultTenant 同事务建立 Governance + Policy 双 baseline 并回填 currentRevisionId", async () => {
    await ensureDefaultTenant();

    // GovernanceConfigSet
    const gcsRows = await db
      .select()
      .from(governanceConfigSetTable)
      .where(eq(governanceConfigSetTable.tenantId, DEFAULT_TENANT_ID));
    expect(gcsRows).toHaveLength(1);
    const gcs = gcsRows[0]!;
    expect(gcs.configSetKey).toBe(GOVERNANCE_CONFIG_SET_KEY);
    expect(gcs.lifecycleState).toBe("enabled");
    expect(gcs.currentRevisionId).toBeTruthy();

    // initial GovernanceConfigRevision（published, revisionNo=1, INITIAL_GOVERNANCE_CONFIG）
    const gcrRows = await db
      .select()
      .from(governanceConfigRevisionTable)
      .where(eq(governanceConfigRevisionTable.id, gcs.currentRevisionId!));
    expect(gcrRows).toHaveLength(1);
    const gcr = gcrRows[0]!;
    expect(gcr.revisionNo).toBe(1);
    expect(gcr.revisionState).toBe("published");
    expect(gcr.configDigest).toBe(computeGovernanceConfigDigest(INITIAL_GOVERNANCE_CONFIG));
    expect(gcr.configDigest.startsWith("sha256:")).toBe(true);
    expect(gcr.configJson).toEqual(INITIAL_GOVERNANCE_CONFIG);
    expect(gcr.publishedAt).not.toBeNull();

    // PolicySet
    const psRows = await db
      .select()
      .from(policySetTable)
      .where(eq(policySetTable.tenantId, DEFAULT_TENANT_ID));
    expect(psRows).toHaveLength(1);
    const ps = psRows[0]!;
    expect(ps.policySetKey).toBe(POLICY_SET_KEY);
    expect(ps.lifecycleState).toBe("enabled");
    expect(ps.currentRevisionId).toBeTruthy();

    // initial PolicyRevision（published, revisionNo=1, defaultDecision=pause, rules=[]）
    const prRows = await db
      .select()
      .from(policyRevisionTable)
      .where(eq(policyRevisionTable.id, ps.currentRevisionId!));
    expect(prRows).toHaveLength(1);
    const pr = prRows[0]!;
    expect(pr.revisionNo).toBe(1);
    expect(pr.revisionState).toBe("published");
    expect(pr.defaultDecision).toBe("pause");
    expect(pr.rulesHash).toBe(computePolicyRulesHash("pause", []));
    expect(pr.rulesHash.startsWith("sha256:")).toBe(true);
    expect(pr.publishedAt).not.toBeNull();
  });

  it("重复 ensureDefaultTenant 幂等返回同一租户，且不重复建 baseline", async () => {
    await ensureDefaultTenant();
    const second = await ensureDefaultTenant();
    expect(second.id).toBe(DEFAULT_TENANT_ID);

    const gcsRows = await db
      .select()
      .from(governanceConfigSetTable)
      .where(eq(governanceConfigSetTable.tenantId, DEFAULT_TENANT_ID));
    const psRows = await db
      .select()
      .from(policySetTable)
      .where(eq(policySetTable.tenantId, DEFAULT_TENANT_ID));
    expect(gcsRows).toHaveLength(1);
    expect(psRows).toHaveLength(1);
  });

  it("并发 ensureDefaultTenant 幂等（仅一个事务实际落库）", async () => {
    await Promise.all([ensureDefaultTenant(), ensureDefaultTenant(), ensureDefaultTenant()]);

    const gcsRows = await db
      .select()
      .from(governanceConfigSetTable)
      .where(eq(governanceConfigSetTable.tenantId, DEFAULT_TENANT_ID));
    const psRows = await db
      .select()
      .from(policySetTable)
      .where(eq(policySetTable.tenantId, DEFAULT_TENANT_ID));
    expect(gcsRows).toHaveLength(1);
    expect(psRows).toHaveLength(1);
  });

  it("INITIAL_GOVERNANCE_CONFIG digest 稳定（重复计算同值）", () => {
    const a = computeGovernanceConfigDigest(INITIAL_GOVERNANCE_CONFIG);
    const b = computeGovernanceConfigDigest({
      protectedPaths: [],
      commandDenyList: [],
      formatOnWrite: false,
      verifyBeforeDelivery: true,
      harnessLoopLimits: {
        maxLoopSteps: 12,
        maxAgentCalls: 3,
        maxToolCalls: 8,
        maxKnowledgeSearches: 6,
        maxConsecutiveSameAction: 2,
      },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("空规则 defaultDecision=pause 的 rulesHash 稳定且带 sha256: 前缀", () => {
    const a = computePolicyRulesHash("pause", []);
    const b = computePolicyRulesHash("pause", []);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rulesHash 排序稳定：priority DESC → block>pause>allow → toolPattern → ruleKey", () => {
    const rules = [
      {
        ruleKey: "z-allow",
        toolPattern: "tool.*",
        argMatcher: null,
        decision: "allow",
        scope: { type: "tenant" },
        priority: 0,
        reason: null,
      },
      {
        ruleKey: "a-block",
        toolPattern: "tool.runCommand",
        argMatcher: null,
        decision: "block",
        scope: { type: "tenant" },
        priority: 100,
        reason: null,
      },
      {
        ruleKey: "b-pause",
        toolPattern: "tool.writeFile",
        argMatcher: null,
        decision: "pause",
        scope: { type: "tenant" },
        priority: 100,
        reason: null,
      },
    ];
    // 交换输入顺序，结果 hash 应一致（排序不依赖输入顺序）。
    const forward = computePolicyRulesHash("pause", rules);
    const backward = computePolicyRulesHash("pause", [...rules].reverse());
    expect(forward).toBe(backward);
  });
});
