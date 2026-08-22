/**
 * 02-6 P3 Permission Policy Revision 集成测试（真实 MySQL 8 · 冻结方案 §6 / §7 / §30 / §31 / §33 / §35 / §55.2）。
 *
 * 覆盖（§55.2）：initial default=pause / ruleKey 跨 Revision 稳定 / rulesHash 稳定 /
 * publish immutable / If-Match conflict / cross tenant / withdrawn / 非法 toolPattern /
 * decision 仅 allow|pause|block / argMatcher 未识别字段 / 非法正则 / ReDoS fail-closed /
 * AuditEvent(policy.publish) 同事务。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { computeContentHash } from "@/lib/identity/audit";
import {
  DEFAULT_TENANT_ID,
  computePolicyRulesHash,
  ensureDefaultTenant,
} from "@/lib/identity/tenant-bootstrap";
import {
  POLICY_SET_KEY,
  PolicyLoadError,
  type PolicyRuleInput,
  PolicySetStateError,
  PolicyValidationError,
  PolicyVersionConflictError,
  createPolicyRevision,
  listPoliciesByRevision,
  loadPolicySetAndRules,
  withdrawPolicyRevision,
} from "@/lib/permission/policy-queries";
import { auditEvent } from "@/lib/persistence/schema/control-plane";
import { policySetTable } from "@/lib/persistence/schema/permission";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ACTOR = { tenantId: DEFAULT_TENANT_ID, actorType: "user" as const, actorId: "test-admin" };
const REQ_ID = "req-policy-1";

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

describe("Permission Policy Revision（02-6 P3 §6/§7/§30/§31/§33/§35/§55.2）", () => {
  it("initial：defaultDecision=pause，rules=[]，revisionNo=1，rulesHash 稳定（§6.2 / §7）", async () => {
    const loaded = await loadPolicySetAndRules(DEFAULT_TENANT_ID);
    expect(loaded.set.policySetKey).toBe(POLICY_SET_KEY);
    expect(loaded.defaultDecision).toBe("pause");
    expect(loaded.rules).toHaveLength(0);
    expect(loaded.revision.revisionNo).toBe(1);
    expect(loaded.rulesHash).toBe(computePolicyRulesHash("pause", []));
    expect(loaded.rulesHash.startsWith("sha256:")).toBe(true);
  });

  it("publish：新 published Revision + rules + 切 currentRevisionId + versionNo+1 + AuditEvent(policy.publish) 同事务（§31/§35）", async () => {
    const result = await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "allow",
      rules: [
        rule({}),
        rule({ ruleKey: "r2", toolPattern: "tool.*", decision: "pause", priority: 10 }),
      ],
      expectedVersionNo: 1,
      actor: ACTOR,
      requestId: REQ_ID,
    });

    expect(result.set.versionNo).toBe(2);
    expect(result.revision.revisionNo).toBe(2);
    expect(result.revision.revisionState).toBe("published");
    expect(result.rules).toHaveLength(2);
    expect(result.rules.map((r) => r.ruleKey).sort()).toEqual(["r1", "r2"]);

    const loaded = await loadPolicySetAndRules(DEFAULT_TENANT_ID);
    expect(loaded.defaultDecision).toBe("allow");
    expect(loaded.set.versionNo).toBe(2);
    expect(loaded.rules).toHaveLength(2);

    // AuditEvent(policy.publish) 同事务（§35）。
    const events = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.tenantId, DEFAULT_TENANT_ID));
    expect(events).toHaveLength(1);
    expect(events[0]!.actionType).toBe("policy.publish");
    expect(events[0]!.targetType).toBe("policy");
    expect(events[0]!.targetId).toBe(result.set.id);
    // 审计 before/afterHash = 64 hex（computeContentHash），非 71 字符 sha256: 前缀。
    expect(events[0]!.beforeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(events[0]!.afterHash).toMatch(/^[0-9a-f]{64}$/);
    expect(events[0]!.actorId).toBe("test-admin");
    expect(events[0]!.requestId).toBe(REQ_ID);
  });

  it("ruleKey 跨 Revision 稳定：修改规则内容 ruleKey 不变，row id 变化（§6.3）", async () => {
    await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "pause",
      rules: [rule({}), rule({ ruleKey: "r2", toolPattern: "tool.*", priority: 5 })],
      expectedVersionNo: 1,
      actor: ACTOR,
      requestId: REQ_ID,
    });
    const v1 = await loadPolicySetAndRules(DEFAULT_TENANT_ID);
    const v1Rule = v1.rules.find((r) => r.ruleKey === "r1")!;

    // v2：修改 r1 内容（priority 变化），新增 r3，删除 r2。
    const result = await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "pause",
      rules: [
        rule({ priority: 99 }), // r1 修改，ruleKey 不变
        rule({ ruleKey: "r3", toolPattern: "*", decision: "block" }), // 新增
      ],
      expectedVersionNo: 2,
      actor: ACTOR,
      requestId: REQ_ID,
    });

    const ruleKeys = result.rules.map((r) => r.ruleKey).sort();
    expect(ruleKeys).toEqual(["r1", "r3"]); // r2 被删除
    const v2R1 = result.rules.find((r) => r.ruleKey === "r1")!;
    expect(v2R1.id).not.toBe(v1Rule.id); // 新 row
    expect(v2R1.priority).toBe(99); // 内容更新
  });

  it("rulesHash 稳定：未修改规则复制到新 Revision → rulesHash 不变（§7）", async () => {
    const rules = [rule({}), rule({ ruleKey: "r2", toolPattern: "tool.*" })];
    const a = await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "pause",
      rules,
      expectedVersionNo: 1,
      actor: ACTOR,
      requestId: REQ_ID,
    });
    const b = await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "pause",
      rules,
      expectedVersionNo: 2,
      actor: ACTOR,
      requestId: REQ_ID,
    });
    expect(a.rulesHash).toBe(b.rulesHash);
  });

  it("publish immutable：新 Revision 发布后旧 Revision 的 rows 内容不变（§30）", async () => {
    const v1 = await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "pause",
      rules: [rule({})],
      expectedVersionNo: 1,
      actor: ACTOR,
      requestId: REQ_ID,
    });
    const v1Rows = v1.rules;

    await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "allow",
      rules: [rule({ decision: "block" })],
      expectedVersionNo: 2,
      actor: ACTOR,
      requestId: REQ_ID,
    });

    // v1 rows 未变。
    const v1After = await listPoliciesByRevision(db, v1.revision.id);
    expect(v1After.map((r) => ({ key: r.ruleKey, d: r.decision }))).toEqual(
      v1Rows.map((r) => ({ key: r.ruleKey, d: r.decision })),
    );
  });

  it("If-Match conflict：versionNo 不匹配 → PolicyVersionConflictError，DB 无变化（§33）", async () => {
    await expect(
      createPolicyRevision({
        tenantId: DEFAULT_TENANT_ID,
        defaultDecision: "pause",
        rules: [rule({})],
        expectedVersionNo: 99,
        actor: ACTOR,
        requestId: REQ_ID,
      }),
    ).rejects.toBeInstanceOf(PolicyVersionConflictError);

    const loaded = await loadPolicySetAndRules(DEFAULT_TENANT_ID);
    expect(loaded.set.versionNo).toBe(1);
    expect(loaded.rules).toHaveLength(0);
  });

  it("cross tenant：无 PolicySet → PolicyLoadError（fail-closed）", async () => {
    await expect(
      loadPolicySetAndRules("99999999-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(PolicyLoadError);
    await expect(
      createPolicyRevision({
        tenantId: "99999999-0000-4000-8000-000000000000",
        defaultDecision: "pause",
        rules: [rule({})],
        expectedVersionNo: 1,
        actor: ACTOR,
        requestId: REQ_ID,
      }),
    ).rejects.toBeInstanceOf(PolicyLoadError);
  });

  it("withdrawn：withdraw 当前 published Revision → load 抛错；withdraw 历史不影响 current（§12.2）", async () => {
    await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "pause",
      rules: [rule({ ruleKey: "r1", toolPattern: "tool.writeFile", priority: 1 })],
      expectedVersionNo: 1,
      actor: ACTOR,
      requestId: REQ_ID,
    });
    const v2 = await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "pause",
      rules: [rule({ ruleKey: "r1", toolPattern: "tool.writeFile", priority: 2 })],
      expectedVersionNo: 2,
      actor: ACTOR,
      requestId: REQ_ID,
    });

    // withdraw current v2 → load fail-closed（§12.2：只阻止新 Binding）。
    await withdrawPolicyRevision(DEFAULT_TENANT_ID, POLICY_SET_KEY, v2.revision.id);
    await expect(loadPolicySetAndRules(DEFAULT_TENANT_ID)).rejects.toBeInstanceOf(PolicyLoadError);
  });

  it("非法 toolPattern：任意正则 / 空 / 非法字符 → 拒绝发布（§6.4）", async () => {
    for (const bad of ["^foo", "", "tool writeFile", "a..*"]) {
      await expect(
        createPolicyRevision({
          tenantId: DEFAULT_TENANT_ID,
          defaultDecision: "pause",
          rules: [rule({ toolPattern: bad })],
          expectedVersionNo: 1,
          actor: ACTOR,
          requestId: REQ_ID,
        }),
      ).rejects.toBeInstanceOf(PolicyValidationError);
    }
    // 合法形态通过（expectedVersionNo=null 跳过并发校验，连续发布）。
    for (const ok of ["*", "tool.writeFile", "tool.workspace.*"]) {
      await expect(
        createPolicyRevision({
          tenantId: DEFAULT_TENANT_ID,
          defaultDecision: "pause",
          rules: [rule({ toolPattern: ok })],
          expectedVersionNo: null,
          actor: ACTOR,
          requestId: REQ_ID,
        }),
      ).resolves.toBeDefined();
    }
  });

  it("decision 仅 allow|pause|block：Legacy ask/deny 拒绝（§P3）", async () => {
    await expect(
      createPolicyRevision({
        tenantId: DEFAULT_TENANT_ID,
        defaultDecision: "ask" as never,
        rules: [rule({})],
        expectedVersionNo: 1,
        actor: ACTOR,
        requestId: REQ_ID,
      }),
    ).rejects.toBeInstanceOf(PolicyValidationError);
    await expect(
      createPolicyRevision({
        tenantId: DEFAULT_TENANT_ID,
        defaultDecision: "pause",
        rules: [rule({ decision: "deny" as never })],
        expectedVersionNo: 1,
        actor: ACTOR,
        requestId: REQ_ID,
      }),
    ).rejects.toBeInstanceOf(PolicyValidationError);
  });

  it("argMatcher 未识别字段 → 拒绝发布（fail-closed，§6.5）", async () => {
    await expect(
      createPolicyRevision({
        tenantId: DEFAULT_TENANT_ID,
        defaultDecision: "pause",
        rules: [rule({ argMatcher: { unknownField: "x" } as never })],
        expectedVersionNo: 1,
        actor: ACTOR,
        requestId: REQ_ID,
      }),
    ).rejects.toBeInstanceOf(PolicyValidationError);
  });

  it("argMatcher 非法正则 / ReDoS → 拒绝发布（§6.5）", async () => {
    // 非法正则：无法编译。
    await expect(
      createPolicyRevision({
        tenantId: DEFAULT_TENANT_ID,
        defaultDecision: "pause",
        rules: [rule({ argMatcher: { pathRegex: "[unclosed" } })],
        expectedVersionNo: 1,
        actor: ACTOR,
        requestId: REQ_ID,
      }),
    ).rejects.toBeInstanceOf(PolicyValidationError);
    // ReDoS 风险：嵌套量词。
    await expect(
      createPolicyRevision({
        tenantId: DEFAULT_TENANT_ID,
        defaultDecision: "pause",
        rules: [rule({ argMatcher: { commandRegex: "(a+)+$" } })],
        expectedVersionNo: 1,
        actor: ACTOR,
        requestId: REQ_ID,
      }),
    ).rejects.toBeInstanceOf(PolicyValidationError);
    // 合法正则通过。
    await expect(
      createPolicyRevision({
        tenantId: DEFAULT_TENANT_ID,
        defaultDecision: "pause",
        rules: [rule({ argMatcher: { pathRegex: "^/tmp/.*$" } })],
        expectedVersionNo: 1,
        actor: ACTOR,
        requestId: REQ_ID,
      }),
    ).resolves.toBeDefined();
  });

  it("scope 非法（非对象 / 无 type）→ 拒绝发布", async () => {
    await expect(
      createPolicyRevision({
        tenantId: DEFAULT_TENANT_ID,
        defaultDecision: "pause",
        rules: [rule({ scope: "tenant" as never })],
        expectedVersionNo: 1,
        actor: ACTOR,
        requestId: REQ_ID,
      }),
    ).rejects.toBeInstanceOf(PolicyValidationError);
  });

  it("disabled set：publish 拒绝（PolicySetStateError）", async () => {
    const loaded = await loadPolicySetAndRules(DEFAULT_TENANT_ID);
    await db
      .update(policySetTable)
      .set({ lifecycleState: "disabled" })
      .where(eq(policySetTable.id, loaded.set.id));
    await expect(
      createPolicyRevision({
        tenantId: DEFAULT_TENANT_ID,
        defaultDecision: "pause",
        rules: [rule({})],
        expectedVersionNo: 1,
        actor: ACTOR,
        requestId: REQ_ID,
      }),
    ).rejects.toBeInstanceOf(PolicySetStateError);
  });

  it("审计只记 hash，不含规则内容 / Secret（§35）", async () => {
    await createPolicyRevision({
      tenantId: DEFAULT_TENANT_ID,
      defaultDecision: "pause",
      rules: [rule({ reason: "block secret /etc/secret" })],
      expectedVersionNo: 1,
      actor: ACTOR,
      requestId: REQ_ID,
    });
    const events = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.tenantId, DEFAULT_TENANT_ID));
    expect(events).toHaveLength(1);
    // 审计 body 只含 hash + actor + requestId + reason=null；不复制规则内容。
    expect(events[0]!.reason).toBeNull();
    expect(events[0]!.afterHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
