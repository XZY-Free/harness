/**
 * Checkpoint 生产链（R09 §2）。
 *
 * 安全点顺序（§2 八步）在本文件内逐条落地：
 * 1. `requestFilesystemCheckpoint` 登记稳定 checkpointIntentId 与 deadline，进入 quiescing。
 * 2. 已接纳的 Tool/Agent/Job step 完成与 Effect 回执照常落各自 Authority —— 本文件只
 *    拒绝**新**决策/新 Action/新写入，不因 gate 非 open 丢弃真实完成事实（丢弃发生在
 *    ingress 层：只有新 proposal 被拒，见 `assertCheckpointWritable`）。
 * 3. `produceFilesystemCheckpoint` 等到受管 Writer 排空（Host 的 writer 活性采样）。
 * 4. **排空后**用最新已应用事实重建并冻结 RecoveryAnchor：绝不把请求时的旧水位当最终水位。
 * 5. Broker 冻结一致文件 Generation 并给出停止/排空证据（SafePointReceipt）。
 * 6. 持久写 Snapshot，做结构/内容/资源约束验证（snapshot-storage / snapshot-manifest）。
 * 7. I 根内复核 Current Owner 未变、安全点未失效、恢复事实仍与 Anchor 等价后提交。
 * 8. 解冻 Runtime 与 Backend 是**持久命令/工作**：Gate 转入 `releasing`，只有解冻被确认
 *    才回到 open；进程 Crash 时由维护 lane 按 intentId 续做（checkpoint-release.ts），
 *    不再用 finally + `.catch(() => undefined)` 把失败吞掉。
 */
import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
import { getAuthorityDatabaseTime } from "@/lib/executions/persistence/execution-ownership-store";
import { environmentLeaseTable } from "@/lib/persistence/schema/environment";
import {
  type Invocation,
  executionBindingTable,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationCommandTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import {
  type CheckpointReleaseLegs,
  confirmCheckpointBackendRelease,
  registerCheckpointRuntimeReleasePending,
} from "@/lib/workspace/checkpoint-release";
import { insertFilesystemCheckpoint } from "@/lib/workspace/checkpoint-store";
import {
  type RecoveryAnchor,
  type RecoveryAnchorDeclarations,
  buildRecoveryAnchor,
  computeRecoveryAnchorDigest,
} from "@/lib/workspace/recovery-anchor";
import type { SnapshotStorageReceipt, SnapshotStorageRef } from "@/lib/workspace/snapshot-storage";
import type { WorkspaceBackend } from "@/lib/workspace/workspace-backend";
import { validateWorkspaceContract } from "@/lib/workspace/workspace-contract";
import type { SafePointReceipt } from "@/lib/workspace/workspace-host";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { and, eq } from "drizzle-orm";

export type { RecoveryAnchorDeclarations };

export interface CheckpointProductionResult {
  checkpointId: string;
  manifestRef: string;
  manifestDigest: string;
  contentRootDigest: string;
  /** 解冻各腿的确认状态；只有两腿都确认后 Gate 才回到 open。 */
  release: CheckpointReleaseLegs;
}

export interface CheckpointSafePointEvidence {
  checkpointIntentId: string;
  safePointEvidenceDigest: string;
  writerQuiescenceAchievedAt: Date;
}

export interface CheckpointRequestResult {
  commandId: string;
  checkpointIntentId: string;
  deadline: Date;
  anchorDigest: string;
  /** 服务端构建的锚点（夹具与排障用；生产调用方不需要它）。 */
  recoveryAnchor: RecoveryAnchor;
}

const CHECKPOINT_TIMEOUT_MS = 120_000;
/** 允许的窄时钟偏移：判定"排空回执是否落在本次安全点窗口内"用。 */
const SAFE_POINT_CLOCK_SKEW_MS = 5_000;

/**
 * 排空回执必须被**真正消费**，不能只是参数上存在。
 *
 * - digest 必须是 `sha256:<64hex>` 形状（Runtime 回执的证据摘要，不是自报文本）；
 * - 排空时刻必须落在本次安全点窗口内（不早于请求、不晚于 deadline + 窄偏移），
 *   否则"排空证明"来自另一个窗口，不能用来冻结这次 Snapshot。
 */
function assertSafePointEvidence(evidence: CheckpointSafePointEvidence, deadline: Date): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(evidence.safePointEvidenceDigest))
    throw new Error("CheckpointStale");
  const achievedAt = evidence.writerQuiescenceAchievedAt;
  if (!(achievedAt instanceof Date) || Number.isNaN(achievedAt.getTime()))
    throw new Error("CheckpointStale");
  const earliest = deadline.getTime() - CHECKPOINT_TIMEOUT_MS - SAFE_POINT_CLOCK_SKEW_MS;
  const latest = deadline.getTime() + SAFE_POINT_CLOCK_SKEW_MS;
  if (achievedAt.getTime() < earliest || achievedAt.getTime() > latest)
    throw new Error("CheckpointStale");
}

