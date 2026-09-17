/**
 * WorkspaceHost 契约 + 受管实现出口。
 *
 * 真实实现（真实身份探测、进程组终止与排空、稳定 operation 回执、跨租户物理隔离）
 * 位于 `lib/workspace/workspace-host-server.ts`；本文件只保留契约，并把实现转出去，
 * 避免出现"一个修复、两个版本"。
 */
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";
import type { SnapshotStorage, SnapshotStorageReceipt } from "@/lib/workspace/snapshot-storage";
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
  /** 真实停止某代际的受管 Writer 进程组并返回可核验证据。 */
  revokeWriterGeneration(
    scopeDigest: string,
    writerGeneration: number,
  ): Promise<WriterStopEvidence>;
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
    storage?: SnapshotStorage;
  }): Promise<SnapshotStorageReceipt>;
  restore(input: {
    manifestRef: string;
    manifestDigest: string;
    destination: string;
    storage?: SnapshotStorage;
  }): Promise<void>;
  cleanup(preparation: WorkspacePreparation): Promise<void>;
}

/** 构造受管 WorkspaceHost（身份持久化，进程重启不换身份）。 */
export function createManagedWorkspaceHost(root: string): WorkspaceHost {
  return createWorkspaceHostBroker({ root });
}
