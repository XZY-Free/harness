/**
 * S12-W09：安全事件与隔离止损集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - createSecurityIncident：创建（open）+ 审计 security.incident + auditEventId 回填 +
 *   按 CONTAINMENT_ACTION_MATRIX 预填 containment 项 + 重复 incidentKey 检测 + 各 targetType。
 * - getSecurityIncidentById / getSecurityIncidentByKey：查询 + 跨租户隔离 + 不存在返回 null。
 * - listSecurityIncidents：cursor 分页 + severity/state/targetType/detectedBy 过滤。
 * - updateIncidentState：状态机合法/非法转移 + 审计 before/after + contained 前置校验（containment_pending）。
 * - startInvestigation / containIncident / resolveIncident / escalateIncident：便捷封装。
 * - Containment 管理：list / get / markContainmentApplied（evidence_ref 必填） /
 *   markContainmentFailed / revertContainment + 状态机非法转移。
 * - computeContainmentSummary / deriveIncidentContainable：汇总与可隔离派生。
 * - buildIncidentTimeline：从 AuditEvent 汇总事故时间线。
 * - getActiveIncidentByTarget：非终态事故查询。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/identity/audit";
import { listAuditEvents } from "@/lib/identity/audit-queries";
import {
  SecurityIncidentError,
  buildIncidentTimeline,
  computeContainmentSummary,
  containIncident,
  createSecurityIncident,
  deriveIncidentContainable,
  escalateIncident,
  getActiveIncidentByTarget,
  getContainment,
  getSecurityIncidentById,
  getSecurityIncidentByKey,
  listIncidentContainments,
  listSecurityIncidents,
  markContainmentApplied,
  markContainmentFailed,
  resolveIncident,
  revertContainment,
  startInvestigation,
  updateIncidentState,
} from "@/lib/identity/security-incident-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { tenant } from "@/lib/persistence/schema/identity";
import {
  CONTAINMENT_ACTION_MATRIX,
  type IncidentSeverity,
  type IncidentTargetType,
} from "@/lib/persistence/schema/security-incident";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无全局 override 需清理
});

// ─── 辅助 ──────────────────────────────────────────────────

function buildActor(tenantId: string): AuditActor {
  return { tenantId, actorType: "user", actorId: "secops-001" };
}

function buildCreateParams(opts: {
  tenantId: string;
  incidentKey?: string;
  severity?: IncidentSeverity;
  targetType?: IncidentTargetType;
  targetId?: string;
  summary?: string;
  detectedBy?: string;
}) {
  return {
    tenantId: opts.tenantId,
    incidentKey: opts.incidentKey ?? `INC-${Math.random().toString(36).slice(2, 10)}`,
    severity: opts.severity ?? ("high" as const),
    targetType: opts.targetType ?? ("credential" as const),
    targetId: opts.targetId ?? "cred-001",
    summary: opts.summary ?? "Credential 疑似泄露",
    detectedBy: opts.detectedBy ?? "audit",
    actor: buildActor(opts.tenantId),
  };
}

async function seedExtraTenant(tenantId: string, key: string): Promise<void> {
  await db.insert(tenant).values({
    id: tenantId,
    key,
    name: `Extra Tenant ${key}`,
    status: "active",
  });
}

/** 将 incident 下所有 containment 标记为 applied（满足 containIncident 前置条件）。 */
async function applyAllContainments(
  tenantId: string,
  incidentId: string,
  evidenceRefPrefix = "evidence",
): Promise<void> {
  const containments = await listIncidentContainments(tenantId, incidentId);
  for (const c of containments) {
    await markContainmentApplied({
      tenantId,
      containmentId: c.id,
      evidenceRef: `${evidenceRefPrefix}:${c.actionType}:${incidentId}`,
    });
  }
}

const EXTRA_TENANT_ID = "00000000-0000-4000-8000-0000000000a9";

// ═══════════════════════════════════════════════════════════
// 1. createSecurityIncident
// ═══════════════════════════════════════════════════════════

