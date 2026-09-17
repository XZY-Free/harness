import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import {
  executionOwnershipTable,
  invocationTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import { filesystemCheckpointTable } from "@/lib/persistence/schema/filesystem-checkpoint";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import {
  type AuthorityIdentity,
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
} from "@/lib/workspace/checkpoint-release";
import { restoreFilesystemCheckpoint } from "@/lib/workspace/checkpoint-restore";
import { listFilesystemCheckpoints } from "@/lib/workspace/checkpoint-store";
import type { RecoveryAnchorDeclarations } from "@/lib/workspace/recovery-anchor";
import { type SnapshotEntry, digestJson } from "@/lib/workspace/snapshot-manifest";
import { FileSnapshotStorage } from "@/lib/workspace/snapshot-storage";
import { createWorkspaceBackend } from "@/lib/workspace/workspace-backend";
import { computeWorkspaceContractDigest } from "@/lib/workspace/workspace-contract";
import { createWorkspaceHostBroker } from "@/lib/workspace/workspace-host-server";
import { createWorkspace, createWorkspaceBinding } from "@/lib/workspace/workspace-queries";
import {
  activatePreparedWorkspaceWriter,
  prepareWorkspaceCandidate,
} from "@/lib/workspace/workspace-writer";
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
}

async function setupCheckpointFixture(temporaryRoot: string): Promise<CheckpointFixture> {
  // writer root 与 host 元数据/候选目录物理分离，scan 不得混入控制面文件。
  const writerRoot = path.join(temporaryRoot, "writer");
  const hostRoot = path.join(temporaryRoot, "host");
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
      storageRoot: path.join(temporaryRoot, "snapshot-storage"),
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
    storageRoot: path.join(temporaryRoot, "snapshot-storage"),
    backend,
    declarations,
    seedIngressFact,
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

async function readGate(invocationId: string): Promise<{
  checkpointGate: string;
  checkpointIntentId: string | null;
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

  it("CHECKPOINT-01: writes a fenced content manifest and restores its exact bytes", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "checkpointed bytes", "utf8");
      const { checkpointId } = await ctx.commit();
      const destination = path.join(temporaryRoot, "restore");
      await restoreFilesystemCheckpoint({
        tenantId: TENANT_ID,
        checkpointId,
        destination,
        storageRoot: ctx.storageRoot,
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

  it("CHECKPOINT-02: a crash before the immutable commit leaves no formal checkpoint and a recoverable gate", async () => {
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

  it("CHECKPOINT-03: restores multi-file trees with permissions, mtime and root-relative symlinks intact", async () => {
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
        storageRoot: ctx.storageRoot,
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

  it("CHECKPOINT-04: 旧水位 Checkpoint 陈旧，且声明无法伪造锚点成员（R09 §1/§4）", async () => {
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
          storageRoot: ctx.storageRoot,
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

  it("CHECKPOINT-04b: 已消费输入由服务端推导，未消费输入不会被伪造成已消费（R09 §1/§3）", async () => {
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

  it("CHECKPOINT-05: unconsumed inputs survive in the anchor watermark and are not fabricated as consumed", async () => {
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

  it("CHECKPOINT-06: a corrupted content chunk fails restore with CheckpointIntegrityFailed", async () => {
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
          storageRoot: ctx.storageRoot,
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

  it("CHECKPOINT-07: manifest path traversal is rejected and cannot escape the destination", async () => {
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

  it("CHECKPOINT-08: special files (FIFO) are rejected with an explicit unsupported error", async () => {
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

  it("CHECKPOINT-09: a superseded owner cannot commit a checkpoint and no formal row appears", async () => {
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
          storageRoot: ctx.storageRoot,
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

  it("CHECKPOINT-10: an expired safe-point deadline cannot commit and the gate is cleaned up", async () => {
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
          storageRoot: ctx.storageRoot,
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

  it("CHECKPOINT-11: shared content chunks survive a failed candidate cleanup and both checkpoints restore", async () => {
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
          storageRoot: ctx.storageRoot,
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

  it("CHECKPOINT-13: release 丢失后维护 lane 续做 Backend 解冻；Runtime 仍活着时 Gate 保持 fail-closed（R09 §2 步骤 8）", async () => {
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
      // 维护 lane 续做：Backend 腿幂等重放，Runtime 腿仍活着 → 不得伪造"已解冻"。
      // 扫描窗口是 `updatedAt < now - graceMs`，两侧时间都取自毫秒精度的库时钟：`graceMs: 0`
      // 时若恢复调用与提交落在同一毫秒，这一行会被判"还不够旧"而漏扫。这里显式把 now 推到
      // 该行之后，使用例只考察**收口判定**本身，不依赖毫秒级墙钟竞争。
      const report = await recoverPendingCheckpointReleases({
        now: new Date(stalled!.updatedAt.getTime() + 1),
        graceMs: 0,
        resolveBackend: async () => ctx.backend,
      });
      expect(report.examined).toBeGreaterThanOrEqual(1);
      expect(report.awaitingRuntime).toBe(1);
      expect(report.gateOpened).toBe(0);
      expect(report.failures).toEqual([]);
      expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("releasing");
      // 迟到但合法的 Runtime 确认到达后，Gate 才放行。
      const legs = await confirmCheckpointRuntimeRelease({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        checkpointIntentId: produced.checkpointIntentId,
      });
      expect(legs).toEqual({ runtime: "confirmed", backend: "confirmed" });
      expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("open");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("CHECKPOINT-14: Runtime 已消失时维护 lane 据实收口解冻并放开 Gate，不留永久卡死（R09 §2 步骤 8）", async () => {
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
        // 同 CHECKPOINT-13：把 now 显式推过该行，避免毫秒同刻被漏扫。
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
        storageRoot: ctx.storageRoot,
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

  it("CHECKPOINT-12: large files are chunked with per-chunk hash verification and restore byte-exact", async () => {
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
        storageRoot: ctx.storageRoot,
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
