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
import { executionOwnershipTable, invocationTable } from "@/lib/persistence/schema/executions";
import { filesystemCheckpointTable } from "@/lib/persistence/schema/filesystem-checkpoint";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import {
  abandonFilesystemCheckpoint,
  produceFilesystemCheckpoint,
  requestFilesystemCheckpoint,
} from "@/lib/workspace/checkpoint-producer";
import { restoreFilesystemCheckpoint } from "@/lib/workspace/checkpoint-restore";
import { listFilesystemCheckpoints } from "@/lib/workspace/checkpoint-store";
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
  writerRoot: string;
  storageRoot: string;
  backend: ReturnType<typeof createWorkspaceBackend>;
  /** 构造与当前 invocation facts 匹配的合法 RecoveryAnchor。 */
  anchor: () => Record<string, unknown>;
  /** request + produce 全流程（幂等 intent 由内部生成）。 */
  commit: () => Promise<{ checkpointId: string; anchorDigest: string }>;
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
  const anchor = () => ({
    invocationId: fixture.invocation.id,
    bindingDigest: fixture.binding.configHash,
    recoveryVersion: "0",
    producerSequence: "1",
    consumedInputRefs: [],
    actionFacts: [],
    childFacts: [],
    resolvedUserActionRefs: [],
    unconsumedInputWatermark: "0",
  });
  const commit = async () => {
    const requested = await requestFilesystemCheckpoint({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      ownershipId: acquired.ownership.id,
      recoveryAnchor: anchor(),
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
    return { checkpointId: checkpoint.checkpointId, anchorDigest: requested.anchorDigest };
  };
  return {
    workspaceBindingId: workspace.id,
    environmentRevisionId: environmentRevision.id,
    invocationId: fixture.invocation.id,
    ownershipId: acquired.ownership.id,
    writerRoot: activated.grant.root,
    storageRoot: path.join(temporaryRoot, "snapshot-storage"),
    backend,
    anchor,
    commit,
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
      const { checkpointId, anchorDigest } = await ctx.commit();
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
          recoveryAnchorDigest: anchorDigest,
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
        recoveryAnchor: ctx.anchor(),
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
        recoveryAnchor: ctx.anchor(),
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
      const { checkpointId, anchorDigest } = await ctx.commit();
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
          recoveryAnchorDigest: anchorDigest,
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

  it("CHECKPOINT-04: a stale checkpoint cannot be restored against a newer recovery watermark", async () => {
    try {
      const ctx = await setupCheckpointFixture(temporaryRoot);
      await writeFile(path.join(ctx.writerRoot, "state.txt"), "v1", "utf8");
      const first = await ctx.commit();
      // Checkpoint 后新增已消费 Action：producer 水位推进到 2。
      await db
        .update(invocationTable)
        .set({ lastProducerSequence: 2 })
        .where(eq(invocationTable.id, ctx.invocationId));
      // 旧 Checkpoint 不能匹配新恢复状态。
      const newerAnchor = { ...ctx.anchor(), producerSequence: "2" };
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
            recoveryAnchorDigest: protocolDigest(newerAnchor),
            recoveryVersion: 0,
          },
        }),
      ).rejects.toThrow("CheckpointStale");
      // 请求新 Checkpoint 也不能复用旧水位 anchor。
      await expect(
        requestFilesystemCheckpoint({
          tenantId: TENANT_ID,
          invocationId: ctx.invocationId,
          ownershipId: ctx.ownershipId,
          recoveryAnchor: { ...ctx.anchor(), producerSequence: "1", actionFacts: [] },
          requestedByType: "service",
          requestedById: "test-service",
        }),
      ).rejects.toThrow("CheckpointStale");
      // 但用与新水位一致的 anchor 重新提交后，可以继续。
      const requested = await requestFilesystemCheckpoint({
        tenantId: TENANT_ID,
        invocationId: ctx.invocationId,
        ownershipId: ctx.ownershipId,
        recoveryAnchor: newerAnchor,
        requestedByType: "service",
        requestedById: "test-service",
      });
      expect(requested.checkpointIntentId).toBeTruthy();
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
            recoveryAnchorDigest: anchorDigest,
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
        recoveryAnchor: ctx.anchor(),
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
        recoveryAnchor: ctx.anchor(),
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
        recoveryAnchor: ctx.anchor(),
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
            recoveryAnchorDigest: saved.recoveryAnchorDigest,
            recoveryVersion: saved.recoveryVersion,
          },
        });
        expect(await readFile(path.join(destination, "state.txt"), "utf8")).toBe("shared bytes");
      }
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
          recoveryAnchorDigest: anchorDigest,
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