describe("createSecurityIncident", () => {
  it("创建事故（open 状态）并返回完整字段", async () => {
    const t = await ensureDefaultTenant();
    const incident = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));

    expect(incident.id).toBeDefined();
    expect(incident.tenantId).toBe(t.id);
    expect(incident.incidentKey).toBeDefined();
    expect(incident.severity).toBe("high");
    expect(incident.incidentState).toBe("open");
    expect(incident.targetType).toBe("credential");
    expect(incident.targetId).toBe("cred-001");
    expect(incident.summary).toBe("Credential 疑似泄露");
    expect(incident.detectedBy).toBe("audit");
    expect(incident.detectedAt).toBeInstanceOf(Date);
    expect(incident.investigatingAt).toBeNull();
    expect(incident.containedAt).toBeNull();
    expect(incident.resolvedAt).toBeNull();
    expect(incident.closedBy).toBeNull();
    expect(incident.closureReason).toBeNull();
    expect(incident.containmentSummaryJson).toBeNull();
    expect(incident.auditEventId).toBeTruthy();
    expect(incident.requestId).toBeNull();
    expect(incident.createdAt).toBeInstanceOf(Date);
    expect(incident.updatedAt).toBeInstanceOf(Date);
  });

  it("创建时写审计事件 security.incident 并回填 auditEventId", async () => {
    const t = await ensureDefaultTenant();
    const incident = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));

    const events = await listAuditEvents({
      tenantId: t.id,
      actionType: "security.incident",
      targetType: "security_incident",
      targetId: incident.id,
    });

    expect(events.length).toBe(1);
    const event = events[0];
    expect(event).toBeDefined();
    expect(event?.actorType).toBe("user");
    expect(event?.actorId).toBe("secops-001");
    expect(event?.afterHash).toBeTruthy();
    expect(incident.auditEventId).toBe(event?.id);
  });

  it("按 CONTAINMENT_ACTION_MATRIX.credential 预填 containment 项（state=pending）", async () => {
    const t = await ensureDefaultTenant();
    const incident = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));

    const containments = await listIncidentContainments(t.id, incident.id);
    const expected = CONTAINMENT_ACTION_MATRIX.credential;
    expect(containments.length).toBe(expected.length);
    expect(containments.map((c) => c.actionType)).toEqual([...expected]);
    for (const c of containments) {
      expect(c.actionState).toBe("pending");
      expect(c.evidenceRef).toBeNull();
      expect(c.tenantId).toBe(t.id);
      expect(c.incidentId).toBe(incident.id);
      expect(c.targetRef).toBeTruthy();
    }
  });

  it("各 targetType 预填的 containment 数量符合 CONTAINMENT_ACTION_MATRIX", async () => {
    const t = await ensureDefaultTenant();
    const cases: Array<{ targetType: IncidentTargetType; expected: readonly string[] }> = [
      { targetType: "agent", expected: CONTAINMENT_ACTION_MATRIX.agent },
      { targetType: "agent_revision", expected: CONTAINMENT_ACTION_MATRIX.agent_revision },
      { targetType: "tool_provider", expected: CONTAINMENT_ACTION_MATRIX.tool_provider },
      { targetType: "tool", expected: CONTAINMENT_ACTION_MATRIX.tool },
      { targetType: "credential", expected: CONTAINMENT_ACTION_MATRIX.credential },
      { targetType: "runtime", expected: CONTAINMENT_ACTION_MATRIX.runtime },
      { targetType: "environment", expected: CONTAINMENT_ACTION_MATRIX.environment },
      { targetType: "workload_token", expected: CONTAINMENT_ACTION_MATRIX.workload_token },
      { targetType: "other", expected: CONTAINMENT_ACTION_MATRIX.other },
    ];

    for (const c of cases) {
      const incident = await createSecurityIncident(
        buildCreateParams({
          tenantId: t.id,
          targetType: c.targetType,
          targetId: `${c.targetType}-id`,
          incidentKey: `INC-${c.targetType}`,
        }),
      );
      const containments = await listIncidentContainments(t.id, incident.id);
      expect(containments.length).toBe(c.expected.length);
      // 矩阵顺序不等于 ENUM 定义顺序；用集合校验 membership
      expect(containments.map((x) => x.actionType).sort()).toEqual([...c.expected].sort());
    }
  });

  it("targetType=other 不预填 containment（人工评估后手动添加）", async () => {
    const t = await ensureDefaultTenant();
    const incident = await createSecurityIncident(
      buildCreateParams({ tenantId: t.id, targetType: "other", targetId: "ssrf-001" }),
    );

    const containments = await listIncidentContainments(t.id, incident.id);
    expect(containments.length).toBe(0);
  });

  it("重复 incidentKey 抛 duplicate_incident_key", async () => {
    const t = await ensureDefaultTenant();
    await createSecurityIncident(buildCreateParams({ tenantId: t.id, incidentKey: "INC-DUP-001" }));

    await expect(
      createSecurityIncident(buildCreateParams({ tenantId: t.id, incidentKey: "INC-DUP-001" })),
    ).rejects.toMatchObject({ code: "duplicate_incident_key" });
  });

  it("不同租户允许相同 incidentKey", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    await createSecurityIncident(
      buildCreateParams({ tenantId: t.id, incidentKey: "INC-SHARED-001" }),
    );

    const incident2 = await createSecurityIncident(
      buildCreateParams({ tenantId: EXTRA_TENANT_ID, incidentKey: "INC-SHARED-001" }),
    );
    expect(incident2.tenantId).toBe(EXTRA_TENANT_ID);
  });

  it("severity/targetType 全枚举覆盖", async () => {
    const t = await ensureDefaultTenant();
    const severities: IncidentSeverity[] = ["low", "medium", "high", "critical"];
    const targetTypes: IncidentTargetType[] = [
      "agent",
      "agent_revision",
      "tool_provider",
      "tool",
      "credential",
      "runtime",
      "environment",
      "workload_token",
      "other",
    ];
    let counter = 0;
    for (const sev of severities) {
      for (const tt of targetTypes) {
        counter += 1;
        const incident = await createSecurityIncident(
          buildCreateParams({
            tenantId: t.id,
            severity: sev,
            targetType: tt,
            targetId: `${tt}-${counter}`,
            incidentKey: `INC-${sev}-${tt}-${counter}`,
          }),
        );
        expect(incident.severity).toBe(sev);
        expect(incident.targetType).toBe(tt);
      }
    }
  });

  it("自定义 detectedBy 与 summary", async () => {
    const t = await ensureDefaultTenant();
    const incident = await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        detectedBy: "manual",
        summary: "人工上报：runtime 异常进程",
      }),
    );
    expect(incident.detectedBy).toBe("manual");
    expect(incident.summary).toBe("人工上报：runtime 异常进程");
  });

  it("summary 省略时使用默认值", async () => {
    const t = await ensureDefaultTenant();
    const incident = await createSecurityIncident({
      tenantId: t.id,
      incidentKey: "INC-NO-SUMMARY",
      severity: "low",
      targetType: "credential",
      targetId: "cred-002",
      detectedBy: "alert",
      actor: buildActor(t.id),
    });
    expect(incident.summary).toBeNull();
  });

  it("requestId 透传", async () => {
    const t = await ensureDefaultTenant();
    const incident = await createSecurityIncident({
      ...buildCreateParams({ tenantId: t.id, incidentKey: "INC-REQ-001" }),
      requestId: "req-abc-123",
    });
    expect(incident.requestId).toBe("req-abc-123");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. getSecurityIncidentById / getSecurityIncidentByKey
// ═══════════════════════════════════════════════════════════

describe("getSecurityIncidentById / getSecurityIncidentByKey", () => {
  it("按 id 查询事故", async () => {
    const t = await ensureDefaultTenant();
    const incident = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));

    const found = await getSecurityIncidentById(t.id, incident.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(incident.id);
  });

  it("按 incidentKey 查询事故", async () => {
    const t = await ensureDefaultTenant();
    const incident = await createSecurityIncident(
      buildCreateParams({ tenantId: t.id, incidentKey: "INC-BY-KEY" }),
    );

    const found = await getSecurityIncidentByKey(t.id, "INC-BY-KEY");
    expect(found).not.toBeNull();
    expect(found?.id).toBe(incident.id);
  });

  it("id 不存在返回 null", async () => {
    const t = await ensureDefaultTenant();
    const found = await getSecurityIncidentById(t.id, "non-existent");
    expect(found).toBeNull();
  });

  it("key 不存在返回 null", async () => {
    const t = await ensureDefaultTenant();
    const found = await getSecurityIncidentByKey(t.id, "NON-EXISTENT-KEY");
    expect(found).toBeNull();
  });

  it("跨租户隔离：getSecurityIncidentById", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    const incident = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));

    const found = await getSecurityIncidentById(EXTRA_TENANT_ID, incident.id);
    expect(found).toBeNull();
  });

  it("跨租户隔离：getSecurityIncidentByKey", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    await createSecurityIncident(
      buildCreateParams({ tenantId: t.id, incidentKey: "INC-CROSS-TENANT" }),
    );

    const found = await getSecurityIncidentByKey(EXTRA_TENANT_ID, "INC-CROSS-TENANT");
    expect(found).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. listSecurityIncidents（cursor 分页 + 过滤）
// ═══════════════════════════════════════════════════════════

describe("listSecurityIncidents", () => {
  it("按 detectedAt 升序返回", async () => {
    const t = await ensureDefaultTenant();
    const targetTypes: IncidentTargetType[] = ["credential", "agent", "runtime"];
    for (const tt of targetTypes) {
      await createSecurityIncident(
        buildCreateParams({
          tenantId: t.id,
          targetType: tt,
          targetId: `${tt}-001`,
          incidentKey: `INC-LIST-${tt}`,
        }),
      );
      await new Promise((r) => setTimeout(r, 5));
    }

    const page = await listSecurityIncidents({ tenantId: t.id });
    expect(page.items.length).toBe(3);
    expect(page.items[0]?.targetType).toBe("credential");
    expect(page.items[2]?.targetType).toBe("runtime");
    expect(page.nextCursor).toBeNull();
  });

  it("limit 截断 + nextCursor 翻页", async () => {
    const t = await ensureDefaultTenant();
    const targetTypes: IncidentTargetType[] = [
      "credential",
      "agent",
      "runtime",
      "tool",
      "environment",
    ];
    for (const tt of targetTypes) {
      await createSecurityIncident(
        buildCreateParams({
          tenantId: t.id,
          targetType: tt,
          targetId: `${tt}-001`,
          incidentKey: `INC-PAGE-${tt}`,
        }),
      );
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await listSecurityIncidents({ tenantId: t.id, limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listSecurityIncidents({
      tenantId: t.id,
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items.length).toBe(2);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await listSecurityIncidents({
      tenantId: t.id,
      limit: 2,
      cursor: page2.nextCursor ?? undefined,
    });
    expect(page3.items.length).toBe(1);
    expect(page3.nextCursor).toBeNull();

    const allIds = [...page1.items, ...page2.items, ...page3.items].map((i) => i.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it("按 severity 过滤", async () => {
    const t = await ensureDefaultTenant();
    await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        severity: "high",
        targetType: "credential",
        targetId: "c-1",
        incidentKey: "INC-SEV-1",
      }),
    );
    await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        severity: "low",
        targetType: "agent",
        targetId: "a-1",
        incidentKey: "INC-SEV-2",
      }),
    );

    const page = await listSecurityIncidents({ tenantId: t.id, severity: "high" });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.severity).toBe("high");
  });

  it("按 incidentState 过滤", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(
      buildCreateParams({ tenantId: t.id, incidentKey: "INC-STATE-1" }),
    );
    await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        targetType: "agent",
        targetId: "a-1",
        incidentKey: "INC-STATE-2",
      }),
    );
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });

    const openPage = await listSecurityIncidents({ tenantId: t.id, incidentState: "open" });
    expect(openPage.items.length).toBe(1);
    expect(openPage.items[0]?.incidentState).toBe("open");

    const investigatingPage = await listSecurityIncidents({
      tenantId: t.id,
      incidentState: "investigating",
    });
    expect(investigatingPage.items.length).toBe(1);
    expect(investigatingPage.items[0]?.incidentState).toBe("investigating");
  });

  it("按 targetType 过滤", async () => {
    const t = await ensureDefaultTenant();
    await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        targetType: "credential",
        targetId: "c-1",
        incidentKey: "INC-TT-1",
      }),
    );
    await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        targetType: "agent",
        targetId: "a-1",
        incidentKey: "INC-TT-2",
      }),
    );

    const page = await listSecurityIncidents({ tenantId: t.id, targetType: "credential" });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.targetType).toBe("credential");
  });

  it("按 detectedBy 过滤", async () => {
    const t = await ensureDefaultTenant();
    await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        detectedBy: "alert",
        incidentKey: "INC-DB-1",
      }),
    );
    await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        detectedBy: "manual",
        targetType: "agent",
        targetId: "a-1",
        incidentKey: "INC-DB-2",
      }),
    );

    const page = await listSecurityIncidents({ tenantId: t.id, detectedBy: "alert" });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.detectedBy).toBe("alert");
  });

  it("非法 cursor 抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    await createSecurityIncident(buildCreateParams({ tenantId: t.id }));

    await expect(
      listSecurityIncidents({ tenantId: t.id, cursor: "not-base64url!!" }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("跨租户隔离：listSecurityIncidents", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    await createSecurityIncident(buildCreateParams({ tenantId: t.id, incidentKey: "INC-ISO-1" }));
    await createSecurityIncident(
      buildCreateParams({ tenantId: EXTRA_TENANT_ID, incidentKey: "INC-ISO-2" }),
    );

    const pageT = await listSecurityIncidents({ tenantId: t.id });
    expect(pageT.items.length).toBe(1);
    expect(pageT.items[0]?.tenantId).toBe(t.id);

    const pageE = await listSecurityIncidents({ tenantId: EXTRA_TENANT_ID });
    expect(pageE.items.length).toBe(1);
    expect(pageE.items[0]?.tenantId).toBe(EXTRA_TENANT_ID);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. updateIncidentState（状态机 + 审计）
// ═══════════════════════════════════════════════════════════

describe("updateIncidentState", () => {
  it("open → investigating 合法转移 + 回填 investigatingAt + 审计 before/after", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));

    const updated = await updateIncidentState({
      tenantId: t.id,
      id: inc.id,
      nextState: "investigating",
      actor: buildActor(t.id),
    });

    expect(updated.incidentState).toBe("investigating");
    expect(updated.investigatingAt).toBeInstanceOf(Date);
    expect(updated.containedAt).toBeNull();

    // 审计：第二条 security.incident 事件（第一条为创建）
    const events = await listAuditEvents({
      tenantId: t.id,
      actionType: "security.incident",
      targetType: "security_incident",
      targetId: inc.id,
    });
    expect(events.length).toBe(2);
    const transitionEvent = events[1];
    expect(transitionEvent?.beforeHash).toBeTruthy();
    expect(transitionEvent?.afterHash).toBeTruthy();
  });

  it("investigating → contained 合法转移（containment 全 applied）+ 回填 containedAt + summary", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });
    await applyAllContainments(t.id, inc.id);

    const updated = await updateIncidentState({
      tenantId: t.id,
      id: inc.id,
      nextState: "contained",
      actor: buildActor(t.id),
    });

    expect(updated.incidentState).toBe("contained");
    expect(updated.containedAt).toBeInstanceOf(Date);
    expect(updated.containmentSummaryJson).toBeTruthy();
    const summary = JSON.parse(updated.containmentSummaryJson ?? "{}");
    expect(summary.containmentCount).toBe(1);
    expect(summary.appliedCount).toBe(1);
    expect(summary.pendingCount).toBe(0);
  });

  it("contained → resolved 合法转移 + 回填 resolvedAt + closedBy + closureReason", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });
    await applyAllContainments(t.id, inc.id);
    await containIncident({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });

    const updated = await updateIncidentState({
      tenantId: t.id,
      id: inc.id,
      nextState: "resolved",
      actor: buildActor(t.id),
      closedBy: "secops-001",
      closureReason: "已确认无影响并恢复",
    });

    expect(updated.incidentState).toBe("resolved");
    expect(updated.resolvedAt).toBeInstanceOf(Date);
    expect(updated.closedBy).toBe("secops-001");
    expect(updated.closureReason).toBe("已确认无影响并恢复");
  });

  it("open → escalated 合法转移 + 回填 closedBy", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));

    const updated = await updateIncidentState({
      tenantId: t.id,
      id: inc.id,
      nextState: "escalated",
      actor: buildActor(t.id),
      closedBy: "secops-001",
      closureReason: "需安全团队介入",
    });

    expect(updated.incidentState).toBe("escalated");
    expect(updated.closedBy).toBe("secops-001");
    expect(updated.closureReason).toBe("需安全团队介入");
  });

  it("非法转移：open → resolved 抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));

    await expect(
      updateIncidentState({
        tenantId: t.id,
        id: inc.id,
        nextState: "resolved",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("非法转移：resolved → investigating 抛 illegal_transition（终态）", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });
    await applyAllContainments(t.id, inc.id);
    await containIncident({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });
    await resolveIncident({
      tenantId: t.id,
      id: inc.id,
      actor: buildActor(t.id),
      closedBy: "secops-001",
    });

    await expect(
      updateIncidentState({
        tenantId: t.id,
        id: inc.id,
        nextState: "investigating",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("contained 前置校验：存在 pending containment 抛 containment_pending", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });
    // 不调用 applyAllContainments：保持 pending

    await expect(
      updateIncidentState({
        tenantId: t.id,
        id: inc.id,
        nextState: "contained",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "containment_pending" });
  });

  it("contained 前置校验：含 failed 也允许 contained（无需全部 applied）", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(
      buildCreateParams({ tenantId: t.id, targetType: "runtime", targetId: "rt-001" }),
    );
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });

    // runtime 预填 2 个 containment，1 个 applied，1 个 failed
    const containments = await listIncidentContainments(t.id, inc.id);
    expect(containments.length).toBe(2);
    const first = containments[0];
    const second = containments[1];
    if (!first || !second) throw new Error("测试设置错误：期望至少 2 条 containment");

    await markContainmentApplied({
      tenantId: t.id,
      containmentId: first.id,
      evidenceRef: "evidence:applied",
    });
    await markContainmentFailed({
      tenantId: t.id,
      containmentId: second.id,
      failureReason: "撤销失败：目标已不存在",
    });

    const updated = await updateIncidentState({
      tenantId: t.id,
      id: inc.id,
      nextState: "contained",
      actor: buildActor(t.id),
    });
    expect(updated.incidentState).toBe("contained");

    const summary = JSON.parse(updated.containmentSummaryJson ?? "{}");
    expect(summary.appliedCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.pendingCount).toBe(0);
  });

  it("事故不存在抛 incident_not_found", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      updateIncidentState({
        tenantId: t.id,
        id: "non-existent",
        nextState: "investigating",
        actor: buildActor(t.id),
      }),
    ).rejects.toMatchObject({ code: "incident_not_found" });
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 便捷封装
// ═══════════════════════════════════════════════════════════

describe("便捷封装（startInvestigation / containIncident / resolveIncident / escalateIncident）", () => {
  it("startInvestigation：open → investigating", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));

    const updated = await startInvestigation({
      tenantId: t.id,
      id: inc.id,
      actor: buildActor(t.id),
    });
    expect(updated.incidentState).toBe("investigating");
  });

  it("containIncident：investigating → contained（containment 全 applied）", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });
    await applyAllContainments(t.id, inc.id);

    const updated = await containIncident({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });
    expect(updated.incidentState).toBe("contained");
  });

  it("resolveIncident：contained → resolved", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });
    await applyAllContainments(t.id, inc.id);
    await containIncident({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });

    const updated = await resolveIncident({
      tenantId: t.id,
      id: inc.id,
      actor: buildActor(t.id),
      closedBy: "secops-001",
      closureReason: "已恢复",
    });
    expect(updated.incidentState).toBe("resolved");
    expect(updated.closedBy).toBe("secops-001");
  });

  it("escalateIncident：open → escalated", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));

    const updated = await escalateIncident({
      tenantId: t.id,
      id: inc.id,
      actor: buildActor(t.id),
      closedBy: "secops-001",
      closureReason: "需上级介入",
    });
    expect(updated.incidentState).toBe("escalated");
  });

  it("escalateIncident：investigating → escalated", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });

    const updated = await escalateIncident({
      tenantId: t.id,
      id: inc.id,
      actor: buildActor(t.id),
      closedBy: "secops-001",
    });
    expect(updated.incidentState).toBe("escalated");
  });

  it("escalateIncident：contained → escalated", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });
    await applyAllContainments(t.id, inc.id);
    await containIncident({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });

    const updated = await escalateIncident({
      tenantId: t.id,
      id: inc.id,
      actor: buildActor(t.id),
      closedBy: "secops-001",
    });
    expect(updated.incidentState).toBe("escalated");
  });

  it("escalated 为终态：escalateIncident 抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    await escalateIncident({
      tenantId: t.id,
      id: inc.id,
      actor: buildActor(t.id),
      closedBy: "secops-001",
    });

    await expect(
      escalateIncident({
        tenantId: t.id,
        id: inc.id,
        actor: buildActor(t.id),
        closedBy: "secops-001",
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Containment 管理
// ═══════════════════════════════════════════════════════════

describe("Containment 管理", () => {
  it("listIncidentContainments：按 actionType ENUM 定义序返回", async () => {
    const t = await ensureDefaultTenant();
    // runtime 预填 2 个：withdraw_runtime_revision + disable_route
    const inc = await createSecurityIncident(
      buildCreateParams({ tenantId: t.id, targetType: "runtime", targetId: "rt-001" }),
    );

    const containments = await listIncidentContainments(t.id, inc.id);
    expect(containments.length).toBe(2);
    // MySQL ENUM 按 CONTAINMENT_ACTION_TYPES 定义序：
    // disable_route (idx=3) < withdraw_runtime_revision (idx=5)
    expect(containments[0]?.actionType).toBe("disable_route");
    expect(containments[1]?.actionType).toBe("withdraw_runtime_revision");
  });

  it("getContainment：按 id 查询 + 跨租户隔离", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    const containments = await listIncidentContainments(t.id, inc.id);
    const first = containments[0];
    if (!first) throw new Error("测试设置错误");

    const found = await getContainment(t.id, first.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(first.id);

    const crossTenant = await getContainment(EXTRA_TENANT_ID, first.id);
    expect(crossTenant).toBeNull();
  });

  it("markContainmentApplied：pending → applied + 回填 evidenceRef + appliedAt", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    const containments = await listIncidentContainments(t.id, inc.id);
    const first = containments[0];
    if (!first) throw new Error("测试设置错误");

    const updated = await markContainmentApplied({
      tenantId: t.id,
      containmentId: first.id,
      evidenceRef: "CredentialRevocation:rev-001",
      detailsJson: JSON.stringify({ revokedAt: new Date().toISOString() }),
    });

    expect(updated.actionState).toBe("applied");
    expect(updated.evidenceRef).toBe("CredentialRevocation:rev-001");
    expect(updated.appliedAt).toBeInstanceOf(Date);
    expect(updated.detailsJson).toBeTruthy();
  });

  it("markContainmentApplied：缺少 evidenceRef 抛 missing_evidence", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    const containments = await listIncidentContainments(t.id, inc.id);
    const first = containments[0];
    if (!first) throw new Error("测试设置错误");

    await expect(
      markContainmentApplied({
        tenantId: t.id,
        containmentId: first.id,
        evidenceRef: "   ",
      }),
    ).rejects.toMatchObject({ code: "missing_evidence" });
  });

  it("markContainmentApplied：已 applied 再次 applied 抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    const containments = await listIncidentContainments(t.id, inc.id);
    const first = containments[0];
    if (!first) throw new Error("测试设置错误");

    await markContainmentApplied({
      tenantId: t.id,
      containmentId: first.id,
      evidenceRef: "evidence:1",
    });

    await expect(
      markContainmentApplied({
        tenantId: t.id,
        containmentId: first.id,
        evidenceRef: "evidence:2",
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("markContainmentFailed：pending → failed + 回填 failureReason", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    const containments = await listIncidentContainments(t.id, inc.id);
    const first = containments[0];
    if (!first) throw new Error("测试设置错误");

    const updated = await markContainmentFailed({
      tenantId: t.id,
      containmentId: first.id,
      failureReason: "目标已不存在",
    });

    expect(updated.actionState).toBe("failed");
    expect(updated.failureReason).toBe("目标已不存在");
  });

  it("markContainmentFailed：已 applied 再次 failed 抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    const containments = await listIncidentContainments(t.id, inc.id);
    const first = containments[0];
    if (!first) throw new Error("测试设置错误");

    await markContainmentApplied({
      tenantId: t.id,
      containmentId: first.id,
      evidenceRef: "evidence:1",
    });

    await expect(
      markContainmentFailed({
        tenantId: t.id,
        containmentId: first.id,
        failureReason: "后置失败",
      }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("revertContainment：applied → reverted + 回填 revertedAt", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    const containments = await listIncidentContainments(t.id, inc.id);
    const first = containments[0];
    if (!first) throw new Error("测试设置错误");

    await markContainmentApplied({
      tenantId: t.id,
      containmentId: first.id,
      evidenceRef: "evidence:1",
    });

    const reverted = await revertContainment({
      tenantId: t.id,
      containmentId: first.id,
      reason: "事故已恢复",
    });

    expect(reverted.actionState).toBe("reverted");
    expect(reverted.revertedAt).toBeInstanceOf(Date);
  });

  it("revertContainment：pending 直接 revert 抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    const containments = await listIncidentContainments(t.id, inc.id);
    const first = containments[0];
    if (!first) throw new Error("测试设置错误");

    await expect(
      revertContainment({ tenantId: t.id, containmentId: first.id }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("revertContainment：failed 直接 revert 抛 illegal_transition", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    const containments = await listIncidentContainments(t.id, inc.id);
    const first = containments[0];
    if (!first) throw new Error("测试设置错误");

    await markContainmentFailed({
      tenantId: t.id,
      containmentId: first.id,
      failureReason: "失败",
    });

    await expect(
      revertContainment({ tenantId: t.id, containmentId: first.id }),
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("containment 不存在抛 containment_not_found", async () => {
    const t = await ensureDefaultTenant();
    await expect(
      markContainmentApplied({
        tenantId: t.id,
        containmentId: "non-existent",
        evidenceRef: "evidence",
      }),
    ).rejects.toMatchObject({ code: "containment_not_found" });

    await expect(
      markContainmentFailed({
        tenantId: t.id,
        containmentId: "non-existent",
        failureReason: "x",
      }),
    ).rejects.toMatchObject({ code: "containment_not_found" });

    await expect(
      revertContainment({ tenantId: t.id, containmentId: "non-existent" }),
    ).rejects.toMatchObject({ code: "containment_not_found" });
  });
});

// ═══════════════════════════════════════════════════════════
// 7. computeContainmentSummary / deriveIncidentContainable
// ═══════════════════════════════════════════════════════════

describe("computeContainmentSummary / deriveIncidentContainable", () => {
  it("computeContainmentSummary：空数组返回零值", () => {
    const summary = computeContainmentSummary([]);
    expect(summary.containmentCount).toBe(0);
    expect(summary.appliedCount).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(summary.pendingCount).toBe(0);
    expect(summary.revertedCount).toBe(0);
  });

  it("computeContainmentSummary：正确汇总各状态", async () => {
    const t = await ensureDefaultTenant();
    // runtime 预填 2 个 containment
    const inc = await createSecurityIncident(
      buildCreateParams({ tenantId: t.id, targetType: "runtime", targetId: "rt-001" }),
    );
    const containments = await listIncidentContainments(t.id, inc.id);
    const first = containments[0];
    const second = containments[1];
    if (!first || !second) throw new Error("测试设置错误");

    await markContainmentApplied({
      tenantId: t.id,
      containmentId: first.id,
      evidenceRef: "evidence:1",
    });
    await markContainmentFailed({
      tenantId: t.id,
      containmentId: second.id,
      failureReason: "失败",
    });

    const refreshed = await listIncidentContainments(t.id, inc.id);
    const summary = computeContainmentSummary(refreshed);
    expect(summary.containmentCount).toBe(2);
    expect(summary.appliedCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.pendingCount).toBe(0);
    expect(summary.revertedCount).toBe(0);
  });

  it("deriveIncidentContainable：空数组返回 true", () => {
    expect(deriveIncidentContainable([])).toBe(true);
  });

  it("deriveIncidentContainable：全 applied/failed 返回 true", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(
      buildCreateParams({ tenantId: t.id, targetType: "runtime", targetId: "rt-001" }),
    );
    const containments = await listIncidentContainments(t.id, inc.id);
    await markContainmentApplied({
      tenantId: t.id,
      containmentId: containments[0]?.id ?? "",
      evidenceRef: "evidence:1",
    });
    await markContainmentFailed({
      tenantId: t.id,
      containmentId: containments[1]?.id ?? "",
      failureReason: "失败",
    });

    const refreshed = await listIncidentContainments(t.id, inc.id);
    expect(deriveIncidentContainable(refreshed)).toBe(true);
  });

  it("deriveIncidentContainable：含 pending 返回 false", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(
      buildCreateParams({ tenantId: t.id, targetType: "runtime", targetId: "rt-001" }),
    );
    const containments = await listIncidentContainments(t.id, inc.id);
    // 只 apply 一个，另一个保持 pending
    await markContainmentApplied({
      tenantId: t.id,
      containmentId: containments[0]?.id ?? "",
      evidenceRef: "evidence:1",
    });

    const refreshed = await listIncidentContainments(t.id, inc.id);
    expect(deriveIncidentContainable(refreshed)).toBe(false);
  });

  it("deriveIncidentContainable：含 reverted 也返回 true（reverted 不阻塞 contained）", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    const containments = await listIncidentContainments(t.id, inc.id);
    await markContainmentApplied({
      tenantId: t.id,
      containmentId: containments[0]?.id ?? "",
      evidenceRef: "evidence:1",
    });
    await revertContainment({ tenantId: t.id, containmentId: containments[0]?.id ?? "" });

    const refreshed = await listIncidentContainments(t.id, inc.id);
    expect(deriveIncidentContainable(refreshed)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. buildIncidentTimeline
// ═══════════════════════════════════════════════════════════

describe("buildIncidentTimeline", () => {
  it("从 AuditEvent 汇总时间线（按 occurredAt 升序）", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });
    await applyAllContainments(t.id, inc.id);
    await containIncident({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });

    const timeline = await buildIncidentTimeline(t.id, inc.id);
    // 创建 + investigating + contained = 3 条审计事件
    expect(timeline.length).toBe(3);
    expect(timeline[0]?.actionType).toBe("security.incident");
    expect(timeline[2]?.actionType).toBe("security.incident");
    // 升序校验
    for (let i = 1; i < timeline.length; i++) {
      const prev = timeline[i - 1];
      const curr = timeline[i];
      if (!prev || !curr) continue;
      expect(curr.occurredAt.getTime()).toBeGreaterThanOrEqual(prev.occurredAt.getTime());
    }
  });

  it("时间线条目包含完整字段", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(buildCreateParams({ tenantId: t.id }));

    const timeline = await buildIncidentTimeline(t.id, inc.id);
    expect(timeline.length).toBe(1);
    const entry = timeline[0];
    expect(entry).toBeDefined();
    expect(entry?.id).toBeDefined();
    expect(entry?.occurredAt).toBeInstanceOf(Date);
    expect(entry?.actionType).toBe("security.incident");
    expect(entry?.actorType).toBe("user");
    expect(entry?.actorId).toBe("secops-001");
    expect(entry?.reason).toBeTruthy();
  });

  it("事故不存在返回空时间线（不抛错）", async () => {
    const t = await ensureDefaultTenant();
    const timeline = await buildIncidentTimeline(t.id, "non-existent");
    expect(timeline).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 9. getActiveIncidentByTarget
// ═══════════════════════════════════════════════════════════

describe("getActiveIncidentByTarget", () => {
  it("查询非终态事故（open）", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        targetType: "credential",
        targetId: "cred-active-001",
        incidentKey: "INC-ACTIVE-1",
      }),
    );

    const active = await getActiveIncidentByTarget(t.id, "credential", "cred-active-001");
    expect(active).not.toBeNull();
    expect(active?.id).toBe(inc.id);
    expect(active?.incidentState).toBe("open");
  });

  it("查询非终态事故（investigating/contained）", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        targetType: "agent",
        targetId: "agent-active-001",
        incidentKey: "INC-ACTIVE-2",
      }),
    );
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });

    const active = await getActiveIncidentByTarget(t.id, "agent", "agent-active-001");
    expect(active).not.toBeNull();
    expect(active?.incidentState).toBe("investigating");
  });

  it("终态事故（resolved）不被返回", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        targetType: "credential",
        targetId: "cred-resolved-001",
        incidentKey: "INC-ACTIVE-3",
      }),
    );
    await startInvestigation({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });
    await applyAllContainments(t.id, inc.id);
    await containIncident({ tenantId: t.id, id: inc.id, actor: buildActor(t.id) });
    await resolveIncident({
      tenantId: t.id,
      id: inc.id,
      actor: buildActor(t.id),
      closedBy: "secops-001",
    });

    const active = await getActiveIncidentByTarget(t.id, "credential", "cred-resolved-001");
    expect(active).toBeNull();
  });

  it("终态事故（escalated）不被返回", async () => {
    const t = await ensureDefaultTenant();
    const inc = await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        targetType: "credential",
        targetId: "cred-escalated-001",
        incidentKey: "INC-ACTIVE-4",
      }),
    );
    await escalateIncident({
      tenantId: t.id,
      id: inc.id,
      actor: buildActor(t.id),
      closedBy: "secops-001",
    });

    const active = await getActiveIncidentByTarget(t.id, "credential", "cred-escalated-001");
    expect(active).toBeNull();
  });

  it("不存在的事故返回 null", async () => {
    const t = await ensureDefaultTenant();
    const active = await getActiveIncidentByTarget(t.id, "credential", "non-existent");
    expect(active).toBeNull();
  });

  it("跨租户隔离：getActiveIncidentByTarget", async () => {
    const t = await ensureDefaultTenant();
    await seedExtraTenant(EXTRA_TENANT_ID, "extra");
    await createSecurityIncident(
      buildCreateParams({
        tenantId: t.id,
        targetType: "credential",
        targetId: "cred-iso-001",
        incidentKey: "INC-ISO-ACTIVE",
      }),
    );

    const active = await getActiveIncidentByTarget(EXTRA_TENANT_ID, "credential", "cred-iso-001");
    expect(active).toBeNull();
  });
});