/**
 * 请求一次可恢复安全点：登记持久意图并进入 quiescing。
 *
 * 锚点由服务端唯一构建器从正式事实推导（§1）。调用方只能提交**待核验声明**：
 * - `unconsumedInputWatermark`：与推导水位不一致即拒绝；
 * - `actionFacts` / `childFacts` / `resolvedUserActionRefs`：只提交引用 id，逐条查库核验。
 * 任何"把完整锚点数组传进来即接受"的路径都已删除。
 */
export async function requestFilesystemCheckpoint(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  declarations?: RecoveryAnchorDeclarations;
  requestedByType: "user" | "service" | "system";
  requestedById: string;
  checkpointIntentId?: string;
}): Promise<CheckpointRequestResult> {
  const checkpointIntentId = input.checkpointIntentId ?? randomUUID();
  return db.transaction(async (tx) => {
    const facts = await lockCheckpointFacts(
      tx,
      input.tenantId,
      input.invocationId,
      input.ownershipId,
    );
    if (facts.invocation.checkpointGate !== "open") throw new Error("CheckpointStale");
    const now = await getAuthorityDatabaseTime(tx);
    if (facts.owner.leaseExpiresAt <= now || facts.owner.executionPhase !== "executing") {
      throw new Error("NotCurrentExecutor");
    }
    const anchor = await buildRecoveryAnchor(
      {
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        ownershipId: input.ownershipId,
        ...(input.declarations ? { declarations: input.declarations } : {}),
      },
      tx,
    );
    const anchorDigest = computeRecoveryAnchorDigest(anchor);
    const deadline = new Date(now.getTime() + CHECKPOINT_TIMEOUT_MS);
    await tx
      .update(invocationTable)
      .set({
        checkpointGate: "quiescing",
        checkpointIntentId,
        checkpointOwnerId: input.ownershipId,
        checkpointDeadline: deadline,
        checkpointProducerSequence: facts.invocation.lastProducerSequence,
        checkpointRecoveryVersion: facts.invocation.recoveryVersion,
        checkpointAnchor: anchor,
        checkpointPreparedEvidence: null,
        versionNo: facts.invocation.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(invocationTable.id, input.invocationId));
    const commandId = await createInvocationCommandInTransaction(tx, {
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      commandType: "checkpoint",
      idempotencyKey: `checkpoint:${checkpointIntentId}`,
      payloadJson: {
        checkpointIntentId,
        deadlineMs: deadline.getTime(),
        recoveryAnchor: anchor,
        recoveryAnchorDigest: anchorDigest,
        declarations: input.declarations ?? {},
      },
      requestedByType: input.requestedByType,
      requestedById: input.requestedById,
    });
    return { commandId, checkpointIntentId, deadline, anchorDigest, recoveryAnchor: anchor };
  });
}

/**
 * 排空后生产并提交持久 Checkpoint。
 *
 * 关键顺序：freeze 之前先按**最新已应用事实**重建锚点（§2 步骤 4），提交事务里再复核
 * 该锚点仍与当前正式事实等价（§2 步骤 7）。请求时写入的旧水位只作为"排空前的水位"
 * 参与比较，不能直接当最终水位。
 */
export async function produceFilesystemCheckpoint(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  backend: WorkspaceBackend;
  /**
   * A06：Snapshot 存储的**可序列化引用**。生产者不持有实例、不假设存储就在本进程 ——
   * 它把引用交给 Backend，由真正拥有该存储能力的一端执行真实 IO。
   */
  storage: SnapshotStorageRef;
  checkpointIntentId: string;
  /** Runtime safe-point receipt obtained before this producer freezes the writer. */
  safePointEvidence: CheckpointSafePointEvidence;
}): Promise<CheckpointProductionResult> {
  const checkpointIntentId = input.checkpointIntentId;
  if (input.safePointEvidence.checkpointIntentId !== checkpointIntentId)
    throw new Error("CheckpointStale");
  const binding = await loadCheckpointFacts(input.tenantId, input.invocationId, input.ownershipId);
  if (
    binding.checkpointGate !== "quiescing" ||
    binding.checkpointIntentId !== checkpointIntentId ||
    binding.checkpointOwnerId !== input.ownershipId ||
    !binding.checkpointDeadline ||
    !binding.checkpointAnchor
  )
    throw new Error("CheckpointStale");
  // timeout 必须在**任何外部副作用之前**判定：安全点已失效时不允许再去冻结 Writer。
  if (binding.checkpointDeadline <= (await getAuthorityDatabaseTime(db))) {
    await abandonFilesystemCheckpoint({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      ownershipId: input.ownershipId,
      checkpointIntentId,
      reasonCode: "CheckpointStale",
    });
    throw new Error("CheckpointStale");
  }
  const declarations = await loadCheckpointDeclarations(
    input.tenantId,
    input.invocationId,
    checkpointIntentId,
  );
  const workspace = await getWorkspaceBindingById(input.tenantId, binding.workspaceBindingId);
  if (!workspace) throw new Error("WorkspaceNotReady");
  const contract = validateWorkspaceContract({
    bindingId: workspace.id,
    continuityMode: workspace.continuityMode,
    contractDigest: workspace.contractDigest,
    storageScopeDigest: workspace.storageScopeDigest,
    hostIdentity: workspace.hostIdentity,
    storageIdentity: workspace.storageIdentity,
    backendKind: workspace.backendKind,
    filesystemSemantics: workspace.filesystemSemantics as never,
    checkpointPolicy: workspace.checkpointPolicy as Record<string, unknown> | null,
  });
  if (contract.continuityMode !== "CHECKPOINT_RESTORABLE") throw new Error("WorkspaceNotReady");
  const grant = await input.backend.host.getWriter(
    contract.storageScopeDigest as string,
    binding.writerGeneration,
  );
  if (!grant || grant.ownershipId !== input.ownershipId) {
    await abandonFilesystemCheckpoint({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      ownershipId: input.ownershipId,
      checkpointIntentId,
      reasonCode: "WorkspaceWriterNotFenced",
    });
    throw new Error("WorkspaceWriterNotFenced");
  }
  let freeze: Awaited<ReturnType<WorkspaceBackend["host"]["freeze"]>> | null = null;
  let committed = false;
  let receipt: SnapshotStorageReceipt;
  try {
    // §2 步骤 4：**排空之后**重建锚点。`safePointEvidence` 是 Runtime 已经走到安全点、
    // Writer 已排空的回执（由 dispatcher 在调用本函数之前取得），所以这一刻的正式事实
    // 才是可恢复边界。请求时写入的旧水位只用于"排空前后是否发生变化"的对照。
    assertSafePointEvidence(input.safePointEvidence, binding.checkpointDeadline);
    const frozenAnchor = await buildRecoveryAnchor(
      {
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        ownershipId: input.ownershipId,
        ...(declarations ? { declarations } : {}),
      },
      db,
    );
    const digest = computeRecoveryAnchorDigest(frozenAnchor);
    // 在物理 freeze 之前先持久登记完整 tuple。若 Broker 已冻结但进程在回执落库前退出，
    // 维护 lane 可据此安全重放/释放同一屏障，而不是把 `freeze=null` 当成“从未冻结”。
    await registerCheckpointFreezeIntent({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      ownershipId: input.ownershipId,
      checkpointIntentId,
      scopeDigest: contract.storageScopeDigest as string,
      writerGeneration: binding.writerGeneration,
      anchorDigest: digest,
      safePointEvidence: input.safePointEvidence,
    });
    freeze = await input.backend.host.freeze({ grant, checkpointIntentId, anchorDigest: digest });
    await freezeCheckpointGate({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      ownershipId: input.ownershipId,
      checkpointIntentId,
      binding,
      frozenAnchor,
      anchorDigest: digest,
      safePointEvidence: input.safePointEvidence,
      freeze,
    });
    receipt = await input.backend.host.snapshot({
      grant,
      checkpointIntentId,
      anchorDigest: digest,
      storage: input.storage,
      // §5：容量上限与已声明 profile 必须来自**已校验的不可变 Binding**，不是调用方入参。
      requirements: {
        checkpointPolicy: workspace.checkpointPolicy as Record<string, unknown> | null,
        filesystemSemantics: workspace.filesystemSemantics as never,
      },
    });
    await recordCheckpointPreparedEvidence({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      ownershipId: input.ownershipId,
      checkpointIntentId,
      receipt,
      freeze,
    });
    const result = await db.transaction(async (tx) => {
      const [invocation] = await tx
        .select()
        .from(invocationTable)
        .where(
          and(
            eq(invocationTable.tenantId, input.tenantId),
            eq(invocationTable.id, input.invocationId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !invocation ||
        invocation.checkpointGate !== "frozen" ||
        invocation.checkpointIntentId !== checkpointIntentId ||
        invocation.checkpointOwnerId !== input.ownershipId ||
        invocation.checkpointDeadline === null ||
        invocation.checkpointDeadline <= (await getAuthorityDatabaseTime(tx)) ||
        invocation.checkpointProducerSequence !== Number(frozenAnchor.producerSequence) ||
        // §2 步骤 7：**当前**恢复事实必须仍与冻结锚点等价。只跟冻结标记自比不够——
        // 若 Snapshot 上传期间又有已消费事实被应用，当前水位会前进，该 Checkpoint 必须
        // 判为陈旧（§3「对 Frozen 期间到达的必要正式子结果，要么让 Checkpoint 失效」）。
        invocation.lastProducerSequence !== Number(frozenAnchor.producerSequence) ||
        invocation.recoveryVersion !== Number(frozenAnchor.recoveryVersion)
      )
        throw new Error("CheckpointStale");
      const [owner] = await tx
        .select()
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, input.tenantId),
            eq(executionOwnershipTable.id, input.ownershipId),
            eq(executionOwnershipTable.ownershipState, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !owner ||
        owner.attemptId !== binding.attemptId ||
        owner.leaseEpoch !== binding.leaseEpoch ||
        owner.leaseExpiresAt <= (await getAuthorityDatabaseTime(tx))
      )
        throw new Error("NotCurrentExecutor");
      const checkpointId = randomUUID();
      const committedAt = await getAuthorityDatabaseTime(tx);
      await insertFilesystemCheckpoint(tx, {
        id: checkpointId,
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        attemptId: binding.attemptId,
        ownershipId: input.ownershipId,
        workspaceBindingId: binding.workspaceBindingId,
        environmentDefinitionRevisionId: binding.environmentDefinitionRevisionId,
        leaseEpoch: binding.leaseEpoch,
        checkpointIntentId,
        writerGeneration: binding.writerGeneration,
        recoveryVersion: Number(frozenAnchor.recoveryVersion),
        producerSequence: Number(frozenAnchor.producerSequence),
        recoveryAnchor: frozenAnchor,
        recoveryAnchorDigest: digest,
        snapshotFormat: "content_manifest",
        manifestRef: receipt.manifestRef,
        manifestDigest: receipt.manifestDigest,
        contentRootDigest: receipt.contentRootDigest,
        fileCount: receipt.fileCount,
        totalBytes: receipt.totalBytes,
        filesystemSemantics: workspace.filesystemSemantics,
        storageEvidence: {
          ...receipt,
          checkpointIntentId,
          writerGeneration: binding.writerGeneration,
          anchorDigest: digest,
          freeze,
        },
        committedAt,
      });
      // §2 步骤 8：Gate 转入 `releasing`，双腿（Runtime / Backend）确认后才回 open。
      await tx
        .update(invocationTable)
        .set({
          checkpointGate: "releasing",
          checkpointIntentId,
          checkpointOwnerId: input.ownershipId,
          checkpointDeadline: null,
          checkpointProducerSequence: Number(frozenAnchor.producerSequence),
          checkpointRecoveryVersion: Number(frozenAnchor.recoveryVersion),
          checkpointAnchor: frozenAnchor,
          checkpointPreparedEvidence: {
            checkpointId,
            anchorDigest: digest,
            freeze,
            release: { runtime: "pending", backend: "pending", registeredAt: committedAt },
          },
          versionNo: invocation.versionNo + 1,
          updatedAt: committedAt,
        })
        .where(eq(invocationTable.id, input.invocationId));
      return {
        checkpointId,
        manifestRef: receipt.manifestRef,
        manifestDigest: receipt.manifestDigest,
        contentRootDigest: receipt.contentRootDigest,
        anchor: frozenAnchor,
      };
    });
    committed = true;
    // §2 步骤 8：解冻是持久工作。先把"Runtime 腿待确认"落库，再真正解冻 Backend；
    // 任一步失败都不会让 Gate 提前放行，维护 lane 会按 intentId 续做。
    await registerCheckpointRuntimeReleasePending({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      checkpointIntentId,
    });
    const release = await confirmCheckpointBackendRelease({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      checkpointIntentId,
      freeze,
      backend: input.backend,
    });
    return {
      checkpointId: result.checkpointId,
      manifestRef: result.manifestRef,
      manifestDigest: result.manifestDigest,
      contentRootDigest: result.contentRootDigest,
      release,
    };
  } catch (error) {
    if (!committed) {
      // 候选未提交：受控放弃。若已经取到 freeze，放弃同样转入 `releasing` 走持久解冻，
      // 不能"只清 gate 不还 Writer"。
      await abandonFilesystemCheckpoint({
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        ownershipId: input.ownershipId,
        checkpointIntentId,
        reasonCode: error instanceof Error ? error.message : "CheckpointStale",
        ...(freeze ? { freeze } : {}),
      }).catch((abandonError: unknown) => {
        console.error("Checkpoint 候选放弃失败，等待维护 lane 收口", abandonError);
      });
    }
    throw error;
  }
}

/** `releasing` 阶段再次进入安全点请求必须先被解冻收口，否则直接陈旧。 */
export function assertCheckpointGateOpen(invocation: Invocation): void {
  if (invocation.checkpointGate !== "open") throw new Error("CheckpointStale");
}

async function loadCheckpointDeclarations(
  tenantId: string,
  invocationId: string,
  checkpointIntentId: string,
): Promise<RecoveryAnchorDeclarations | null> {
  const [command] = await db
    .select({ payloadJson: invocationCommandTable.payloadJson })
    .from(invocationCommandTable)
    .where(
      and(
        eq(invocationCommandTable.tenantId, tenantId),
        eq(invocationCommandTable.invocationId, invocationId),
        eq(invocationCommandTable.idempotencyKey, `checkpoint:${checkpointIntentId}`),
      ),
    )
    .limit(1);
  const payload = command?.payloadJson as { declarations?: RecoveryAnchorDeclarations } | undefined;
  return payload?.declarations ?? null;
}

async function freezeCheckpointGate(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  checkpointIntentId: string;
  binding: Awaited<ReturnType<typeof loadCheckpointFacts>>;
  frozenAnchor: RecoveryAnchor;
  anchorDigest: string;
  safePointEvidence: CheckpointSafePointEvidence;
  freeze: Awaited<ReturnType<WorkspaceBackend["host"]["freeze"]>>;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    const [owner] = await tx
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.id, input.ownershipId),
          eq(executionOwnershipTable.ownershipState, "active"),
        ),
      )
      .for("update")
      .limit(1);
    const now = await getAuthorityDatabaseTime(tx);
    if (
      !invocation ||
      !owner ||
      owner.attemptId !== input.binding.attemptId ||
      owner.leaseEpoch !== input.binding.leaseEpoch ||
      owner.leaseExpiresAt <= now ||
      invocation.checkpointGate !== "quiescing" ||
      invocation.checkpointIntentId !== input.checkpointIntentId ||
      invocation.checkpointOwnerId !== input.ownershipId ||
      invocation.checkpointDeadline === null ||
      invocation.checkpointDeadline <= now
    )
      throw new Error("CheckpointStale");
    await tx
      .update(invocationTable)
      .set({
        checkpointGate: "frozen",
        // 冻结的是**重建后**的锚点；这一刻的水位才是可恢复边界。
        checkpointAnchor: input.frozenAnchor,
        checkpointProducerSequence: Number(input.frozenAnchor.producerSequence),
        checkpointRecoveryVersion: Number(input.frozenAnchor.recoveryVersion),
        checkpointPreparedEvidence: {
          ...(invocation.checkpointPreparedEvidence as Record<string, unknown> | null),
          safePoint: input.safePointEvidence,
          anchorDigest: input.anchorDigest,
          freeze: input.freeze,
        },
        versionNo: invocation.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(invocationTable.id, invocation.id));
  });
}

