import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import {
  type FilesystemSemantics,
  type WorkspaceMode,
  WorkspaceModeSchema,
} from "@/lib/runtime/runtime-protocol";

export interface WorkspaceContinuityContract {
  bindingId: string;
  continuityMode: WorkspaceMode;
  contractDigest: string;
  storageScopeDigest: string | null;
  hostIdentity: string | null;
  storageIdentity: string | null;
  backendKind: string | null;
  filesystemSemantics: FilesystemSemantics;
  checkpointPolicy: Record<string, unknown> | null;
}

export class WorkspaceContinuityError extends Error {
  constructor(code: string, message: string) {
    super(message);
    this.name = code;
  }
}

export function computeWorkspaceContractDigest(
  input: Omit<WorkspaceContinuityContract, "contractDigest">,
): string {
  return computeCanonicalDigest({
    continuityMode: input.continuityMode,
    storageScopeDigest: input.storageScopeDigest,
    hostIdentity: input.hostIdentity,
    storageIdentity: input.storageIdentity,
    backendKind: input.backendKind,
    filesystemSemantics: input.filesystemSemantics,
    checkpointPolicy: input.checkpointPolicy,
  });
}

export function validateWorkspaceContract(
  contract: WorkspaceContinuityContract,
): WorkspaceContinuityContract {
  if (!contract.bindingId)
    throw new WorkspaceContinuityError("WorkspaceNotReady", "WorkspaceBinding id 不能为空");
  const mode = WorkspaceModeSchema.safeParse(contract.continuityMode);
  if (!mode.success)
    throw new WorkspaceContinuityError("WorkspaceNotReady", "Workspace continuityMode 非法");
  if (!contract.filesystemSemantics || typeof contract.filesystemSemantics !== "object") {
    throw new WorkspaceContinuityError("WorkspaceNotReady", "Workspace filesystemSemantics 缺失");
  }
  if (mode.data === "NO_PLATFORM_WORKSPACE") {
    if (
      contract.storageScopeDigest ||
      contract.hostIdentity ||
      contract.storageIdentity ||
      contract.backendKind ||
      contract.checkpointPolicy
    ) {
      throw new WorkspaceContinuityError(
        "WorkspaceNotReady",
        "NO_PLATFORM_WORKSPACE 不得携带平台资源定位",
      );
    }
    if (contract.filesystemSemantics.kind !== "none") {
      throw new WorkspaceContinuityError(
        "WorkspaceNotReady",
        "NO_PLATFORM_WORKSPACE 必须使用 none filesystem semantics",
      );
    }
  } else {
    if (!contract.storageScopeDigest || !contract.backendKind || !contract.storageIdentity) {
      throw new WorkspaceContinuityError(
        "WorkspaceNotReady",
        "平台 WorkspaceBinding 缺少持久资源身份",
      );
    }
    if (mode.data === "HOST_AFFINE" && !contract.hostIdentity) {
      throw new WorkspaceContinuityError(
        "ContinuityUnproven",
        "HOST_AFFINE WorkspaceBinding 缺少 hostIdentity",
      );
    }
    if (mode.data === "CHECKPOINT_RESTORABLE" && !contract.checkpointPolicy) {
      throw new WorkspaceContinuityError(
        "WorkspaceNotReady",
        "CHECKPOINT_RESTORABLE 缺少 checkpointPolicy",
      );
    }
    if (mode.data !== "CHECKPOINT_RESTORABLE" && contract.checkpointPolicy) {
      throw new WorkspaceContinuityError(
        "WorkspaceNotReady",
        "非Checkpoint模式不得携带 checkpointPolicy",
      );
    }
  }
  const expected = computeWorkspaceContractDigest(contract);
  if (contract.contractDigest !== expected) {
    throw new WorkspaceContinuityError(
      "WorkspaceNotReady",
      "WorkspaceBinding contractDigest 不匹配",
    );
  }
  return contract;
}

export function assertWorkspaceContinuity(
  contract: WorkspaceContinuityContract,
  actual: {
    hostIdentity?: string | null;
    storageIdentity?: string | null;
    storageScopeDigest?: string | null;
  },
): void {
  validateWorkspaceContract(contract);
  if (contract.continuityMode === "NO_PLATFORM_WORKSPACE") return;
  if (
    contract.storageScopeDigest !== actual.storageScopeDigest ||
    contract.storageIdentity !== actual.storageIdentity
  ) {
    throw new WorkspaceContinuityError(
      "ContinuityUnproven",
      "实际 Workspace 存储身份与不可变 Binding 不一致",
    );
  }
  if (contract.continuityMode === "HOST_AFFINE" && contract.hostIdentity !== actual.hostIdentity) {
    throw new WorkspaceContinuityError(
      "ContinuityUnproven",
      "HOST_AFFINE Workspace 不能跨 Host 恢复",
    );
  }
}
