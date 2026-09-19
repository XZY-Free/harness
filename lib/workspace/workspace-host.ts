/**
 * WorkspaceHost 契约 + 受管实现出口。
 *
 * 真实实现（真实身份探测、进程组终止与排空、稳定 operation 回执、跨租户物理隔离）
 * 位于 `lib/workspace/workspace-host-server.ts`；本文件只保留契约，并把实现转出去，
 * 避免出现"一个修复、两个版本"。
 */
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";
import type {
  SnapshotRequirements,
  SnapshotStorageReceipt,
  SnapshotStorageRef,
} from "@/lib/workspace/snapshot-storage";
import { createWorkspaceHostBroker } from "@/lib/workspace/workspace-host-server";
import type { WriterStopEvidence } from "@/lib/workspace/workspace-host-server";

export type {
  WorkspaceHostBroker,
  WorkspaceHostIdentityProbe,
  WriterStopEvidence,
} from "@/lib/workspace/workspace-host-server";
export {
  WorkspaceCleanupRejectedError,
  WorkspaceHostBroker as ManagedWorkspaceHost,
  WorkspaceIdentityMismatchError,
  WorkspaceTenantConflictError,
  WorkspaceWriterNotFencedError,
  createRemoteWorkspaceHost,
  createWorkspaceHostBroker,
  createWorkspaceHostRpcServer,
  listenWorkspaceHostRpc,
} from "@/lib/workspace/workspace-host-server";

export interface WorkspacePreparation {
  resourceId: string;
  candidateRoot: string;
  operationId: string;
  candidateAttemptId: string;
  revisionId: string;
  workspaceBindingId: string;
}

export interface WorkspaceWriterGrant {
  scopeDigest: string;
  writerGeneration: number;
  invocationId: string;
  attemptId: string;
  ownershipId: string;
  leaseEpoch: string;
  grantRef: string;
  root: string;
  operationId: string;
  oldWriterRevoked: boolean;
  backendEvidence: Record<string, unknown>;
}

/**
 * A07 决策五：物理 Writer 的**精确归属身份**。
 *
 * 复审报告的原始缺陷是"A 的激活成功后，B 的失败补偿只凭一个 generation 数字就把 A 的
 * 健康 Writer 停掉"。因此撤销契约不接受 `(scopeDigest, writerGeneration)` 这种位置参数 ——
 * 那正是"按编号停别人"的形态；调用方必须交出这段物理写资源**属于谁**。
 *
 * 这里只列 Broker **真实持久且能逐项复核**的字段（`workspace-scope.json` 的租户归属 +
 * `grants/<generation>.json` 的授予快照）。刻意**不**包含控制面的 `lockId` 与 `leaseEpoch`：
 *
 * - `leaseEpoch` 不落 Broker，但它被 `operationId` 传递绑定（`writer-activate:…:epoch:<n>`），
 *   而 `operationId` 是逐字核对的；
 * - `lockId` 是控制面主键，物理 Host 侧没有对应事实可核。
 *
 * 加一个核对不了的字段只会制造"已经核对过"的假象，比不写更危险；偏离设计稿九元组的部分
 * 按 BASELINE.md 偏差规则记录在 `implementation-result.json`。
 */
export interface WorkspaceWriterIdentity {
  tenantId: string;
  scopeDigest: string;
  writerGeneration: number;
  invocationId: string;
  attemptId: string;
  ownershipId: string;
  operationId: string;
}

/**
 * 受管文件操作的**受限**形态（A07 决策六）。
 *
 * 只有"写一个相对路径"和"删一个相对路径"两种 —— 控制端口因此不会退化成任意管理命令
 * 执行接口。路径必须落在该代际 grant 的受管根内。
 */
export type ManagedFileOperation =
  | { kind: "write"; path: string; content: string }
  | { kind: "delete"; path: string };

export interface ManagedFileOperationResult {
  kind: ManagedFileOperation["kind"];
  /** 本次实际落盘/删除的绝对路径；只是这次操作的事实，调用方不得据此长期缓存写权。 */
  path: string;
}

export interface SafePointReceipt {
  checkpointIntentId: string;
  scopeDigest: string;
  writerGeneration: number;
  anchorDigest: string;
  frozenAt: string;
}

export interface WorkspaceHost {
  prepare(input: {
    candidateAttemptId: string;
    revisionId: string;
    workspaceBindingId: string;
    operationId: string;
  }): Promise<WorkspacePreparation>;
  activateWriter(input: {
    tenantId: string;
    scopeDigest: string;
    writerGeneration: number;
    authority: AuthorityIdentity;
    expectedStorageIdentity: string;
    operationId: string;
    root: string;
  }): Promise<WorkspaceWriterGrant>;
  getWriter(scopeDigest: string, writerGeneration: number): Promise<WorkspaceWriterGrant | null>;
  assertWriter(grant: WorkspaceWriterGrant): Promise<void>;
  /**
   * 真实停止**该精确归属**的受管 Writer 进程组并返回可核验证据。
   *
   * 身份与持久归属不符时**不做任何物理停止**（fail closed，抛 `WorkspaceWriterNotFenced`）：
   * 迟到的失败补偿因此不可能误杀接管后的健康 Writer。
   */
  revokeWriterGeneration(identity: WorkspaceWriterIdentity): Promise<WriterStopEvidence>;
  /**
   * 受管 File 写/删的**唯一入口**（A07 决策六）。
   *
   * 与 `authorizeWrite` 的关键差别：后者把可写根**交回**调用方，调用方可以稍后再写 ——
   * 冻结若落在"发回路径"与"实际 IO"之间，那次写就绕过了屏障。本入口把 IO 放进 scope
   * 临界区：取锁 → 复核完整归属/冻结/撤销/未确认停止的更旧写者 → 立刻完成 IO。
   */
  executeManagedFileOperation(input: {
    identity: WorkspaceWriterIdentity;
    operation: ManagedFileOperation;
  }): Promise<ManagedFileOperationResult>;
  freeze(input: {
    grant: WorkspaceWriterGrant;
    checkpointIntentId: string;
    anchorDigest: string;
  }): Promise<SafePointReceipt>;
  releaseFreeze(receipt: SafePointReceipt): Promise<void>;
  snapshot(input: {
    grant: WorkspaceWriterGrant;
    checkpointIntentId: string;
    anchorDigest: string;
    /**
     * A06：**可序列化**引用，绝不是带方法的实例 —— 该方法可能经控制端口 RPC 跨进程调用。
     * 省略时由 Broker 使用自己持有的默认存储。
     */
    storage?: SnapshotStorageRef;
    /** CHECKPOINT_RESTORABLE 的容量上限与已声明 filesystem profile（fail-closed 必需）。 */
    requirements: SnapshotRequirements;
  }): Promise<SnapshotStorageReceipt>;
  restore(input: {
    manifestRef: string;
    manifestDigest: string;
    destination: string;
    /** A06：同 `snapshot`；真实 IO 在执行该方法的进程内完成。 */
    storage?: SnapshotStorageRef;
    operationId?: string;
    requirements?: SnapshotRequirements;
  }): Promise<void>;
  cleanup(preparation: WorkspacePreparation): Promise<void>;
}

/** 构造受管 WorkspaceHost（身份持久化，进程重启不换身份）。 */
export function createManagedWorkspaceHost(root: string): WorkspaceHost {
  return createWorkspaceHostBroker({ root });
}
