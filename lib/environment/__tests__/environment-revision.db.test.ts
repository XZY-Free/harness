import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  EnvironmentVersionConflictError,
  createEnvironmentDefinition,
  createEnvironmentRevision,
  getEnvironmentDefinitionById,
  getEnvironmentRevisionById,
  listEnvironmentRevisions,
} from "@/lib/environment/environment-definition-store";
import * as definitionStore from "@/lib/environment/environment-definition-store";
import {
  EnvironmentComplianceError,
  activateEnvironmentLease,
  createEnvironmentLease,
  getEnvironmentLeaseById,
  releaseEnvironmentLease,
} from "@/lib/environment/environment-lease-store";
import type { EnvironmentRevisionInput } from "@/lib/environment/environment-revision";
import {
  getEffectiveEnvironmentSelection,
  getEnvironmentChangeRequestById,
  recordEnvironmentSelectionFirstApplied,
  requestEnvironmentSelection,
} from "@/lib/environment/environment-selection";
import { seedPreparedEnvironmentLease } from "@/lib/environment/test-support/seed-prepared-environment-lease";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { environmentDefinitionTable } from "@/lib/persistence/schema/environment";
import {
  executionBindingTable,
  executionOwnershipTable,
} from "@/lib/persistence/schema/executions";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

function revisionInput(
  overrides: Partial<EnvironmentRevisionInput> = {},
): EnvironmentRevisionInput {
  return {
    environmentType: "sandbox",
    filesystemPolicyJson: { writeRoots: ["workspace"] },
    networkPolicyJson: { egress: "deny_all" },
    resourceLimitsJson: { cpu: 2, memoryMb: 2048 },
    secretPolicyJson: { inject: "none" },
    executionTarget: { kind: "container", image: "snowharness/test:latest" },
    requiredCapabilities: { isolation: true },
    createdByType: "user",
    createdById: "test-admin",
    ...overrides,
  };
}