async function registerCheckpointFreezeIntent(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  checkpointIntentId: string;
  scopeDigest: string;
  writerGeneration: number;
  anchorDigest: string;
  safePointEvidence: CheckpointSafePointEvidence;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !invocation ||
      invocation.checkpointGate !== "quiescing" ||
      invocation.checkpointIntentId !== input.checkpointIntentId ||
      invocation.checkpointOwnerId !== input.ownershipId
    ) {
      throw new Error("CheckpointStale");
    }
    const now = await getAuthorityDatabaseTime(tx);
    await tx
      .update(invocationTable)
      .set({
        checkpointPreparedEvidence: {
          ...(invocation.checkpointPreparedEvidence as Record<string, unknown> | null),
          safePoint: input.safePointEvidence,
          anchorDigest: input.anchorDigest,
          freezeIntent: {
            checkpointIntentId: input.checkpointIntentId,
            scopeDigest: input.scopeDigest,
            writerGeneration: input.writerGeneration,
            anchorDigest: input.anchorDigest,
            registeredAt: now.toISOString(),
          },
        },
        versionNo: invocation.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(invocationTable.id, invocation.id));
  });
}

async function recordCheckpointPreparedEvidence(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  checkpointIntentId: string;
  receipt: SnapshotStorageReceipt;
  freeze: unknown;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !invocation ||
      invocation.checkpointGate !== "frozen" ||
      invocation.checkpointIntentId !== input.checkpointIntentId ||
      invocation.checkpointOwnerId !== input.ownershipId
    )
      throw new Error("CheckpointStale");
    await tx
      .update(invocationTable)
      .set({
        checkpointPreparedEvidence: { receipt: input.receipt, freeze: input.freeze },
        versionNo: invocation.versionNo + 1,
        updatedAt: await getAuthorityDatabaseTime(tx),
      })
      .where(eq(invocationTable.id, invocation.id));
  });
}

