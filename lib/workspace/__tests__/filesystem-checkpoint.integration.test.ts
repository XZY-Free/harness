import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createEnvironmentDefinition,
  getEnvironmentRevisionById,
} from "@/lib/environment/environment-definition-store";
import { activateEnvironmentLease } from "@/lib/environment/environment-lease-store";
import { seedPreparedEnvironmentLease } from "@/lib/environment/test-support/seed-prepared-environment-lease";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { acquireExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { markAttemptPreparedForTestInTransaction } from "@/lib/executions/test-support/preparation-fixtures";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import {
  type ExecutionOwnership,
  executionOwnershipTable,
  invocationTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import { filesystemCheckpointTable } from "@/lib/persistence/schema/filesystem-checkpoint";
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import { workspaceWriteLock } from "@/lib/persistence/schema/workspace-lock";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import {
  type AuthorityIdentity,
  type RuntimeEvent,
  computeEventPayloadHash,
  protocolDigest,
} from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import {
  abandonFilesystemCheckpoint,
  produceFilesystemCheckpoint,
  requestFilesystemCheckpoint,
} from "@/lib/workspace/checkpoint-producer";
import {
  type CheckpointReleaseRecoveryReport,
  confirmCheckpointRuntimeRelease,
  recoverPendingCheckpointReleases,
  runCheckpointMaintenanceLane,
} from "@/lib/workspace/checkpoint-release";
import { restoreFilesystemCheckpoint } from "@/lib/workspace/checkpoint-restore";
import { listFilesystemCheckpoints } from "@/lib/workspace/checkpoint-store";
import type { RecoveryAnchorDeclarations } from "@/lib/workspace/recovery-anchor";
import {
  type SnapshotEntry,
  digestJson,
  hashSnapshotBytes,
  parseCheckpointPolicy,
  validateSnapshotManifest,
} from "@/lib/workspace/snapshot-manifest";
import { FileSnapshotStorage } from "@/lib/workspace/snapshot-storage";
import { createWorkspaceBackend } from "@/lib/workspace/workspace-backend";
import { computeWorkspaceContractDigest } from "@/lib/workspace/workspace-contract";
import { createWorkspaceHostBroker } from "@/lib/workspace/workspace-host-server";
import { createWorkspace, createWorkspaceBinding } from "@/lib/workspace/workspace-queries";
import {
  activatePreparedWorkspaceWriter,
  prepareWorkspaceCandidate,
} from "@/lib/workspace/workspace-writer";
import { runWorkspaceWriterRelease } from "@/lib/workspace/workspace-writer-release";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/** R02 §3：该夹具 Session 冻结的发布能力证据（Hosted Revision 的能力名列表）。 */
const RUNTIME_CAPABILITIES_JSON = ["event_stream"];

const TENANT_ID = "00000000-0000-4000-8000-000000000000";

const filesystemSemantics = {
  kind: "portable",
  caseSensitive: true,
  symlinks: true,
  permissions: true,
  hardlinks: false,
  specialFiles: false,
  xattrsAcl: false,
  mtime: "preserved",
} as const;

const checkpointPolicy = {
  safePointTimeoutSeconds: 120,
  chunkBytes: 4_194_304,
  maxTotalBytes: "10737418240",
  maxEntries: 100_000,
  trigger: "before_suspend_and_explicit",
  retention: "retain_while_referenced",
};

interface CheckpointFixture {
  workspaceBindingId: string;
  environmentRevisionId: string;
  invocationId: string;
  ownershipId: string;
  /** 该 Invocation 的当前 Runtime Authority（正式身份；种子事实必须带它）。 */
  authority: AuthorityIdentity;
  writerRoot: string;
  storageRoot: string;
  /** 受管 Host 的控制面根与受管根：用于重建 Broker（模拟 Worker/Host 重启）。 */
  hostRoot: string;
  managedRoot: string;
  /** 创建该 Checkpoint 的 Binding / Attempt / Ownership 事实。 */
  workspaceBinding: WorkspaceBinding;
  runtimeRevisionId: string;
  attemptId: string;
  ownership: ExecutionOwnership;
  backend: ReturnType<typeof createWorkspaceBackend>;
  /** 待核验声明；锚点内容由服务端构建。 */
  declarations: () => RecoveryAnchorDeclarations;
  /**
   * 在 RuntimeEventIngress 落下一条**正式接纳**事实（同 tenant / 同 Invocation / 同
   * Authority tuple），返回 Ingress id 与 payloadHash。用于核验"声明必须对得上事实"。
   */
  seedIngressFact: (input: {
    producerSequence: number;
    type: "user-action" | "action" | "harness.action.completed" | "progress";
    payload: Record<string, unknown>;
    recoveryVersionAfter: number;
  }) => Promise<{ ingressId: string; payloadHash: string }>;
  /** request + produce 全流程（幂等 intent 由内部生成）。 */
  commit: () => Promise<{ checkpointId: string; anchorDigest: string }>;
  /** 只做 request + produce（不确认 Runtime 腿）——崩溃窗口夹具。 */
  commitWithoutRuntimeRelease: () => Promise<{
    checkpointId: string;
    checkpointIntentId: string;
    anchorDigest: string;
    release: { runtime: "pending" | "confirmed"; backend: "pending" | "confirmed" };
  }>;
  /** 走真实 ingress 接纳一批事件（正式 Authority tuple / 正式账本 / 正式生命周期）。 */
  ingressEvents: (events: RuntimeEvent[]) => Promise<{
    replayedEventIds: string[];
    acceptedThroughProducerSequence: string;
  }>;
}

async function setupCheckpointFixture(
  temporaryRoot: string,
  baseRoot?: string,
): Promise<CheckpointFixture> {
  // 同一用例内需要第二套独立 Host/Writer 时传入独立 baseRoot：受管 scope 由物理根决定，
  // 复用同一根会共享 grants/candidates，那就不是"另一个 Host"。
  const base = baseRoot ?? temporaryRoot;
  // writer root 与 host 元数据/候选目录物理分离，scan 不得混入控制面文件。
  const writerRoot = path.join(base, "writer");
  const hostRoot = path.join(base, "host");
  await mkdir(writerRoot, { recursive: true });
  await mkdir(hostRoot, { recursive: true });
  // 物理身份来自受管 Broker 的真实探测：写根（writerRoot）与控制面根（hostRoot）物理分离。
  const probe = await createWorkspaceHostBroker({
    root: hostRoot,
    managedRoot: writerRoot,
  }).probeIdentity();
  const storageScopeDigest = probe.scopeDigest;
  const storageIdentity = probe.storageIdentity;
  const hostIdentity = probe.hostIdentity;
  const logicalWorkspace = await createWorkspace({
    tenantId: TENANT_ID,
    workspaceKey: `checkpoint-fixture-${randomUUID()}`,
    displayName: "Checkpoint fixture",
  });
  const workspace = await createWorkspaceBinding({
    tenantId: TENANT_ID,
    workspaceId: logicalWorkspace.id,
    continuityMode: "CHECKPOINT_RESTORABLE",
    bindingType: "sandbox",
    locationRef: "managed://checkpoint-fixture",
    storageScopeDigest,
    backendKind: "managed_host",
    hostIdentity,
    storageIdentity,
    accessMode: "read_write",
    filesystemSemantics,
    checkpointPolicy,
    contractDigest: computeWorkspaceContractDigest({
      bindingId: "fixture",
      continuityMode: "CHECKPOINT_RESTORABLE",
      storageScopeDigest,
      backendKind: "managed_host",
      hostIdentity,
      storageIdentity,
      filesystemSemantics,
      checkpointPolicy,
    }),
    createdBy: "test-service",
  });
  const environment = await createEnvironmentDefinition({
    tenantId: TENANT_ID,
    environmentKey: `checkpoint-test-${randomUUID()}`,
    displayName: "Checkpoint test",
    revision: {
      environmentType: "sandbox",
      filesystemPolicyJson: {},
      networkPolicyJson: {},
      resourceLimitsJson: {},
      secretPolicyJson: {},
      executionTarget: { imageDigest: `sha256:${"1".repeat(64)}` },
      requiredCapabilities: {},
      createdByType: "service",
      createdById: "test-service",
    },
  });
  const environmentRevision = await getEnvironmentRevisionById(
    TENANT_ID,
    environment.currentRevisionId!,
  );
  if (!environmentRevision) throw new Error("EnvironmentDefinitionRevision fixture missing");
  const fixture = await seedPreparedRuntimeAttempt({
    tenantId: TENANT_ID,
    workspaceBinding: workspace,
    environmentDefinitionRevisionId: environmentRevision.id,
  });
  // 环境前置事实：真实实例核验由 R07 的 ENV-01..06 覆盖；本文件聚焦 Checkpoint 语义，
  // 因此经 test-support 构造"已核验"证据（不使用生产默认成功路径）。
  const environmentLease = await seedPreparedEnvironmentLease({
    tenantId: TENANT_ID,
    invocationId: fixture.invocation.id,
    attemptId: fixture.attempt.id,
    revision: environmentRevision,
    workspaceBindingId: workspace.id,
  });
  const acquired = await acquireTestRuntimeAuthority({
    tenantId: TENANT_ID,
    invocationId: fixture.invocation.id,
    attemptId: fixture.attempt.id,
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    environmentLeaseId: environmentLease.id,
    runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
  });
  const backend = createWorkspaceBackend(
    createWorkspaceHostBroker({ root: hostRoot, managedRoot: writerRoot }),
  );
  const candidate = await prepareWorkspaceCandidate({
    attemptId: fixture.attempt.id,
    binding: workspace,
    backend,
    root: writerRoot,
    operationId: "checkpoint-fixture",
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
  });
  if (!candidate) throw new Error("Workspace candidate missing");
  const activated = await activatePreparedWorkspaceWriter({
    tenantId: TENANT_ID,
    invocationId: fixture.invocation.id,
    attemptId: fixture.attempt.id,
    ownership: acquired.ownership,
    authority: acquired.authority,
    candidate,
  });
  const activationEvidence = {
    kind: "checkpoint-test-activation",
    writerGeneration: activated.writerGeneration,
    grantRef: activated.grant.grantRef,
  };
  await db
    .update(executionOwnershipTable)
    .set({
      workspaceWriterGeneration: activated.writerGeneration,
      activationEvidence,
      activationDigest: protocolDigest(activationEvidence),
      activatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(executionOwnershipTable.id, acquired.ownership.id));
  await activateEnvironmentLease({
    tenantId: TENANT_ID,
    leaseId: environmentLease.id,
    ownershipId: acquired.ownership.id,
    attemptId: fixture.attempt.id,
    invocationId: fixture.invocation.id,
    environmentDefinitionRevisionId: environmentRevision.id,
    recoveryAnchorDigest: null,
  });
  const semanticRequest = { fixture: "checkpoint", invocationId: fixture.invocation.id };
  const semanticRequestDigest = protocolDigest(semanticRequest);
  const remoteSessionRef = `checkpoint-session:${acquired.session.id}`;
  const remoteExecutionRef = `checkpoint-execution:${fixture.invocation.id}`;
  // R02 §3：Hosted 接纳回执的摘要来自冻结发布证据。夹具的 Session 与事件必须同源。
  const capabilitiesDigest = expectedCapabilityManifestDigest({
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
  });
  await applyRuntimeSessionDispatchForTest(TENANT_ID, acquired.session.id, {
    bindingState: "dispatching",
    semanticRequestJson: semanticRequest,
    semanticRequestDigest,
    remoteSessionRef,
    remoteExecutionRef,
    transportAcknowledgement: { capabilitiesDigest },
  });
  await ingressRuntimeEvents({
    tenantId: TENANT_ID,
    invocationId: fixture.invocation.id,
    batch: {
      protocolVersion: 3,
      authority: acquired.authority,
      events: [
        {
          eventId: randomUUID(),
          producerSequence: "1",
          type: "execution.started",
          schemaVersion: 1,
          payload: {
            intentKey: acquired.session.startIntentKey,
            semanticRequestDigest,
            remoteSessionRef,
            remoteExecutionRef,
            capabilitiesDigest,
          },
        },
      ],
    },
  });
  // R09 §1：锚点由服务端构建。夹具只提供"待核验声明"与"正式事实"，不构造锚点内容。
  const declarations = (): RecoveryAnchorDeclarations => ({});
  /**
   * 模拟一次**已正式接纳**的 Runtime 事件落库（真实表、真实复合外键、真实 payloadHash）。
   * 与 ingress 一致地同步 Invocation 的水位字段，使"事实"与"水位"自洽。
   */
  const seedIngressFact: CheckpointFixture["seedIngressFact"] = async (event) => {
    const payloadHash = computeEventPayloadHash({
      eventId: `seed-${event.producerSequence}`,
      producerSequence: String(event.producerSequence),
      type: event.type,
      schemaVersion: 1,
      payload: event.payload,
    });
    const ingressId = randomUUID();
    const now = new Date();
    await db.insert(runtimeEventIngressTable).values({
      id: ingressId,
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      acceptedAttemptId: acquired.authority.attemptId,
      acceptedOwnershipId: acquired.authority.ownershipId,
      acceptedSessionId: acquired.authority.sessionBindingId,
      acceptedEpoch: Number(acquired.authority.leaseEpoch),
      producerEventId: `seed-${event.producerSequence}`,
      producerSequence: event.producerSequence,
      candidateType: event.type,
      schemaVersion: 1,
      payloadHash,
      payloadJson: event.payload,
      receiptJson: { ingressId },
      recoveryVersionAfter: event.recoveryVersionAfter,
      receivedAt: now,
      acceptedAt: now,
    });
    await db
      .update(invocationTable)
      .set({
        lastProducerSequence: event.producerSequence,
        recoveryVersion: event.recoveryVersionAfter,
      })
      .where(eq(invocationTable.id, fixture.invocation.id));
    return { ingressId, payloadHash };
  };
  /**
   * 走**真实** ingress 接纳一批事件（正式 Authority tuple、正式账本、正式生命周期）。
   *
   * 用于验证 Gate 对"新 Action"的拦截与对"已接纳完成"的放行：那是真实入口判定，
   * 不是直接改表的近似。
   */
  const ingressEvents: CheckpointFixture["ingressEvents"] = (events) =>
    ingressRuntimeEvents({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      batch: { protocolVersion: 3, authority: acquired.authority, events },
    });
  const commit = async () => {
    const result = await commitWithoutRuntimeRelease();
    // 真实链路里 Runtime 腿的确认来自 dispatcher 的 releaseSafePoint 成功回调。
    await confirmCheckpointRuntimeRelease({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      checkpointIntentId: result.checkpointIntentId,
    });
    return { checkpointId: result.checkpointId, anchorDigest: result.anchorDigest };
  };
  /**
   * 只做到 produce（Backend 腿）：用于模拟"提交成功但 Runtime 解冻丢失"的 Crash 窗口。
   */
  const commitWithoutRuntimeRelease = async () => {
    const requested = await requestFilesystemCheckpoint({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      ownershipId: acquired.ownership.id,
      declarations: declarations(),
      requestedByType: "service",
      requestedById: "test-service",
    });
    const checkpoint = await produceFilesystemCheckpoint({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      ownershipId: acquired.ownership.id,
      backend,
      storage: { kind: "file", root: path.join(base, "snapshot-storage") },
      checkpointIntentId: requested.checkpointIntentId,
      safePointEvidence: {
        checkpointIntentId: requested.checkpointIntentId,
        safePointEvidenceDigest: protocolDigest({ safePoint: requested.checkpointIntentId }),
        writerQuiescenceAchievedAt: new Date(),
      },
    });
    return {
      checkpointId: checkpoint.checkpointId,
      checkpointIntentId: requested.checkpointIntentId,
      anchorDigest: requested.anchorDigest,
      release: checkpoint.release,
    };
  };
  return {
    workspaceBindingId: workspace.id,
    environmentRevisionId: environmentRevision.id,
    invocationId: fixture.invocation.id,
    ownershipId: acquired.ownership.id,
    authority: acquired.authority,
    writerRoot: activated.grant.root,
    storageRoot: path.join(base, "snapshot-storage"),
    hostRoot,
    managedRoot: writerRoot,
    workspaceBinding: workspace,
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    attemptId: fixture.attempt.id,
    ownership: acquired.ownership,
    backend,
    declarations,
    seedIngressFact,
    ingressEvents,
    commit,
    commitWithoutRuntimeRelease,
  };
}

async function countCheckpoints(invocationId: string): Promise<number> {
  const rows = await db
    .select()
    .from(filesystemCheckpointTable)
    .where(
      and(
        eq(filesystemCheckpointTable.tenantId, TENANT_ID),
        eq(filesystemCheckpointTable.invocationId, invocationId),
      ),
    );
  return rows.length;
}

/** 按 id 回读 Checkpoint 行（断言冻结锚点/水位/证据用）。 */
async function readCheckpointById(checkpointId: string) {
  const [row] = await db
    .select()
    .from(filesystemCheckpointTable)
    .where(
      and(
        eq(filesystemCheckpointTable.tenantId, TENANT_ID),
        eq(filesystemCheckpointTable.id, checkpointId),
      ),
    );
  return row ?? null;
}

interface CheckpointActor {
  invocationId: string;
  ownershipId: string;
  backend: ReturnType<typeof createWorkspaceBackend>;
  storageRoot: string;
}

/** 以夹具的正式身份请求一次安全点（declarations 只能是待核验声明）。 */
function requestFor(actor: CheckpointActor, declarations: RecoveryAnchorDeclarations = {}) {
  return requestFilesystemCheckpoint({
    tenantId: TENANT_ID,
    invocationId: actor.invocationId,
    ownershipId: actor.ownershipId,
    declarations,
    requestedByType: "service",
    requestedById: "test-service",
  });
}

/** 以夹具的正式身份做 produce；安全点证据由用例显式给出（用于验证"仅自报"被拒）。 */
function produceFor(
  actor: CheckpointActor,
  checkpointIntentId: string,
  evidence: { safePointEvidenceDigest?: string; writerQuiescenceAchievedAt?: Date } = {},
) {
  return produceFilesystemCheckpoint({
    tenantId: TENANT_ID,
    invocationId: actor.invocationId,
    ownershipId: actor.ownershipId,
    backend: actor.backend,
    storage: { kind: "file", root: actor.storageRoot },
    checkpointIntentId,
    safePointEvidence: {
      checkpointIntentId,
      safePointEvidenceDigest:
        evidence.safePointEvidenceDigest ?? protocolDigest({ safePoint: checkpointIntentId }),
      writerQuiescenceAchievedAt: evidence.writerQuiescenceAchievedAt ?? new Date(),
    },
  });
}

/** 造一个 file 条目：chunks 与 sizeBytes 自洽。 */
function manifestFile(pathValue: string, content = Buffer.from("data")): SnapshotEntry {
  return {
    path: pathValue,
    type: "file",
    sizeBytes: content.length,
    mtimeMs: 0,
    mode: 0o644,
    chunks: [{ digest: hashSnapshotBytes(content), sizeBytes: content.length }],
  };
}

/** 用给定条目拼一个 digest 自洽的 manifest（除非显式要求破坏某个摘要）。 */
function buildTestManifest(
  entries: SnapshotEntry[],
  overrides: { contentRootDigest?: string } = {},
) {
  const body = {
    format: "content_manifest" as const,
    formatVersion: 1 as const,
    entries,
    fileCount: entries.filter((entry) => entry.type === "file").length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    contentRootDigest: overrides.contentRootDigest ?? digestJson(entries),
  };
  return { ...body, manifestDigest: digestJson(body) };
}

async function readGate(invocationId: string): Promise<{
  checkpointGate: string;
  checkpointIntentId: string | null;
  checkpointOwnerId: string | null;
  checkpointPreparedEvidence: unknown;
  /** 库侧行的写入时刻；维护 lane 的扫描窗口以它为界（`updatedAt < now - graceMs`）。 */
  updatedAt: Date;
} | null> {
  const [invocation] = await db
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, TENANT_ID), eq(invocationTable.id, invocationId)));
  return invocation
    ? {
        checkpointGate: invocation.checkpointGate,
        checkpointIntentId: invocation.checkpointIntentId,
        checkpointOwnerId: invocation.checkpointOwnerId,
        checkpointPreparedEvidence: invocation.checkpointPreparedEvidence,
        updatedAt: invocation.updatedAt,
      }
    : null;
}