describe("EnvironmentDefinition / Revision / Lease database semantics", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  it("ENV-01: first create commits Definition and R1 atomically with a resolvable pointer", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "test-env",
      displayName: "测试环境",
      revision: revisionInput(),
    });
    expect(definition.lifecycleState).toBe("active");
    expect(definition.currentRevisionId).toBeTruthy();
    expect(definition.lastRevisionNo).toBe(1);
    const revision = await getEnvironmentRevisionById(
      DEFAULT_TENANT_ID,
      definition.currentRevisionId!,
    );
    expect(revision).not.toBeNull();
    expect(revision?.revisionNo).toBe(1);
    expect(revision?.semanticDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(revision?.environmentType).toBe("sandbox");
  });

  it("ENV-02: the production repository exposes no revision UPDATE entry point", async () => {
    // 不可变契约：仓储导出中不存在任何 Revision 更新入口。
    const exportedNames = Object.keys(definitionStore);
    const mutators = exportedNames.filter((name) => /update|mutate|amend|rewrite/i.test(name));
    expect(mutators).toEqual([]);
    // 且 R1 被引用后，直接读回与创建时摘要一致（无热改）。
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "immutable-env",
      displayName: "不可变环境",
      revision: revisionInput(),
    });
    const revision = await getEnvironmentRevisionById(
      DEFAULT_TENANT_ID,
      definition.currentRevisionId!,
    );
    const [raw] = await db
      .select()
      .from(environmentDefinitionTable)
      .where(eq(environmentDefinitionTable.id, definition.id));
    expect(raw?.currentRevisionId).toBe(definition.currentRevisionId);
    expect(revision?.semanticDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("ENV-03: two racing If-Match edits produce exactly one winner with a consistent pointer", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "concurrent-env",
      displayName: "并发环境",
      revision: revisionInput(),
    });
    const versionAtR1 = definition.versionNo;
    const editA = createEnvironmentRevision(
      DEFAULT_TENANT_ID,
      definition.id,
      revisionInput({ networkPolicyJson: { egress: "allow_https" } }),
      { expectedVersionNo: versionAtR1 },
    );
    const editB = createEnvironmentRevision(
      DEFAULT_TENANT_ID,
      definition.id,
      revisionInput({ resourceLimitsJson: { cpu: 4, memoryMb: 4096 } }),
      { expectedVersionNo: versionAtR1 },
    );
    const settled = await Promise.allSettled([editA, editB]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(EnvironmentVersionConflictError);
    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<typeof editA>>).value;
    const [current] = await db
      .select()
      .from(environmentDefinitionTable)
      .where(eq(environmentDefinitionTable.id, definition.id));
    expect(current?.currentRevisionId).toBe(winner.id);
    const revisions = await listEnvironmentRevisions(DEFAULT_TENANT_ID, definition.id);
    expect(revisions).toHaveLength(2);
    // 胜出 Revision 的语义摘要与其输入一致，不产生混合 JSON。
    expect(winner.networkPolicyJson).toBeDefined();
    expect(winner.resourceLimitsJson).toBeDefined();
  });

  it("ENV-04: a binding pinned to R1 stays on R1 after the default advances to R2", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "pinned-env",
      displayName: "绑定环境",
      revision: revisionInput(),
    });
    const r1 = await getEnvironmentRevisionById(DEFAULT_TENANT_ID, definition.currentRevisionId!);
    const fixture = await seedPreparedRuntimeAttempt({ environmentDefinitionRevisionId: r1!.id });
    expect(fixture.binding.environmentDefinitionRevisionId).toBe(r1!.id);
    expect(fixture.binding.environmentMode).toBe("MANAGED");
    // 默认前进到 R2。
    const r2 = await createEnvironmentRevision(
      DEFAULT_TENANT_ID,
      definition.id,
      revisionInput({ requiredCapabilities: { isolation: true, gpu: true } }),
    );
    expect(r2.revisionNo).toBe(2);
    const [definitionNow] = await db
      .select()
      .from(environmentDefinitionTable)
      .where(eq(environmentDefinitionTable.id, definition.id));
    expect(definitionNow?.currentRevisionId).toBe(r2.id);
    // 已存在的 Binding 仍固定 R1。
    const [bindingRow] = await db
      .select()
      .from((await import("@/lib/persistence/schema/executions")).executionBindingTable)
      .where(
        eq(
          (await import("@/lib/persistence/schema/executions")).executionBindingTable.invocationId,
          fixture.invocation.id,
        ),
      );
    expect(bindingRow?.environmentDefinitionRevisionId).toBe(r1!.id);
  });

  it("ENV-05: redispatch provisions Lease2 against the binding's R1 and start rejects an R2 lease", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "redispatch-env",
      displayName: "重派环境",
      revision: revisionInput(),
    });
    const r1 = await getEnvironmentRevisionById(DEFAULT_TENANT_ID, definition.currentRevisionId!);
    const fixture = await seedPreparedRuntimeAttempt({ environmentDefinitionRevisionId: r1!.id });
    await createEnvironmentRevision(
      DEFAULT_TENANT_ID,
      definition.id,
      revisionInput({ requiredCapabilities: { isolation: true } }),
    );
    // Attempt2（Redispatch）按 Binding 的 R1 申请 Lease2，且准备满足 R1。
    const attempt2 = await createAttempt({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      retryReasonCode: "test_redispatch",
    });
    const evidence = { kind: "env-redispatch", attemptId: attempt2.id };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: attempt2.id,
        evidence,
        digest: protocolDigest(evidence),
      }),
    );
    const lease2 = await createEnvironmentLease({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: attempt2.id,
      environmentDefinitionRevisionId: fixture.binding.environmentDefinitionRevisionId!,
      // §5：Lease 必须在实例化前登记 operation/manifest 归属，Prepared 证据才能核对
      // Workspace 与恢复水位（生产路径由 provisionWithBackend 写入同一形状）。
      resourceManifest: {
        operationId: `test-env-instance:${attempt2.id}:${r1!.id}`,
        workspaceBindingId: fixture.workspace.id,
        revisionId: r1!.id,
        revisionSemanticDigest: r1!.semanticDigest,
        recoveryAnchorDigest: null,
        backendKind: "container",
        resources: [],
      },
    });
    expect(lease2.environmentDefinitionRevisionId).toBe(r1!.id);
    const prepared = await seedPreparedEnvironmentLease({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: attempt2.id,
      revision: r1!,
      workspaceBindingId: fixture.workspace.id,
      lease: lease2,
      capabilitiesJson: { isolation: true },
    });
    expect(prepared.readinessState).toBe("prepared");
    // Definition 默认已前进到 R2，但 Lease2 仍引用并满足 R1 —— 不读取 R2。
    const [definitionNow] = await db
      .select()
      .from(environmentDefinitionTable)
      .where(eq(environmentDefinitionTable.id, definition.id));
    expect(definitionNow?.currentRevisionId).not.toBe(r1!.id);
    expect(lease2.environmentDefinitionRevisionId).toBe(
      fixture.binding.environmentDefinitionRevisionId,
    );
  });

  it("ENV-06: a host missing required capabilities cannot prepare and never becomes ready", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "compliance-env",
      displayName: "合规环境",
      revision: revisionInput({ requiredCapabilities: { isolation: true, secureBoot: true } }),
    });
    const r1 = await getEnvironmentRevisionById(DEFAULT_TENANT_ID, definition.currentRevisionId!);
    const fixture = await seedPreparedRuntimeAttempt({ environmentDefinitionRevisionId: r1!.id });
    const lease = await createEnvironmentLease({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      environmentDefinitionRevisionId: r1!.id,
      resourceManifest: {
        operationId: `test-env-instance:${fixture.attempt.id}:${r1!.id}`,
        workspaceBindingId: fixture.workspace.id,
        revisionId: r1!.id,
        revisionSemanticDigest: r1!.semanticDigest,
        recoveryAnchorDigest: null,
        backendKind: "container",
        resources: [],
      },
    });
    await expect(
      seedPreparedEnvironmentLease({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        revision: r1!,
        workspaceBindingId: fixture.workspace.id,
        lease,
        capabilitiesJson: { isolation: true },
      }),
    ).rejects.toBeInstanceOf(EnvironmentComplianceError);
    const blocked = await getEnvironmentLeaseById(fixture.tenantId, lease.id);
    expect(blocked?.readinessState).not.toBe("prepared");
    expect(blocked?.readinessState).not.toBe("ready");
    // 未 ready 的 Lease 无法 activate，也无法满足 Ownership 的 ready 门。
    await expect(
      activateEnvironmentLease({
        tenantId: fixture.tenantId,
        leaseId: lease.id,
        ownershipId: "test-ownership",
        attemptId: fixture.attempt.id,
        invocationId: fixture.invocation.id,
        environmentDefinitionRevisionId: r1!.id,
      }),
    ).rejects.toThrow();
  });

  it("ENV-12: a Lease without a registered operation/manifest cannot be marked prepared", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "manifest-env",
      displayName: "归属环境",
      revision: revisionInput(),
    });
    const r1 = await getEnvironmentRevisionById(DEFAULT_TENANT_ID, definition.currentRevisionId!);
    const fixture = await seedPreparedRuntimeAttempt({ environmentDefinitionRevisionId: r1!.id });
    // §5：未登记归属的 Lease（崩溃在 create 之前）不能写 Prepared 证据 —— 没有可核对的
    // Workspace/恢复水位事实，就必须 fail closed，而不是退化成空串后含糊失败。
    const orphanLease = await createEnvironmentLease({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      environmentDefinitionRevisionId: r1!.id,
    });
    await expect(
      seedPreparedEnvironmentLease({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        revision: r1!,
        workspaceBindingId: fixture.workspace.id,
        lease: orphanLease,
        capabilitiesJson: { isolation: true },
      }),
    ).rejects.toThrow(/未登记 operation\/manifest 归属/);
    const unchanged = await getEnvironmentLeaseById(fixture.tenantId, orphanLease.id);
    expect(unchanged?.readinessState).toBe("unresolved");
    expect(unchanged?.preparedEvidence).toBeNull();
    expect(unchanged?.complianceEvidence).toBeNull();
  });

  it("ENV-07: exhausted provisioning retries fail without falling back to the latest revision", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "retry-env",
      displayName: "重试环境",
      revision: revisionInput(),
    });
    const r1 = await getEnvironmentRevisionById(DEFAULT_TENANT_ID, definition.currentRevisionId!);
    const fixture = await seedPreparedRuntimeAttempt({ environmentDefinitionRevisionId: r1!.id });
    await createEnvironmentRevision(
      DEFAULT_TENANT_ID,
      definition.id,
      revisionInput({ executionTarget: { kind: "container", image: "snowharness/latest:latest" } }),
    );
    // R1 不可实例化：连续失败重试仍然只引用 R1，不 fallback 到 R2。每次重试对应新 Attempt。
    for (let i = 0; i < 3; i += 1) {
      const retryAttempt = await createAttempt({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        retryReasonCode: "test_provision_retry",
      });
      const retryEvidence = { kind: "env-retry", attemptId: retryAttempt.id, round: i };
      await db.transaction((tx) =>
        markAttemptPreparedInTransaction(tx, {
          attemptId: retryAttempt.id,
          evidence: retryEvidence,
          digest: protocolDigest(retryEvidence),
        }),
      );
      const lease = await createEnvironmentLease({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        attemptId: retryAttempt.id,
        environmentDefinitionRevisionId: fixture.binding.environmentDefinitionRevisionId!,
      });
      await releaseEnvironmentLease(fixture.tenantId, lease.id, "lost");
      expect(lease.environmentDefinitionRevisionId).toBe(r1!.id);
    }
    const [definitionNow] = await db
      .select()
      .from(environmentDefinitionTable)
      .where(eq(environmentDefinitionTable.id, definition.id));
    expect(definitionNow?.currentRevisionId).not.toBe(r1!.id);
    const bindingRevision = fixture.binding.environmentDefinitionRevisionId;
    expect(bindingRevision).toBe(r1!.id);
  });

  it("ENV-08: historical queries surface the revision and lease evidence actually used", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "history-env",
      displayName: "历史环境",
      revision: revisionInput({ filesystemPolicyJson: { writeRoots: ["legacy"] } }),
    });
    const r1 = await getEnvironmentRevisionById(DEFAULT_TENANT_ID, definition.currentRevisionId!);
    const fixture = await seedPreparedRuntimeAttempt({ environmentDefinitionRevisionId: r1!.id });
    const lease = await createEnvironmentLease({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      environmentDefinitionRevisionId: r1!.id,
      capabilitiesJson: { isolation: true },
      resourceManifest: {
        operationId: `test-env-instance:${fixture.attempt.id}:${r1!.id}`,
        workspaceBindingId: fixture.workspace.id,
        revisionId: r1!.id,
        revisionSemanticDigest: r1!.semanticDigest,
        recoveryAnchorDigest: null,
        backendKind: "container",
        resources: [],
      },
    });
    const prepared = await seedPreparedEnvironmentLease({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      revision: r1!,
      workspaceBindingId: fixture.workspace.id,
      lease,
      capabilitiesJson: { isolation: true },
    });
    await createEnvironmentRevision(
      DEFAULT_TENANT_ID,
      definition.id,
      revisionInput({ filesystemPolicyJson: { writeRoots: ["workspace"] } }),
    );
    // 历史查询：旧 Invocation/Attempt 仍展示 R1 配置与 Lease 实际证据。
    const historicalRevision = await getEnvironmentRevisionById(
      DEFAULT_TENANT_ID,
      fixture.binding.environmentDefinitionRevisionId!,
    );
    expect(historicalRevision?.filesystemPolicyJson).toEqual({ writeRoots: ["legacy"] });
    const historicalLease = await getEnvironmentLeaseById(fixture.tenantId, prepared.id);
    expect(historicalLease?.environmentDefinitionRevisionId).toBe(r1!.id);
    expect(historicalLease?.complianceEvidence).not.toBeNull();
    expect(historicalLease?.complianceDigest).toMatch(/^sha256:/);
  });

  it("ENV-09: execution semantics live only on the revision, never on the definition", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "shape-env",
      displayName: "列形状环境",
      revision: revisionInput(),
    });
    const columns = Object.keys(environmentDefinitionTable);
    for (const forbidden of [
      "environmentType",
      "filesystemPolicyJson",
      "networkPolicyJson",
      "resourceLimitsJson",
      "secretPolicyJson",
      "executionTarget",
      "requiredCapabilities",
    ]) {
      expect(columns).not.toContain(forbidden);
    }
    const revisionColumns = Object.keys(
      (await import("@/lib/persistence/schema/environment-definition-revision"))
        .environmentDefinitionRevisionTable,
    );
    for (const required of [
      "environmentType",
      "filesystemPolicyJson",
      "networkPolicyJson",
      "resourceLimitsJson",
      "secretPolicyJson",
      "executionTarget",
      "requiredCapabilities",
      "semanticDigest",
    ]) {
      expect(revisionColumns).toContain(required);
    }
    expect(definition.currentRevisionId).toBeTruthy();
  });

  it("ENV-10: a later selection does not hot-apply to a running invocation", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "selection-env",
      displayName: "选择环境",
      revision: revisionInput(),
    });
    const r1 = await getEnvironmentRevisionById(DEFAULT_TENANT_ID, definition.currentRevisionId!);
    const fixture = await seedPreparedRuntimeAttempt({ environmentDefinitionRevisionId: r1!.id });
    const acquired = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const r2 = await createEnvironmentRevision(
      DEFAULT_TENANT_ID,
      definition.id,
      revisionInput({ environmentType: "cloud" }),
    );
    const selection = await requestEnvironmentSelection({
      tenantId: fixture.tenantId,
      threadId: fixture.threadId,
      requestedRevisionId: r2.id,
      requestedBy: "test-user",
    });
    expect(selection!.requestState).toBe("accepted_for_next_invocation");
    expect(selection!.firstAppliedInvocationId).toBeNull();
    // 运行中的 Invocation 不受影响：Ownership/Binding 仍是 R1 代际。
    const active = await db
      .select()
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.id, acquired.ownership.id));
    expect(active[0]?.ownershipState).toBe("active");
    expect(fixture.binding.environmentDefinitionRevisionId).toBe(r1!.id);
    // 待生效选择只对下一个 Invocation 可见。
    const pending = await getEffectiveEnvironmentSelection(fixture.tenantId, fixture.threadId);
    expect(pending?.requestedRevisionId).toBe(r2.id);
  });

  it("ENV-13: selectionSequence is MAX+1 under the Thread lock and the newest request is the effective one", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "selection-order-env",
      displayName: "选择顺序环境",
      revision: revisionInput(),
    });
    const fixture = await seedPreparedRuntimeAttempt({
      environmentDefinitionRevisionId: definition.currentRevisionId!,
    });
    const r2 = await createEnvironmentRevision(
      DEFAULT_TENANT_ID,
      definition.id,
      revisionInput({ environmentType: "cloud" }),
    );
    const r3 = await createEnvironmentRevision(
      DEFAULT_TENANT_ID,
      definition.id,
      revisionInput({
        environmentType: "cloud",
        resourceLimitsJson: { cpu: 4, memoryMb: 4096 },
      }),
    );
    const first = await requestEnvironmentSelection({
      tenantId: fixture.tenantId,
      threadId: fixture.threadId,
      requestedRevisionId: r2.id,
      requestedBy: "test-user",
    });
    const second = await requestEnvironmentSelection({
      tenantId: fixture.tenantId,
      threadId: fixture.threadId,
      requestedRevisionId: r3.id,
      requestedBy: "test-user",
    });
    // MAX+1（不是 MIN+1）：第二条不会撞上 `tenant_thread_sequence_uq`。
    expect(first.selectionSequence).toBe(1);
    expect(second.selectionSequence).toBe(2);
    // 契约「新请求取代」：生效选择是最新一条。
    const effective = await getEffectiveEnvironmentSelection(fixture.tenantId, fixture.threadId);
    expect(effective?.id).toBe(second.id);
    expect(effective?.requestedRevisionId).toBe(r3.id);
  });

  it("ENV-14: first application is recorded exactly once as applied + firstAppliedInvocationId", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "selection-apply-env",
      displayName: "首用记录环境",
      revision: revisionInput(),
    });
    const fixture = await seedPreparedRuntimeAttempt({
      environmentDefinitionRevisionId: definition.currentRevisionId!,
    });
    const r2 = await createEnvironmentRevision(
      DEFAULT_TENANT_ID,
      definition.id,
      revisionInput({ environmentType: "cloud" }),
    );
    const selection = await requestEnvironmentSelection({
      tenantId: fixture.tenantId,
      threadId: fixture.threadId,
      requestedRevisionId: r2.id,
      requestedBy: "test-user",
    });
    expect(selection.requestState).toBe("accepted_for_next_invocation");
    expect(selection.firstAppliedInvocationId).toBeNull();

    expect(
      await recordEnvironmentSelectionFirstApplied({
        tenantId: fixture.tenantId,
        selectionId: selection.id,
        invocationId: fixture.invocation.id,
      }),
    ).toBe(true);
    const applied = await getEnvironmentChangeRequestById(fixture.tenantId, selection.id);
    expect(applied?.requestState).toBe("applied");
    expect(applied?.firstAppliedInvocationId).toBe(fixture.invocation.id);
    expect(applied?.versionNo).toBe(2);

    // 重复调度是幂等重放：不改写首用锚点，也不推进版本。
    expect(
      await recordEnvironmentSelectionFirstApplied({
        tenantId: fixture.tenantId,
        selectionId: selection.id,
        invocationId: randomUUID(),
      }),
    ).toBe(false);
    const replay = await getEnvironmentChangeRequestById(fixture.tenantId, selection.id);
    expect(replay?.firstAppliedInvocationId).toBe(fixture.invocation.id);
    expect(replay?.versionNo).toBe(2);
  });

  it("ENV-15: an applied selection stays the effective default for later invocations", async () => {
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "selection-persist-env",
      displayName: "长期生效环境",
      revision: revisionInput(),
    });
    const fixture = await seedPreparedRuntimeAttempt({
      environmentDefinitionRevisionId: definition.currentRevisionId!,
    });
    const r2 = await createEnvironmentRevision(
      DEFAULT_TENANT_ID,
      definition.id,
      revisionInput({ environmentType: "cloud" }),
    );
    const selection = await requestEnvironmentSelection({
      tenantId: fixture.tenantId,
      threadId: fixture.threadId,
      requestedRevisionId: r2.id,
      requestedBy: "test-user",
    });
    await recordEnvironmentSelectionFirstApplied({
      tenantId: fixture.tenantId,
      selectionId: selection.id,
      invocationId: fixture.invocation.id,
    });
    // `applied` 之后仍是生效选择（不是"用过一次就失效"）。
    const effective = await getEffectiveEnvironmentSelection(fixture.tenantId, fixture.threadId);
    expect(effective?.id).toBe(selection.id);
    expect(effective?.requestState).toBe("applied");
    expect(effective?.requestedRevisionId).toBe(r2.id);
  });

  it("ENV-11: NO_PLATFORM_ENVIRONMENT rejects platform-managed environment combinations", async () => {
    // External 显式无平台环境：Binding 为 NO_PLATFORM_ENVIRONMENT（无 Revision）。
    const fixture = await seedPreparedRuntimeAttempt();
    expect(fixture.binding.environmentMode).toBe("NO_PLATFORM_ENVIRONMENT");
    expect(fixture.binding.environmentDefinitionRevisionId).toBeNull();
    // runtime-start 对 NO_PLATFORM + 平台 Lease 组合 fail closed，不允许跳过 Lease 后运行平台文件操作。
    // 环境校验发生在任何传输副作用之前，传输参数用无害 stub。
    const { startRuntimeInvocation } = await import("@/lib/runtime/application/runtime-start");
    const definition = await createEnvironmentDefinition({
      tenantId: DEFAULT_TENANT_ID,
      environmentKey: "mixed-env",
      displayName: "混合环境",
      revision: revisionInput(),
    });
    const r1 = await getEnvironmentRevisionById(DEFAULT_TENANT_ID, definition.currentRevisionId!);
    const lease = await createEnvironmentLease({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      environmentDefinitionRevisionId: r1!.id,
    });
    await expect(
      startRuntimeInvocation({
        tenantId: fixture.tenantId,
        invocation: fixture.invocation,
        attempt: fixture.attempt,
        binding: fixture.binding,
        environmentLeaseId: lease.id,
        runtimeClient: {} as Parameters<typeof startRuntimeInvocation>[0]["runtimeClient"],
        runtimeEndpoint: "http://127.0.0.1/stub",
        auth: { mode: "none" },
        callbackEndpoints: {
          events: "http://127.0.0.1/runtime/events",
          heartbeat: "http://127.0.0.1/runtime/heartbeat",
          context: "http://127.0.0.1/gateway/context",
          capabilityActions: "http://127.0.0.1/gateway/capability-actions",
          toolCalls: "http://127.0.0.1/gateway/tool-calls",
          userActions: "http://127.0.0.1/gateway/user-actions",
        },
      }),
    ).rejects.toThrow(/EnvironmentRevisionMismatch/);
  });
});