/**
 * 受控放弃一个未提交的候选。
 *
 * 若该候选已经冻结过 Writer（`freeze` 非空），Gate 进入 `releasing` 而不是 `open`：
 * 文件 Generation 还在冻结中，必须先持久解冻；维护 lane 会按 intentId 续做。
 * 没有 freeze 的失败路径（deadline 过期、Owner 被取代、Writer 未 fence）没有东西要解冻，
 * 直接回 open，不留无法退出的屏障。
 */
export async function abandonFilesystemCheckpoint(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  checkpointIntentId: string;
  reasonCode: string;
  freeze?: Awaited<ReturnType<WorkspaceBackend["host"]["freeze"]>>;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !invocation ||
      invocation.checkpointIntentId !== input.checkpointIntentId ||
      invocation.checkpointOwnerId !== input.ownershipId
    )
      return;
    const evidence = (invocation.checkpointPreparedEvidence ?? {}) as Record<string, unknown>;
    const persistedFreeze = readPersistedFreeze(evidence);
    const freeze = input.freeze ?? persistedFreeze;
    const committed = typeof evidence.checkpointId === "string";
    const nextGate =
      freeze || committed || invocation.checkpointGate === "releasing" ? "releasing" : "open";
    const currentRelease =
      evidence.release && typeof evidence.release === "object" ? evidence.release : null;
    await tx
      .update(invocationTable)
      .set({
        checkpointGate: nextGate,
        checkpointIntentId: nextGate === "releasing" ? input.checkpointIntentId : null,
        checkpointOwnerId: nextGate === "releasing" ? input.ownershipId : null,
        checkpointDeadline: null,
        checkpointPreparedEvidence: {
          ...evidence,
          failureCode: input.reasonCode,
          ...(freeze ? { freeze } : {}),
          ...(nextGate === "releasing"
            ? { release: currentRelease ?? { runtime: "pending", backend: "pending" } }
            : {}),
        },
        versionNo: invocation.versionNo + 1,
        updatedAt: await getAuthorityDatabaseTime(tx),
      })
      .where(eq(invocationTable.id, invocation.id));
  });
}