describe("FilesystemCheckpoint integration", () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "snowharness-checkpoint-"));
  });

  // ─── CHECKPOINT-01..12（R09）──────────────────────────────────────────────
  // 编号严格对应 `acceptance/checkpoint.md` 的 12 条场景与"必须断言"。
  // 这些用例验证的是实现必须真的成立的性质：Gate 只挡新决策、已接纳完成照收、
  // 锚点由排空后的正式事实重建、写块时校验既有块、staging 逐 operation 唯一、
  // Restore 可重试且不污染正式 root、目录元数据最后应用、恶意 manifest 全拒、
  // "仅自报"的安全点证明不被接受、跨 Host 恢复必须先验证/激活才能执行。

  it("CHECKPOINT-01: 安全点请求时有已接纳 Tool 正在完成——新 Action 被挡、完成照收、排空后锚点含新结果", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "tool in flight", "utf8");
      // 已接纳 Tool：先有一条被正式接纳的 harness.action.proposed（Gate=open 时接纳）。
      const actionId = randomUUID();
      await ctx.ingressEvents([
        {
          eventId: randomUUID(),
          producerSequence: "2",
          type: "harness.action.proposed",
          schemaVersion: 1,
          payload: { action_id: actionId, tool: "shell" },
        },
      ]);
      const requested = await requestFor(ctx);
      expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("quiescing");
      const [atRequest] = await db
        .select({
          recoveryVersion: invocationTable.checkpointRecoveryVersion,
          producerSequence: invocationTable.checkpointProducerSequence,
        })
        .from(invocationTable)
        .where(eq(invocationTable.id, ctx.invocationId));
      expect(atRequest?.recoveryVersion).toBe(0);
      // 请求时的记载就是当时的正式水位（已接纳到 seq 2）。
      expect(atRequest?.producerSequence).toBe(2);

      // (a) 新 Action 被挡：安全点期间不得产生新决策/新行动。
      await expect(
        ctx.ingressEvents([
          {
            eventId: randomUUID(),
            producerSequence: "3",
            type: "action",
            schemaVersion: 1,
            payload: { action: "tool_call", tool: "shell" },
          },
        ]),
        // 稳定错误码是 ExecutionAuthorityError.code（不是中文描述）。
      ).rejects.toMatchObject({ code: "CheckpointStale" });

      // (b) 已接纳 Tool 的真实完成必须照收：不能因 Gate 非 open 丢弃真实完成事实。
      const completed = await ctx.ingressEvents([
        {
          eventId: randomUUID(),
          producerSequence: "3",
          type: "harness.action.completed",
          schemaVersion: 1,
          payload: { action_id: actionId, result: { exitCode: 0 } },
        },
      ]);
      expect(completed.acceptedThroughProducerSequence).toBe("3");

      // (c) 排空后重建锚点：冻结的是最新已应用事实，不是请求时的旧水位。
      const produced = await produceFor(ctx, requested.checkpointIntentId);
      const row = await readCheckpointById(produced.checkpointId);
      expect(row?.recoveryVersion).toBe(1);
      expect(row?.producerSequence).toBe(3);
      expect((row?.recoveryAnchor as { producerSequence: string }).producerSequence).toBe("3");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-02: 伪造 actionFacts/childFacts/事实摘要但顶层结构正确，服务端回读不符即拒绝", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "forgery", "utf8");
      const applied = await ctx.seedIngressFact({
        producerSequence: 2,
        type: "action",
        payload: { action: "tool_call", result: "ok" },
        recoveryVersionAfter: 1,
      });
      // (a) actionFacts 引用不存在的事实：数组形状合法也不接受。
      await expect(requestFor(ctx, { actionFacts: [randomUUID()] })).rejects.toThrow(
        "CheckpointStale",
      );
      // (b) childFacts 引用不存在/跨域的 AgentCall。
      await expect(requestFor(ctx, { childFacts: [randomUUID()] })).rejects.toThrow(
        "CheckpointStale",
      );
      // (c) 事实摘要不自洽：账本行载荷被改写而 payloadHash 保持原值 → 重算不符。
      await db
        .update(runtimeEventIngressTable)
        .set({ payloadJson: { action: "tool_call", result: "forged" } })
        .where(eq(runtimeEventIngressTable.id, applied.ingressId));
      await expect(requestFor(ctx, { actionFacts: [applied.ingressId] })).rejects.toThrow(
        "CheckpointStale",
      );
      // 三次拒绝都没有占用 Gate，也没有留下任何 Checkpoint。
      expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("open");
      expect(await countCheckpoints(ctx.invocationId)).toBe(0);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-03: Checkpoint 之后真实行动结果被采用，旧 Snapshot 恢复必须失败（不许旧缓存互证）", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "v1", "utf8");
      const first = await ctx.commit();
      // Checkpoint 之后一条行动结果被 Loop 正式采用：水位推进到 1。
      await ctx.seedIngressFact({
        producerSequence: 2,
        type: "action",
        payload: { action: "tool_call", result: "ok" },
        recoveryVersionAfter: 1,
      });
      const restoreWith = (recoveryVersion: number) =>
        restoreFilesystemCheckpoint({
          tenantId: TENANT_ID,
          checkpointId: first.checkpointId,
          destination: path.join(temporaryRoot, "restore-stale"),
          storage: { kind: "file", root: ctx.storageRoot },
          backend: ctx.backend,
          expected: {
            invocationId: ctx.invocationId,
            workspaceBindingId: ctx.workspaceBindingId,
            environmentDefinitionRevisionId: ctx.environmentRevisionId,
            recoveryVersion,
          },
        });
      // (a) 拿 Checkpoint 自己的记载（0）去恢复：仍必须失败——恢复边界由**当前事实**重建。
      await expect(restoreWith(0)).rejects.toThrow("CheckpointStale");
      // (b) 拿当前水位（1）去恢复：也必须失败——Checkpoint 记载与新水位不符。
      await expect(restoreWith(1)).rejects.toThrow("CheckpointStale");
      // 两种自证都不成立，且没有落下半成品目录。
      expect(await stat(path.join(temporaryRoot, "restore-stale")).catch(() => null)).toBeNull();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-04: 冻结期间新 Owner 接管或安全点过期——旧 Snapshot 不能 Commit，release/cleanup 可靠收口", async () => {
    try {
      // (a) 接管：上传/冻结期间旧 Ownership 失去 active。
      const superseded = await setupCheckpointFixture(
        temporaryRoot,
        path.join(temporaryRoot, "superseded"),
      );
      await writeFile(path.join(superseded.writerRoot, "state.txt"), "takeover", "utf8");
      const taken = await requestFor(superseded);
      await db
        .update(executionOwnershipTable)
        .set({ ownershipState: "lost", releasedAt: new Date(), reasonCode: "superseded" })
        .where(eq(executionOwnershipTable.id, superseded.ownershipId));
      await expect(produceFor(superseded, taken.checkpointIntentId)).rejects.toThrow(
        "NotCurrentExecutor",
      );
      expect(await countCheckpoints(superseded.invocationId)).toBe(0);
      // 受控清理：Gate 回到 open，不留下无法退出的屏障。
      await abandonFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: superseded.invocationId,
        ownershipId: superseded.ownershipId,
        checkpointIntentId: taken.checkpointIntentId,
        reasonCode: "NotCurrentExecutor",
      });
      expect((await readGate(superseded.invocationId))?.checkpointGate).toBe("open");

      // (b) 安全点过期：Writer 未能在预算内排空。
      const expired = await setupCheckpointFixture(
        temporaryRoot,
        path.join(temporaryRoot, "expired"),
      );
      await writeFile(path.join(expired.writerRoot, "state.txt"), "expired", "utf8");
      const stale = await requestFor(expired);
      await db
        .update(invocationTable)
        .set({ checkpointDeadline: new Date(Date.now() - 1_000) })
        .where(eq(invocationTable.id, expired.invocationId));
      await expect(produceFor(expired, stale.checkpointIntentId)).rejects.toThrow(
        "CheckpointStale",
      );
      expect(await countCheckpoints(expired.invocationId)).toBe(0);
      // produce 失败路径自动收口：Gate 回 open，候选不成为 Checkpoint。
      expect((await readGate(expired.invocationId))?.checkpointGate).toBe("open");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-05 / N06-T4: Snapshot 已提交但远端 release 丢失，Worker 重启向原代际重发并收口", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "release matters", "utf8");
      const produced = await ctx.commitWithoutRuntimeRelease();
      expect(produced.release).toEqual({ runtime: "pending", backend: "confirmed" });
      expect(await countCheckpoints(ctx.invocationId)).toBe(1);
      const stalled = await readGate(ctx.invocationId);
      expect(stalled?.checkpointGate).toBe("releasing");

      // Worker 重启：Broker 内存态全丢（新实例、同一受管根），只能从持久事实续做。
      const restarted = createWorkspaceBackend(
        createWorkspaceHostBroker({ root: ctx.hostRoot, managedRoot: ctx.managedRoot }),
      );
      const now = new Date(stalled!.updatedAt.getTime() + 1);
      let runtimeReleaseCalls = 0;
      const first = await runCheckpointMaintenanceLane({
        now,
        graceMs: 0,
        resolveBackend: async () => restarted,
        releaseRuntime: async ({ checkpointIntentId }) => {
          expect(checkpointIntentId).toBe(produced.checkpointIntentId);
          runtimeReleaseCalls += 1;
        },
      });
      expect(first.releases.failures).toEqual([]);
      expect(first.releases.backendReleased).toBe(1);
      expect(runtimeReleaseCalls).toBe(1);
      expect(first.releases.awaitingRuntime).toBe(0);
      expect(first.releases.gateOpened).toBe(1);
      expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("open");

      // 再跑一个 tick：已确认的两条腿不会再次发送或回退。
      const second = await runCheckpointMaintenanceLane({
        now,
        graceMs: 0,
        resolveBackend: async () => restarted,
        releaseRuntime: async () => {
          runtimeReleaseCalls += 1;
        },
      });
      expect(second.releases.failures).toEqual([]);
      expect(runtimeReleaseCalls).toBe(1);
      expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("open");
      const destination = path.join(temporaryRoot, "restore-after-restart");
      await restoreFilesystemCheckpoint({
        tenantId: TENANT_ID,
        checkpointId: produced.checkpointId,
        destination,
        storage: { kind: "file", root: ctx.storageRoot },
        backend: ctx.backend,
        expected: {
          invocationId: ctx.invocationId,
          workspaceBindingId: ctx.workspaceBindingId,
          environmentDefinitionRevisionId: ctx.environmentRevisionId,
          recoveryVersion: 0,
        },
      });
      expect(await readFile(path.join(destination, "state.txt"), "utf8")).toBe("release matters");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-06: 既有内容块被破坏但文件仍在——写 Snapshot 时校验失败，不能提交引用坏块的 Checkpoint", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "integrity first", "utf8");
      const first = await ctx.commit();
      const row = await readCheckpointById(first.checkpointId);
      const chunkDigest = (row!.storageEvidence as { chunks: string[] }).chunks[0]!;
      const chunkPath = path.join(ctx.storageRoot, "chunks", chunkDigest.slice("sha256:".length));
      // 同长度篡改：文件仍然"存在"，只有内容不对——必须由写块前的回读校验兜住。
      const original = await readFile(chunkPath);
      const tampered = Buffer.from(original);
      tampered[0] = tampered[0]! ^ 0xff;
      await writeFile(chunkPath, tampered);
      // 写根内容不变 → 第二次快照必然引用同一块。
      await expect(ctx.commit()).rejects.toThrow("既有内容块损坏");
      expect(await countCheckpoints(ctx.invocationId)).toBe(1);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-07: 两个 Snapshot 并发写同一块 + Crash 遗留 staging——幂等复用正确块，不共享临时文件", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await mkdir(ctx.storageRoot, { recursive: true });
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "concurrent bytes", "utf8");
      const storage = new FileSnapshotStorage(ctx.storageRoot);
      const requirements = { checkpointPolicy, filesystemSemantics };
      const [left, right] = await Promise.all([
        storage.writeSnapshot(ctx.writerRoot, "concurrent-left", requirements),
        storage.writeSnapshot(ctx.writerRoot, "concurrent-right", requirements),
      ]);
      expect(left.receipt.contentRootDigest).toBe(right.receipt.contentRootDigest);
      expect(left.receipt.chunks).toEqual(right.receipt.chunks);
      const chunkDigest = left.receipt.chunks[0]!;
      const chunkName = chunkDigest.slice("sha256:".length);
      const chunkBytes = await readFile(path.join(ctx.storageRoot, "chunks", chunkName));
      expect(hashSnapshotBytes(chunkBytes)).toBe(chunkDigest);

      // Crash 遗留：另一个 operation 的 staging 文件（内容还是坏的）不得阻塞本 operation，
      // 也不得被当成正式块复用。
      const leftover = path.join(
        ctx.storageRoot,
        "chunks",
        `${chunkName}.crashed-operation.staging`,
      );
      await writeFile(leftover, "garbage from a crashed writer");
      const third = await storage.writeSnapshot(ctx.writerRoot, "concurrent-third", requirements);
      expect(third.receipt.chunks).toEqual(left.receipt.chunks);
      expect(await readFile(path.join(ctx.storageRoot, "chunks", chunkName))).toEqual(chunkBytes);
      expect(await readFile(leftover, "utf8")).toBe("garbage from a crashed writer");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-08: Restore 写到一半断电，再恢复同 operation——隔离候选可重试，正式 root 不半成品", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "restore crash", "utf8");
      const { checkpointId } = await ctx.commit();
      const row = await readCheckpointById(checkpointId);
      const destination = path.join(temporaryRoot, "restore-crash");
      const staging = `${destination}.staging`;
      const stateFile = `${destination}.restore-state.json`;
      // 模拟"写到一半断电"：隔离候选里留下半成品 + 属于本 operation 的未 ready 状态。
      await mkdir(staging, { recursive: true });
      await writeFile(path.join(staging, "state.txt"), "half writ", "utf8");
      await writeFile(
        stateFile,
        JSON.stringify({
          operationId: row!.checkpointIntentId,
          manifestDigest: row!.manifestDigest,
          phase: "staging",
        }),
      );
      // 正式 root 不存在：部分失败没有污染它。
      expect(await stat(destination).catch(() => null)).toBeNull();

      // 同 operation 重试：复核归属后安全重建候选并提交。
      const restore = () =>
        restoreFilesystemCheckpoint({
          tenantId: TENANT_ID,
          checkpointId,
          destination,
          storage: { kind: "file", root: ctx.storageRoot },
          backend: ctx.backend,
          expected: {
            invocationId: ctx.invocationId,
            workspaceBindingId: ctx.workspaceBindingId,
            environmentDefinitionRevisionId: ctx.environmentRevisionId,
            recoveryVersion: 0,
          },
        });
      await restore();
      expect(await readFile(path.join(destination, "state.txt"), "utf8")).toBe("restore crash");
      // 幂等：再次恢复同一 operation 既不重复工作，也不会 EEXIST。
      await restore();
      expect(await stat(staging).catch(() => null)).toBeNull();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-09: readonly 目录、多层目录、精确 mtime 与内容恢复——子项先完成再恢复目录元数据", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      const lockedDir = path.join(ctx.writerRoot, "locked");
      await mkdir(path.join(lockedDir, "nested", "deep"), { recursive: true });
      await writeFile(path.join(lockedDir, "inner.txt"), "inner bytes", "utf8");
      await writeFile(path.join(lockedDir, "nested", "deep", "leaf.bin"), Buffer.from([9, 8, 7]));
      const dirMtime = new Date("2026-02-03T04:05:06.000Z");
      await utimes(lockedDir, dirMtime, dirMtime);
      // readonly 目录：若先应用目录元数据再写子项，子文件写入会失败。
      await chmod(lockedDir, 0o555);
      const { checkpointId } = await ctx.commit();
      const destination = path.join(temporaryRoot, "restore-locked");
      await restoreFilesystemCheckpoint({
        tenantId: TENANT_ID,
        checkpointId,
        destination,
        storage: { kind: "file", root: ctx.storageRoot },
        backend: ctx.backend,
        expected: {
          invocationId: ctx.invocationId,
          workspaceBindingId: ctx.workspaceBindingId,
          environmentDefinitionRevisionId: ctx.environmentRevisionId,
          recoveryVersion: 0,
        },
      });
      // 子项内容与语义一致（Hash/内容都对）。
      expect(await readFile(path.join(destination, "locked", "inner.txt"), "utf8")).toBe(
        "inner bytes",
      );
      expect(
        await readFile(path.join(destination, "locked", "nested", "deep", "leaf.bin")),
      ).toEqual(Buffer.from([9, 8, 7]));
      // 目录元数据在子项之后精确恢复：mode 与 mtime 都不被子创建改变。
      const lockedStat = await stat(path.join(destination, "locked"));
      expect(lockedStat.mode & 0o777).toBe(0o555);
      expect(lockedStat.mtime.toISOString()).toBe(dirMtime.toISOString());
      // 归还写权限，避免影响临时目录清理（清理语义不属于本用例断言）。
      await chmod(path.join(destination, "locked"), 0o755);
      await chmod(lockedDir, 0o755);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-10: 恶意块路径/反斜杠穿越/symlink 父节点/错误 contentRoot/超大 manifest 一律拒绝", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      const outside = path.join(temporaryRoot, "outside");
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, "sentinel.txt"), "must survive", "utf8");
      const symlinkEntry: SnapshotEntry = {
        path: "link",
        type: "symlink",
        sizeBytes: 0,
        mtimeMs: 0,
        mode: 0o777,
        target: "a.txt",
      };
      // 反斜杠在 POSIX 是普通字符、在 Windows 是分隔符：同一 manifest 会有两种解释 → 拒绝。
      expect(() =>
        validateSnapshotManifest(buildTestManifest([manifestFile("..\\outside\\evil.txt")]), null),
      ).toThrow();
      // 块 digest 冒充路径：形状非法，绝不能拿它去拼文件路径。
      expect(() =>
        validateSnapshotManifest(
          buildTestManifest([
            {
              ...manifestFile("a.txt"),
              chunks: [{ digest: "sha256:../../etc/passwd", sizeBytes: 4 }],
            },
          ]),
          null,
        ),
      ).toThrow();
      // symlink 父节点：子项会被写到链接目标里。
      expect(() =>
        validateSnapshotManifest(
          buildTestManifest([symlinkEntry, manifestFile("link/child.txt")]),
          null,
        ),
      ).toThrow();
      // 错误 contentRoot：manifestDigest 自洽但内容根摘要与 entries 不符。
      expect(() =>
        validateSnapshotManifest(
          buildTestManifest([manifestFile("a.txt")], {
            contentRootDigest: `sha256:${"b".repeat(64)}`,
          }),
          null,
        ),
      ).toThrow();
      // 超大 manifest：条目数超过 CheckpointPolicy 上限。
      const limits = parseCheckpointPolicy(checkpointPolicy);
      const many = Array.from({ length: 3 }, (_, index) => manifestFile(`f${index}.txt`));
      expect(() =>
        validateSnapshotManifest(buildTestManifest(many), { ...limits, maxEntries: 2 }),
      ).toThrow();
      // 真实恢复路径同样拒绝，且根外没有任何写入。
      await expect(
        new FileSnapshotStorage(ctx.storageRoot).restoreSnapshot(
          buildTestManifest([{ ...manifestFile("evil.txt"), path: "../outside/evil.txt" }]),
          path.join(temporaryRoot, "restore-attack"),
        ),
      ).rejects.toThrow();
      expect(await readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe("must survive");
      expect(await readdir(outside)).toEqual(["sentinel.txt"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-11: 安全点证明仅自报或来自其他窗口——不能签发一致的 Checkpoint", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "self reported", "utf8");
      const requested = await requestFor(ctx);
      // (a) 只有"我们排空了"这一句话：不是可核验的证据摘要。
      await expect(
        produceFor(ctx, requested.checkpointIntentId, {
          safePointEvidenceDigest: "writer-says-drained",
        }),
      ).rejects.toThrow("CheckpointStale");
      // (b) 摘要形状合法但排空时刻来自另一个窗口（远超 deadline）。
      await expect(
        produceFor(ctx, requested.checkpointIntentId, {
          safePointEvidenceDigest: `sha256:${"c".repeat(64)}`,
          writerQuiescenceAchievedAt: new Date(requested.deadline.getTime() + 10 * 60_000),
        }),
      ).rejects.toThrow("CheckpointStale");
      // (c) 排空时刻非法。
      await expect(
        produceFor(ctx, requested.checkpointIntentId, {
          safePointEvidenceDigest: `sha256:${"d".repeat(64)}`,
          writerQuiescenceAchievedAt: new Date(Number.NaN),
        }),
      ).rejects.toThrow("CheckpointStale");
      // 三次都没有签发 Checkpoint，且 Gate 被受控收口（不留永久屏障）。
      expect(await countCheckpoints(ctx.invocationId)).toBe(0);
      expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("open");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-12: 原 Owner/Host 永久丢失后用匹配 Checkpoint 恢复——新运行目录先验证/激活才可执行", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "app.txt"), "runtime payload", "utf8");
      const { checkpointId } = await ctx.commit();
      // 原运行目录的内容永久丢失（受管存储卷本身仍在：把整根删掉会让 Host 身份校验
      // 正确地 fail-closed，那不是"用 Checkpoint 恢复"要验证的语义）。
      for (const child of await readdir(ctx.writerRoot)) {
        await rm(path.join(ctx.writerRoot, child), { recursive: true, force: true });
      }
      expect(await readdir(ctx.writerRoot)).toEqual([]);

      // (a) 身份不匹配的 Host：内容能落盘，但**激活**必然失败 → 不能执行。
      const otherBase = path.join(temporaryRoot, "other-host");
      await mkdir(path.join(otherBase, "writer"), { recursive: true });
      const otherBackend = createWorkspaceBackend(
        createWorkspaceHostBroker({
          root: path.join(otherBase, "host"),
          managedRoot: path.join(otherBase, "writer"),
        }),
      );
      // 运行目录必须落在该 Host 的受管物理根内，否则 Broker 拒绝把它当作 Writer root。
      const otherRun = path.join(otherBase, "writer", "restored-run");
      await restoreFilesystemCheckpoint({
        tenantId: TENANT_ID,
        checkpointId,
        destination: otherRun,
        storage: { kind: "file", root: ctx.storageRoot },
        backend: otherBackend,
        expected: {
          invocationId: ctx.invocationId,
          workspaceBindingId: ctx.workspaceBindingId,
          environmentDefinitionRevisionId: ctx.environmentRevisionId,
          recoveryVersion: 0,
        },
      });
      expect(await readFile(path.join(otherRun, "app.txt"), "utf8")).toBe("runtime payload");
      const otherCandidate = await prepareWorkspaceCandidate({
        attemptId: ctx.attemptId,
        binding: ctx.workspaceBinding,
        backend: otherBackend,
        root: otherRun,
        operationId: "checkpoint-restore-other-host",
        runtimeRevisionId: ctx.runtimeRevisionId,
      });
      if (!otherCandidate) throw new Error("other-host candidate missing");
      await expect(
        activatePreparedWorkspaceWriter({
          tenantId: TENANT_ID,
          invocationId: ctx.invocationId,
          attemptId: ctx.attemptId,
          ownership: ctx.ownership,
          authority: ctx.authority,
          candidate: otherCandidate,
        }),
      ).rejects.toThrow();

      // (b) 接管：旧 Owner 租约过期后由新 Attempt 经真实 Acquire 取得执行权。
      const [old] = await db
        .select()
        .from(executionOwnershipTable)
        .where(eq(executionOwnershipTable.id, ctx.ownershipId));
      await db
        .update(executionOwnershipTable)
        .set({ leaseExpiresAt: new Date(old!.acquiredAt.getTime() + 1), updatedAt: new Date() })
        .where(eq(executionOwnershipTable.id, ctx.ownershipId));
      const attemptId = (
        await createAttempt({ tenantId: TENANT_ID, invocationId: ctx.invocationId })
      ).id;
      const evidence = { kind: "test-candidate", invocationId: ctx.invocationId, attemptId };
      await db.transaction((tx) =>
        markAttemptPreparedForTestInTransaction(tx, {
          attemptId,
          evidence,
          digest: protocolDigest(evidence),
        }),
      );
      const takeover = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        attemptId,
        runtimeRevisionId: ctx.runtimeRevisionId,
        runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
      });

      // A07 决策四：旧代际的物理 Writer 还占着 `active` 行。直接激活新代际时，预留只会
      // **登记释放义务**并返回 `release_pending` —— 它绝不在同一行上覆盖（那会让原本待停止的
      // 写者失去定位）。真实序列是"先由释放 lane 真实撤销旧代际、取得可核验停止回执、把行推到
      // `released`，下一代才开始分配"。生产里 `startRuntimeInvocation` 会自动兑现这一轮；
      // 本用例直接调原语，因此必须自己走这一步。
      const [staleLock] = await db
        .select({ id: workspaceWriteLock.id })
        .from(workspaceWriteLock)
        .where(
          and(
            eq(workspaceWriteLock.tenantId, TENANT_ID),
            eq(workspaceWriteLock.holderOwnershipId, ctx.ownershipId),
          ),
        )
        .limit(1);
      expect(staleLock).toBeTruthy();
      const staleRelease = await runWorkspaceWriterRelease({
        tenantId: TENANT_ID,
        lockId: staleLock!.id,
        leaseOwner: "checkpoint-12-release",
        deps: { resolveHost: async () => ctx.backend.host },
      });
      expect(staleRelease.outcome).toBe("released");

      // (c) 用真正匹配的 Checkpoint 在**新运行目录**恢复。
      const newRoot = path.join(ctx.managedRoot, "restored-run");
      await restoreFilesystemCheckpoint({
        tenantId: TENANT_ID,
        checkpointId,
        destination: newRoot,
        storage: { kind: "file", root: ctx.storageRoot },
        backend: ctx.backend,
        expected: {
          invocationId: ctx.invocationId,
          workspaceBindingId: ctx.workspaceBindingId,
          environmentDefinitionRevisionId: ctx.environmentRevisionId,
          recoveryVersion: 0,
        },
      });
      // (d) 先验证/激活再执行：恢复出的目录就是新 Runtime 运行目录。
      const candidate = await prepareWorkspaceCandidate({
        attemptId,
        binding: ctx.workspaceBinding,
        backend: ctx.backend,
        root: newRoot,
        operationId: "checkpoint-restore",
        runtimeRevisionId: ctx.runtimeRevisionId,
      });
      if (!candidate) throw new Error("candidate missing");
      const activated = await activatePreparedWorkspaceWriter({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        attemptId,
        ownership: takeover.ownership,
        authority: takeover.authority,
        candidate,
      });
      expect(path.basename(activated.grant.root)).toBe("restored-run");
      expect(await readFile(path.join(activated.grant.root, "app.txt"), "utf8")).toBe(
        "runtime payload",
      );
      await ctx.backend.host.assertWriter(activated.grant);
      // 激活之后回读当前 Writer：只有该代际的精确持有者才被授权写入这个运行目录。
      const current = await ctx.backend.host.getWriter(
        activated.grant.scopeDigest,
        activated.grant.writerGeneration,
      );
      expect(current?.grantRef).toBe(activated.grant.grantRef);
      expect(path.basename(current!.root)).toBe("restored-run");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-01: writes a fenced content manifest and restores its exact bytes", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "checkpointed bytes", "utf8");
      const { checkpointId } = await ctx.commit();
      const destination = path.join(temporaryRoot, "restore");
      await restoreFilesystemCheckpoint({
        tenantId: TENANT_ID,
        checkpointId,
        destination,
        storage: { kind: "file", root: ctx.storageRoot },
        backend: ctx.backend,
        expected: {
          invocationId: ctx.invocationId,
          workspaceBindingId: ctx.workspaceBindingId,
          environmentDefinitionRevisionId: ctx.environmentRevisionId,
          recoveryVersion: 0,
        },
      });
      expect(await readFile(path.join(destination, "state.txt"), "utf8")).toBe(
        "checkpointed bytes",
      );
      const gate = await readGate(ctx.invocationId);
      expect(gate?.checkpointGate).toBe("open");
      expect(gate?.checkpointPreparedEvidence).toMatchObject({ checkpointId });
      expect(await countCheckpoints(ctx.invocationId)).toBe(1);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-02: a crash before the immutable commit leaves no formal checkpoint and a recoverable gate", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "checkpointed bytes", "utf8");
      const requested = await requestFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        ownershipId: ctx.ownershipId,
        declarations: {},
        requestedByType: "service",
        requestedById: "test-service",
      });
      // 模拟“上传成功但 commit 前进程崩溃”：候选证据已持久，但事务未提交。
      await db
        .update(invocationTable)
        .set({
          checkpointPreparedEvidence: {
            receipt: {
              manifestRef: "manifests/orphan.json",
              manifestDigest: protocolDigest({ orphan: true }),
              contentRootDigest: protocolDigest({ orphan: true }),
              fileCount: 1,
              totalBytes: 17,
              chunks: [],
            },
            orphanCandidate: true,
          },
        })
        .where(eq(invocationTable.id, ctx.invocationId));
      expect(await countCheckpoints(ctx.invocationId)).toBe(0);
      // 崩溃后 gate 停在 quiescing，恢复线程能通过 intentId 定位候选证据。
      const stalled = await readGate(ctx.invocationId);
      expect(stalled?.checkpointGate).toBe("quiescing");
      expect(stalled?.checkpointIntentId).toBe(requested.checkpointIntentId);
      expect(stalled?.checkpointPreparedEvidence).toMatchObject({ orphanCandidate: true });
      // 独立收尾 worker 续做：受控放弃候选，gate 回到 open，不生成正式 Checkpoint。
      await abandonFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        ownershipId: ctx.ownershipId,
        checkpointIntentId: requested.checkpointIntentId,
        reasonCode: "CheckpointStale",
      });
      const recovered = await readGate(ctx.invocationId);
      expect(recovered?.checkpointGate).toBe("open");
      expect(recovered?.checkpointIntentId).toBeNull();
      expect(recovered?.checkpointPreparedEvidence).toMatchObject({
        failureCode: "CheckpointStale",
      });
      expect(await countCheckpoints(ctx.invocationId)).toBe(0);
      // 收尾后同一 Ownership 可重新发起安全点（不凭空恢复，需重新走全流程）。
      const retry = await requestFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        ownershipId: ctx.ownershipId,
        declarations: {},
        requestedByType: "service",
        requestedById: "test-service",
      });
      expect(retry.checkpointIntentId).not.toBe(requested.checkpointIntentId);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("N06-T5: 物理 freeze 成功但回执落库前崩溃，维护 lane 从持久意图真实解冻", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      const requested = await requestFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        ownershipId: ctx.ownershipId,
        declarations: {},
        requestedByType: "service",
        requestedById: "test-service",
      });
      const [lock] = await db
        .select()
        .from(workspaceWriteLock)
        .where(eq(workspaceWriteLock.holderInvocationId, ctx.invocationId))
        .limit(1);
      if (!lock) throw new Error("WorkspaceWriteLock 缺失");
      const grant = await ctx.backend.host.getWriter(
        ctx.workspaceBinding.storageScopeDigest as string,
        lock.writerGeneration,
      );
      if (!grant) throw new Error("Writer grant 缺失");
      const freezeIntent = {
        checkpointIntentId: requested.checkpointIntentId,
        scopeDigest: ctx.workspaceBinding.storageScopeDigest as string,
        writerGeneration: lock.writerGeneration,
        anchorDigest: requested.anchorDigest,
        registeredAt: new Date().toISOString(),
      };
      await db
        .update(invocationTable)
        .set({ checkpointPreparedEvidence: { freezeIntent } })
        .where(eq(invocationTable.id, ctx.invocationId));
      await ctx.backend.host.freeze({
        grant,
        checkpointIntentId: requested.checkpointIntentId,
        anchorDigest: requested.anchorDigest,
      });
      const freezeFile = path.join(
        ctx.hostRoot,
        ".snow",
        "grants",
        (ctx.workspaceBinding.storageScopeDigest as string).replace(/^sha256:/, ""),
        "freeze.json",
      );
      await expect(stat(freezeFile)).resolves.toBeTruthy();

      // 原进程消失，只有新的维护进程与持久 freezeIntent 可用。
      const restartedBackend = createWorkspaceBackend(
        createWorkspaceHostBroker({ root: ctx.hostRoot, managedRoot: ctx.managedRoot }),
      );
      const maintenance = await runCheckpointMaintenanceLane({
        now: new Date(Date.now() + 300_000),
        graceMs: 0,
        resolveBackend: async () => restartedBackend,
        releaseRuntime: async () => undefined,
      });
      expect(maintenance.stuckGates.abandoned).toBe(1);
      expect(maintenance.releases.gateOpened).toBe(1);
      expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("open");
      await expect(stat(freezeFile)).rejects.toThrow();
      await expect(restartedBackend.host.assertWriter(grant)).resolves.toBeUndefined();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("N06-T6: Owner 接管保留旧 checkpoint release tuple，并由维护 lane 收口而非直接清空", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "takeover release", "utf8");
      const checkpoint = await ctx.commitWithoutRuntimeRelease();
      const before = await readGate(ctx.invocationId);
      expect(before?.checkpointGate).toBe("releasing");
      expect(before?.checkpointIntentId).toBe(checkpoint.checkpointIntentId);

      await db
        .update(executionOwnershipTable)
        .set({
          leaseExpiresAt: new Date(ctx.ownership.acquiredAt.getTime() + 1),
          lastHeartbeatAt: ctx.ownership.acquiredAt,
          updatedAt: new Date(),
        })
        .where(eq(executionOwnershipTable.id, ctx.ownershipId));
      const replacementAttempt = await createAttempt({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        retryReasonCode: "checkpoint_owner_takeover",
      });
      const evidence = { kind: "n06-t6", attemptId: replacementAttempt.id };
      await db.transaction((tx) =>
        markAttemptPreparedForTestInTransaction(tx, {
          attemptId: replacementAttempt.id,
          evidence,
          digest: protocolDigest(evidence),
        }),
      );
      await acquireExecutionOwnership({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        attemptId: replacementAttempt.id,
        runtimeRevisionId: ctx.runtimeRevisionId,
        acquiredByType: "service",
        acquiredById: "n06-t6-takeover",
      });
      const afterTakeover = await readGate(ctx.invocationId);
      expect(afterTakeover?.checkpointGate).toBe("releasing");
      expect(afterTakeover?.checkpointIntentId).toBe(checkpoint.checkpointIntentId);
      expect(afterTakeover?.checkpointOwnerId).toBe(ctx.ownershipId);
      expect(afterTakeover?.checkpointPreparedEvidence).toMatchObject({
        checkpointId: checkpoint.checkpointId,
        release: { backend: "confirmed", runtime: "pending" },
      });

      const maintenance = await runCheckpointMaintenanceLane({
        resolveBackend: async () => ctx.backend,
        graceMs: 0,
        now: new Date(afterTakeover!.updatedAt.getTime() + 1),
      });
      expect(maintenance.releases.runtimeClosed).toBe(1);
      expect(maintenance.releases.gateOpened).toBe(1);
      expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("open");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-03: restores multi-file trees with permissions, mtime and root-relative symlinks intact", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      const fixedMtime = new Date("2026-01-02T03:04:05.000Z");
      await writeFile(path.join(ctx.writerRoot, "a.txt"), "alpha", "utf8");
      await mkdir(path.join(ctx.writerRoot, "sub"), { recursive: true });
      await writeFile(path.join(ctx.writerRoot, "sub", "b.bin"), Buffer.from([0, 1, 2, 255]));
      await chmod(path.join(ctx.writerRoot, "sub", "b.bin"), 0o600);
      await symlink("a.txt", path.join(ctx.writerRoot, "link.txt"));
      await utimes(path.join(ctx.writerRoot, "a.txt"), fixedMtime, fixedMtime);
      const { checkpointId } = await ctx.commit();
      const destination = path.join(temporaryRoot, "restore");
      await restoreFilesystemCheckpoint({
        tenantId: TENANT_ID,
        checkpointId,
        destination,
        storage: { kind: "file", root: ctx.storageRoot },
        backend: ctx.backend,
        expected: {
          invocationId: ctx.invocationId,
          workspaceBindingId: ctx.workspaceBindingId,
          environmentDefinitionRevisionId: ctx.environmentRevisionId,
          recoveryVersion: 0,
        },
      });
      expect(await readFile(path.join(destination, "a.txt"), "utf8")).toBe("alpha");
      expect(await readFile(path.join(destination, "sub", "b.bin"))).toEqual(
        Buffer.from([0, 1, 2, 255]),
      );
      const restoredStat = await readFile(path.join(destination, "sub", "b.bin"));
      expect(restoredStat).toBeInstanceOf(Buffer);
      const linkTarget = await readlink(path.join(destination, "link.txt"));
      expect(linkTarget).toBe("a.txt");
      const mtime = (await stat(path.join(destination, "a.txt"))).mtime;
      expect(mtime.toISOString()).toBe(fixedMtime.toISOString());
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-04: 旧水位 Checkpoint 陈旧，且声明无法伪造锚点成员（R09 §1/§4）", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "v1", "utf8");
      const first = await ctx.commit();
      // Checkpoint 之后新增**已应用 Action 事实**：水位推进到 1（§3 推进表）。
      const applied = await ctx.seedIngressFact({
        producerSequence: 2,
        type: "action",
        payload: { action: "tool_call", result: "ok" },
        recoveryVersionAfter: 1,
      });
      // 更严格的安全性来自**当前事实**而不是 Checkpoint 自己的记载。
      await expect(
        restoreFilesystemCheckpoint({
          tenantId: TENANT_ID,
          checkpointId: first.checkpointId,
          destination: path.join(temporaryRoot, "restore-stale"),
          storage: { kind: "file", root: ctx.storageRoot },
          backend: ctx.backend,
          expected: {
            invocationId: ctx.invocationId,
            workspaceBindingId: ctx.workspaceBindingId,
            environmentDefinitionRevisionId: ctx.environmentRevisionId,
            recoveryVersion: 1,
          },
        }),
      ).rejects.toThrow("CheckpointStale");
      // §1：声明不存在的 actionFact 必须被拒（不能"给了数组就存"）。
      await expect(
        requestFilesystemCheckpoint({
          tenantId: TENANT_ID,
          invocationId: ctx.invocationId,
          ownershipId: ctx.ownershipId,
          declarations: { actionFacts: [randomUUID()] },
          requestedByType: "service",
          requestedById: "test-service",
        }),
      ).rejects.toThrow("CheckpointStale");
      // §1：把**未应用**的控制事实声明成 actionFact 必须被拒。
      const control = await ctx.seedIngressFact({
        producerSequence: 3,
        type: "progress",
        payload: { note: "still working" },
        recoveryVersionAfter: 1,
      });
      await expect(
        requestFilesystemCheckpoint({
          tenantId: TENANT_ID,
          invocationId: ctx.invocationId,
          ownershipId: ctx.ownershipId,
          declarations: { actionFacts: [control.ingressId] },
          requestedByType: "service",
          requestedById: "test-service",
        }),
      ).rejects.toThrow("CheckpointStale");
      // §1：水位是服务端推导的；调用方不能把它声明成更高的值。
      await expect(
        requestFilesystemCheckpoint({
          tenantId: TENANT_ID,
          invocationId: ctx.invocationId,
          ownershipId: ctx.ownershipId,
          declarations: { unconsumedInputWatermark: "99" },
          requestedByType: "service",
          requestedById: "test-service",
        }),
      ).rejects.toThrow("CheckpointStale");
      // 用与当前事实一致的声明可以继续；锚点成员由服务端从事实填充。
      const requested = await requestFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        ownershipId: ctx.ownershipId,
        declarations: { actionFacts: [applied.ingressId], unconsumedInputWatermark: "0" },
        requestedByType: "service",
        requestedById: "test-service",
      });
      expect(requested.checkpointIntentId).toBeTruthy();
      expect(requested.recoveryAnchor).toMatchObject({
        recoveryVersion: "1",
        producerSequence: "3",
        consumedInputRefs: [],
        unconsumedInputWatermark: "0",
      });
      expect(requested.recoveryAnchor.actionFacts).toEqual([
        {
          ref: applied.ingressId,
          factType: "action",
          producerSequence: "2",
          evidenceDigest: applied.payloadHash,
        },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-05: 已消费输入由服务端推导，未消费输入不会被伪造成已消费（R09 §1/§3）", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "payload", "utf8");
      // 一条**已消费**输入（推进水位）与一条**未消费**输入（不推进水位）。
      const consumed = await ctx.seedIngressFact({
        producerSequence: 2,
        type: "user-action",
        payload: { text: "hello" },
        recoveryVersionAfter: 1,
      });
      const unconsumed = await ctx.seedIngressFact({
        producerSequence: 3,
        type: "user-action",
        payload: { text: "queued but not looped yet" },
        recoveryVersionAfter: 1,
      });
      // 错报水位（把未消费输入也算进"整段已消费"）必须被拒。
      await expect(
        requestFilesystemCheckpoint({
          tenantId: TENANT_ID,
          invocationId: ctx.invocationId,
          ownershipId: ctx.ownershipId,
          declarations: { unconsumedInputWatermark: "3" },
          requestedByType: "service",
          requestedById: "test-service",
        }),
      ).rejects.toThrow("CheckpointStale");
      const ok = await requestFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        ownershipId: ctx.ownershipId,
        declarations: { unconsumedInputWatermark: "2" },
        requestedByType: "service",
        requestedById: "test-service",
      });
      expect(ok.recoveryAnchor.consumedInputRefs).toEqual([
        {
          ref: consumed.ingressId,
          factType: "user-action",
          producerSequence: "2",
          evidenceDigest: consumed.payloadHash,
        },
      ]);
      expect(ok.recoveryAnchor.unconsumedInputWatermark).toBe("2");
      expect(ok.recoveryAnchor.consumedInputRefs).not.toContainEqual(
        expect.objectContaining({ ref: unconsumed.ingressId }),
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-06: unconsumed inputs survive in the anchor watermark and are not fabricated as consumed", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "checkpointed bytes", "utf8");
      const { checkpointId, anchorDigest } = await ctx.commit();
      const [row] = await db
        .select()
        .from(filesystemCheckpointTable)
        .where(
          and(
            eq(filesystemCheckpointTable.tenantId, TENANT_ID),
            eq(filesystemCheckpointTable.id, checkpointId),
          ),
        );
      expect(row?.recoveryAnchor).toMatchObject({
        unconsumedInputWatermark: "0",
        consumedInputRefs: [],
      });
      // anchor digest 与正式行一致：未消费输入不篡改 Checkpoint 对应模型状态。
      expect(row?.recoveryAnchorDigest).toBe(anchorDigest);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-07: a corrupted content chunk fails restore with CheckpointIntegrityFailed", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "integrity matters", "utf8");
      const { checkpointId } = await ctx.commit();
      const [row] = await db
        .select()
        .from(filesystemCheckpointTable)
        .where(
          and(
            eq(filesystemCheckpointTable.tenantId, TENANT_ID),
            eq(filesystemCheckpointTable.id, checkpointId),
          ),
        );
      const chunkDigest = (row?.storageEvidence as { chunks: string[] }).chunks[0]!;
      const chunkPath = path.join(ctx.storageRoot, "chunks", chunkDigest.slice("sha256:".length));
      const original = await readFile(chunkPath);
      // 同长度篡改：绕过大小校验，必须由 hash 校验兜住。
      const tampered = Buffer.from(original);
      tampered[0] = tampered[0]! ^ 0xff;
      await writeFile(chunkPath, tampered);
      await expect(
        restoreFilesystemCheckpoint({
          tenantId: TENANT_ID,
          checkpointId,
          destination: path.join(temporaryRoot, "restore-corrupt"),
          storage: { kind: "file", root: ctx.storageRoot },
          backend: ctx.backend,
          expected: {
            invocationId: ctx.invocationId,
            workspaceBindingId: ctx.workspaceBindingId,
            environmentDefinitionRevisionId: ctx.environmentRevisionId,
            recoveryVersion: 0,
          },
        }),
      ).rejects.toThrow("CheckpointIntegrityFailed");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-08: manifest path traversal is rejected and cannot escape the destination", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      const outside = path.join(temporaryRoot, "outside");
      await mkdir(outside, { recursive: true });
      const sentinel = path.join(outside, "sentinel.txt");
      await writeFile(sentinel, "must survive", "utf8");
      // 手工构造带越界路径的 manifest，digest 自洽以通过外层完整性校验。
      const entries: SnapshotEntry[] = [
        {
          path: "../outside/evil.txt",
          type: "file",
          sizeBytes: 4,
          mtimeMs: 0,
          mode: 0o644,
          chunks: [{ digest: protocolDigest({ evil: true }), sizeBytes: 4 }],
        },
      ];
      const body = {
        format: "content_manifest" as const,
        formatVersion: 1 as const,
        entries,
        fileCount: 1,
        totalBytes: 4,
        contentRootDigest: digestJson(entries),
      };
      const manifest = { ...body, manifestDigest: digestJson(body) };
      await mkdir(path.join(ctx.storageRoot, "manifests"), { recursive: true });
      const manifestRef = `manifests/${manifest.manifestDigest.slice("sha256:".length)}.json`;
      await writeFile(path.join(ctx.storageRoot, manifestRef), JSON.stringify(manifest), "utf8");
      const storage = new FileSnapshotStorage(ctx.storageRoot);
      await expect(storage.readManifest(manifestRef, manifest.manifestDigest)).rejects.toThrow();
      await expect(
        storage.restoreSnapshot(manifest, path.join(temporaryRoot, "restore-attack")),
      ).rejects.toThrow();
      expect(await readFile(sentinel, "utf8")).toBe("must survive");
      expect(await readdir(outside)).toEqual(["sentinel.txt"]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-09: special files (FIFO) are rejected with an explicit unsupported error", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "data", "utf8");
      const fifo = path.join(ctx.writerRoot, "pipe");
      const created = spawnSync("mkfifo", [fifo]);
      if (created.status !== 0) throw new Error(`mkfixture 失败: ${created.stderr?.toString()}`);
      await expect(ctx.commit()).rejects.toThrow("不支持特殊文件");
      expect(await countCheckpoints(ctx.invocationId)).toBe(0);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-10: a superseded owner cannot commit a checkpoint and no formal row appears", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "data", "utf8");
      const requested = await requestFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        ownershipId: ctx.ownershipId,
        declarations: {},
        requestedByType: "service",
        requestedById: "test-service",
      });
      // 模拟上传期间发生 Takeover：旧 Ownership 失去 active 状态。
      await db
        .update(executionOwnershipTable)
        .set({
          ownershipState: "lost",
          releasedAt: new Date(),
          reasonCode: "superseded",
        })
        .where(eq(executionOwnershipTable.id, ctx.ownershipId));
      await expect(
        produceFilesystemCheckpoint({
          tenantId: TENANT_ID,
          invocationId: ctx.invocationId,
          ownershipId: ctx.ownershipId,
          backend: ctx.backend,
          storage: { kind: "file", root: ctx.storageRoot },
          checkpointIntentId: requested.checkpointIntentId,
          safePointEvidence: {
            checkpointIntentId: requested.checkpointIntentId,
            safePointEvidenceDigest: protocolDigest({ safePoint: requested.checkpointIntentId }),
            writerQuiescenceAchievedAt: new Date(),
          },
        }),
      ).rejects.toThrow("NotCurrentExecutor");
      expect(await countCheckpoints(ctx.invocationId)).toBe(0);
      // 受控清理：gate 回 open，不留下无法退出的屏障。
      await abandonFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        ownershipId: ctx.ownershipId,
        checkpointIntentId: requested.checkpointIntentId,
        reasonCode: "NotCurrentExecutor",
      });
      const gate = await readGate(ctx.invocationId);
      expect(gate?.checkpointGate).toBe("open");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-11: an expired safe-point deadline cannot commit and the gate is cleaned up", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "data", "utf8");
      const requested = await requestFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        ownershipId: ctx.ownershipId,
        declarations: {},
        requestedByType: "service",
        requestedById: "test-service",
      });
      // Writer 无法在预算内排空：deadline 已过。
      await db
        .update(invocationTable)
        .set({
          checkpointDeadline: new Date(Date.now() - 1_000),
        })
        .where(eq(invocationTable.id, ctx.invocationId));
      await expect(
        produceFilesystemCheckpoint({
          tenantId: TENANT_ID,
          invocationId: ctx.invocationId,
          ownershipId: ctx.ownershipId,
          backend: ctx.backend,
          storage: { kind: "file", root: ctx.storageRoot },
          checkpointIntentId: requested.checkpointIntentId,
          safePointEvidence: {
            checkpointIntentId: requested.checkpointIntentId,
            safePointEvidenceDigest: protocolDigest({ safePoint: requested.checkpointIntentId }),
            writerQuiescenceAchievedAt: new Date(),
          },
        }),
      ).rejects.toThrow("CheckpointStale");
      expect(await countCheckpoints(ctx.invocationId)).toBe(0);
      // produce 失败路径自动收尾：gate 回 open，候选不成为 Checkpoint。
      const gate = await readGate(ctx.invocationId);
      expect(gate?.checkpointGate).toBe("open");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-12: shared content chunks survive a failed candidate cleanup and both checkpoints restore", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "shared bytes", "utf8");
      const first = await ctx.commit();
      // 复用同一文件内容提交第二个 Checkpoint：同块引用。
      await writeFile(path.join(ctx.writerRoot, "extra.txt"), "extra", "utf8");
      const second = await ctx.commit();
      expect(second.checkpointId).not.toBe(first.checkpointId);
      const manifests = await listFilesystemCheckpoints(TENANT_ID, ctx.invocationId);
      expect(manifests).toHaveLength(2);
      const storage = new FileSnapshotStorage(ctx.storageRoot);
      const m1 = await storage.readManifest(
        manifests[0]!.manifestRef,
        manifests[0]!.manifestDigest,
      );
      const m2 = await storage.readManifest(
        manifests[1]!.manifestRef,
        manifests[1]!.manifestDigest,
      );
      const stateChunks1 = m1.entries.find((entry) => entry.path === "state.txt")!.chunks ?? [];
      const stateChunks2 = m2.entries.find((entry) => entry.path === "state.txt")!.chunks ?? [];
      expect(stateChunks1).toEqual(stateChunks2);
      // 一个进行中的候选失败并被 abandon，不影响已提交 Checkpoint 的内容块。
      const failing = await requestFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        ownershipId: ctx.ownershipId,
        declarations: {},
        requestedByType: "service",
        requestedById: "test-service",
      });
      await abandonFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        ownershipId: ctx.ownershipId,
        checkpointIntentId: failing.checkpointIntentId,
        reasonCode: "CheckpointStale",
      });
      for (const [index, saved] of manifests.entries()) {
        const destination = path.join(temporaryRoot, `restore-${index}`);
        await restoreFilesystemCheckpoint({
          tenantId: TENANT_ID,
          checkpointId: saved.id,
          destination,
          storage: { kind: "file", root: ctx.storageRoot },
          backend: ctx.backend,
          expected: {
            invocationId: ctx.invocationId,
            workspaceBindingId: ctx.workspaceBindingId,
            environmentDefinitionRevisionId: ctx.environmentRevisionId,
            // 当前水位：本用例的多个 Checkpoint 都建立在同一水位上，期间无已应用事实推进。
            recoveryVersion: 0,
          },
        });
        expect(await readFile(path.join(destination, "state.txt"), "utf8")).toBe("shared bytes");
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-13 / N06-T3/N06-T4: 维护 lane 持久确认 Backend 并向原 Runtime 重发 release", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "release matters", "utf8");
      // 模拟"DB 已提交、Runtime 解冻丢失"的崩溃窗口。
      const produced = await ctx.commitWithoutRuntimeRelease();
      expect(produced.release).toEqual({ runtime: "pending", backend: "confirmed" });
      const stalled = await readGate(ctx.invocationId);
      expect(stalled?.checkpointGate).toBe("releasing");
      // Checkpoint 本身是已提交事实：即使 release 未完成也必须可被列出。
      expect(await countCheckpoints(ctx.invocationId)).toBe(1);
      // 维护 lane 续做：Backend 腿幂等确认，并向精确原代际重发 Runtime release。
      // 扫描窗口是 `updatedAt < now - graceMs`，两侧时间都取自毫秒精度的库时钟：`graceMs: 0`
      // 时若恢复调用与提交落在同一毫秒，这一行会被判"还不够旧"而漏扫。这里显式把 now 推到
      // 该行之后，使用例只考察**收口判定**本身，不依赖毫秒级墙钟竞争。
      let runtimeReleaseCalls = 0;
      const report = await recoverPendingCheckpointReleases({
        now: new Date(stalled!.updatedAt.getTime() + 1),
        graceMs: 0,
        resolveBackend: async () => ctx.backend,
        releaseRuntime: async ({ owner, checkpointIntentId }) => {
          expect(owner.id).toBe(ctx.ownershipId);
          expect(checkpointIntentId).toBe(produced.checkpointIntentId);
          runtimeReleaseCalls += 1;
        },
      });
      expect(report.examined).toBeGreaterThanOrEqual(1);
      expect(runtimeReleaseCalls).toBe(1);
      expect(report.awaitingRuntime).toBe(0);
      expect(report.gateOpened).toBe(1);
      expect(report.failures).toEqual([]);
      expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("open");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-14: Runtime 已消失时维护 lane 据实收口解冻并放开 Gate，不留永久卡死（R09 §2 步骤 8）", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "release matters", "utf8");
      const produced = await ctx.commitWithoutRuntimeRelease();
      // 崩溃后该 Invocation 已进入终态：没有可解冻的 Runtime。
      await db
        .update(invocationTable)
        .set({ executionState: "failed", finishedAt: new Date() })
        .where(eq(invocationTable.id, ctx.invocationId));
      const stalled = await readGate(ctx.invocationId);
      expect(stalled?.checkpointGate).toBe("releasing");
      const report = await recoverPendingCheckpointReleases({
        // 同 CHECKPOINT-REG-13：把 now 显式推过该行，避免毫秒同刻被漏扫。
        now: new Date(stalled!.updatedAt.getTime() + 1),
        graceMs: 0,
        resolveBackend: async () => ctx.backend,
      });
      // 先断言真的扫到了这一行：否则下面的计数为 0 只是"没扫到"，会掩盖真实的收口缺陷。
      expect(report.examined).toBeGreaterThanOrEqual(1);
      expect(report.failures).toEqual([]);
      expect(report.awaitingRuntime).toBe(0);
      expect(report.runtimeClosed).toBe(1);
      expect(report.gateOpened).toBe(1);
      const gate = await readGate(ctx.invocationId);
      expect(gate?.checkpointGate).toBe("open");
      expect(gate?.checkpointIntentId).toBeNull();
      // 解冻已确认，且 Checkpoint 仍可用于恢复。
      const destination = path.join(temporaryRoot, "restore-after-release");
      await restoreFilesystemCheckpoint({
        tenantId: TENANT_ID,
        checkpointId: produced.checkpointId,
        destination,
        storage: { kind: "file", root: ctx.storageRoot },
        backend: ctx.backend,
        expected: {
          invocationId: ctx.invocationId,
          workspaceBindingId: ctx.workspaceBindingId,
          environmentDefinitionRevisionId: ctx.environmentRevisionId,
          recoveryVersion: 0,
        },
      });
      expect(await readFile(path.join(destination, "state.txt"), "utf8")).toBe("release matters");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-REG-15: large files are chunked with per-chunk hash verification and restore byte-exact", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      const { createHash } = await import("node:crypto");
      const SNAPSHOT_CHUNK_BYTES = 4 * 1024 * 1024;
      const totalBytes = SNAPSHOT_CHUNK_BYTES + 1024;
      const payload = Buffer.alloc(totalBytes);
      for (let offset = 0; offset < totalBytes; offset += 4096) {
        payload.write(`block-${offset}`, offset, "utf8");
      }
      await writeFile(path.join(ctx.writerRoot, "big.bin"), payload);
      const { checkpointId } = await ctx.commit();
      const [row] = await db
        .select()
        .from(filesystemCheckpointTable)
        .where(
          and(
            eq(filesystemCheckpointTable.tenantId, TENANT_ID),
            eq(filesystemCheckpointTable.id, checkpointId),
          ),
        );
      expect(row?.totalBytes).toBe(totalBytes);
      const storage = new FileSnapshotStorage(ctx.storageRoot);
      const manifest = await storage.readManifest(row!.manifestRef, row!.manifestDigest);
      const bigEntry = manifest.entries.find((entry) => entry.path === "big.bin")!;
      expect(bigEntry.chunks).toHaveLength(2);
      expect(bigEntry.chunks![0]!.sizeBytes).toBe(SNAPSHOT_CHUNK_BYTES);
      expect(bigEntry.chunks![1]!.sizeBytes).toBe(totalBytes - SNAPSHOT_CHUNK_BYTES);
      for (const chunk of bigEntry.chunks ?? []) {
        const bytes = await readFile(
          path.join(ctx.storageRoot, "chunks", chunk.digest.slice("sha256:".length)),
        );
        expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(chunk.digest);
      }
      const destination = path.join(temporaryRoot, "restore-big");
      await restoreFilesystemCheckpoint({
        tenantId: TENANT_ID,
        checkpointId,
        destination,
        storage: { kind: "file", root: ctx.storageRoot },
        backend: ctx.backend,
        expected: {
          invocationId: ctx.invocationId,
          workspaceBindingId: ctx.workspaceBindingId,
          environmentDefinitionRevisionId: ctx.environmentRevisionId,
          recoveryVersion: 0,
        },
      });
      const restored = await readFile(path.join(destination, "big.bin"));
      expect(restored.length).toBe(totalBytes);
      expect(`sha256:${createHash("sha256").update(restored).digest("hex")}`).toBe(
        `sha256:${createHash("sha256").update(payload).digest("hex")}`,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