function readPersistedFreeze(evidence: Record<string, unknown>): SafePointReceipt | undefined {
  const value = evidence.freeze ?? evidence.freezeIntent;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<SafePointReceipt>;
  if (
    typeof candidate.checkpointIntentId !== "string" ||
    typeof candidate.scopeDigest !== "string" ||
    typeof candidate.writerGeneration !== "number" ||
    typeof candidate.anchorDigest !== "string"
  ) {
    return undefined;
  }
  return {
    checkpointIntentId: candidate.checkpointIntentId,
    scopeDigest: candidate.scopeDigest,
    writerGeneration: candidate.writerGeneration,
    anchorDigest: candidate.anchorDigest,
    frozenAt:
      typeof candidate.frozenAt === "string" ? candidate.frozenAt : new Date(0).toISOString(),
  };
}

async function loadCheckpointFacts(tenantId: string, invocationId: string, ownershipId: string) {
  return db.transaction((tx) => lockCheckpointFacts(tx, tenantId, invocationId, ownershipId));
}

async function lockCheckpointFacts(
  tx: DbOrTx,
  tenantId: string,
  invocationId: string,
  ownershipId: string,
) {
  const [invocation] = await tx
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .for("update")
    .limit(1);
  if (!invocation) throw new Error("NotCurrentExecutor");
  const [owner] = await tx
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.id, ownershipId),
        eq(executionOwnershipTable.invocationId, invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .for("update")
    .limit(1);
  if (!owner) throw new Error("NotCurrentExecutor");
  const [attempt] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, tenantId),
        eq(invocationAttemptTable.id, owner.attemptId),
        eq(invocationAttemptTable.invocationId, invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const [binding] = await tx
    .select()
    .from(executionBindingTable)
    .where(
      and(
        eq(executionBindingTable.tenantId, tenantId),
        eq(executionBindingTable.invocationId, invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const [session] = await tx
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.ownershipId, owner.id),
      ),
    )
    .for("update")
    .limit(1);
  const [environmentLease] = owner.environmentLeaseId
    ? await tx
        .select()
        .from(environmentLeaseTable)
        .where(
          and(
            eq(environmentLeaseTable.tenantId, tenantId),
            eq(environmentLeaseTable.id, owner.environmentLeaseId),
            eq(environmentLeaseTable.invocationId, invocationId),
            eq(environmentLeaseTable.attemptId, owner.attemptId),
          ),
        )
        .for("update")
        .limit(1)
    : [];
  if (
    !attempt ||
    !binding ||
    binding.environmentMode !== "MANAGED" ||
    !binding.environmentDefinitionRevisionId ||
    owner.workspaceWriterGeneration === null ||
    !session ||
    session.invocationId !== invocationId ||
    session.attemptId !== owner.attemptId ||
    session.leaseEpoch !== owner.leaseEpoch ||
    session.runtimeRevisionId !== binding.runtimeRevisionId ||
    session.bindingState !== "active" ||
    !environmentLease ||
    environmentLease.environmentDefinitionRevisionId !== binding.environmentDefinitionRevisionId ||
    environmentLease.leaseState !== "active" ||
    environmentLease.readinessState !== "ready" ||
    environmentLease.activationOwnershipId !== owner.id
  ) {
    throw new Error("CheckpointStale");
  }
  return {
    invocation,
    owner,
    attempt,
    binding,
    session,
    environmentLease,
    workspaceBindingId: binding.workspaceBindingId,
    environmentDefinitionRevisionId: binding.environmentDefinitionRevisionId,
    attemptId: attempt.id,
    leaseEpoch: owner.leaseEpoch,
    writerGeneration: owner.workspaceWriterGeneration,
    recoveryVersion: invocation.recoveryVersion,
    lastProducerSequence: invocation.lastProducerSequence,
    checkpointGate: invocation.checkpointGate,
    checkpointIntentId: invocation.checkpointIntentId,
    checkpointOwnerId: invocation.checkpointOwnerId,
    checkpointDeadline: invocation.checkpointDeadline,
    checkpointAnchor: invocation.checkpointAnchor,
  };
}
