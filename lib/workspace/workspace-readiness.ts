/**
 * Workspace Readiness 不是类型校验（R08 §6）。
 *
 * 必须同时成立：
 * - WorkspaceBinding 契约自洽（含 contractDigest 重算）；
 * - Current Ownership 就是该 ownershipId 且未过期；
 * - Managed Environment 的 Lease 已 ready 且属于本次 Ownership；
 * - activationEvidence 与其 digest 自洽，且 writerGeneration 与 Current Owner 一致；
 * - Backend 能真实回读出该代际的 Writer grant，并且该 grant 仍是当前 writer；
 * - 恢复锚点（若本轮是恢复）与 Owner 记录一致。
 */
import { getEnvironmentLeaseById } from "@/lib/environment/environment-lease-store";
import { getActiveExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { validateWorkspaceContract } from "@/lib/workspace/workspace-contract";
import type { WorkspaceHost } from "@/lib/workspace/workspace-host";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";

export interface WorkspaceReadinessEvidence {
  bindingId: string;
  continuityMode: string;
  writerGeneration: number | null;
  scopeDigest: string | null;
  storageIdentity: string | null;
  grantRef: string | null;
  environmentLeaseId: string | null;
}

export async function requireWorkspaceReadiness(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  workspaceBindingId: string;
  expectedWriterGeneration?: number | null;
  /** Backend 端口：平台 Workspace 必须提供，用真实回执校验而不是纯 DB 关系。 */
  backend?: Pick<WorkspaceHost, "getWriter" | "assertWriter"> | null;
  /** 若本轮是恢复启动，调用方冻结的恢复锚点摘要。 */
  recoveryAnchorDigest?: string | null;
  expectedActivationDigest?: string | null;
}): Promise<WorkspaceReadinessEvidence> {
  const binding = await getWorkspaceBindingById(input.tenantId, input.workspaceBindingId);
  if (!binding) throw new Error("WorkspaceNotReady");
  const contract = validateWorkspaceContract({
    bindingId: binding.id,
    continuityMode: binding.continuityMode,
    contractDigest: binding.contractDigest,
    storageScopeDigest: binding.storageScopeDigest,
    hostIdentity: binding.hostIdentity,
    storageIdentity: binding.storageIdentity,
    backendKind: binding.backendKind,
    filesystemSemantics: binding.filesystemSemantics as never,
    checkpointPolicy: binding.checkpointPolicy as Record<string, unknown> | null,
  });
  const owner = await getActiveExecutionOwnership({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
  });
  if (!owner || owner.id !== input.ownershipId) throw new Error("NotCurrentExecutor");
  if (owner.leaseExpiresAt <= new Date()) throw new Error("NotCurrentExecutor");
  // 准备/激活证据必须自洽：调用方不能拿一份字段被改过的 row 冒充证据。
  const activationEvidence = owner.activationEvidence as Record<string, unknown> | null;
  if (!activationEvidence || !owner.activationDigest) throw new Error("WorkspaceNotReady");
  if (owner.activationDigest !== protocolDigest(activationEvidence)) {
    throw new Error("WorkspaceNotReady");
  }
  if (input.expectedActivationDigest && owner.activationDigest !== input.expectedActivationDigest) {
    throw new Error("WorkspaceNotReady");
  }
  if (owner.environmentLeaseId) {
    const lease = await getEnvironmentLeaseById(input.tenantId, owner.environmentLeaseId);
    if (
      !lease ||
      lease.leaseState !== "active" ||
      lease.readinessState !== "ready" ||
      lease.activationOwnershipId !== input.ownershipId ||
      !lease.preparedDigest ||
      lease.expiresAt <= new Date()
    ) {
      throw new Error("EnvironmentNotReady");
    }
  }
  if (contract.continuityMode === "NO_PLATFORM_WORKSPACE") {
    return {
      bindingId: binding.id,
      continuityMode: binding.continuityMode,
      writerGeneration: null,
      scopeDigest: null,
      storageIdentity: null,
      grantRef: null,
      environmentLeaseId: owner.environmentLeaseId ?? null,
    };
  }
  const scopeDigest = contract.storageScopeDigest as string;
  const generation = owner.workspaceWriterGeneration;
  if (generation === null || generation === undefined) throw new Error("WorkspaceNotReady");
  if (
    input.expectedWriterGeneration !== undefined &&
    input.expectedWriterGeneration !== null &&
    generation !== input.expectedWriterGeneration
  ) {
    throw new Error("WorkspaceWriterNotFenced");
  }
  if (!input.backend) throw new Error("WorkspaceNotReady");
  // Backend 真实回读：只有该代际仍是当前 writer 才算就绪。
  const grant = await input.backend.getWriter(scopeDigest, generation);
  if (!grant) throw new Error("WorkspaceWriterNotFenced");
  await input.backend.assertWriter(grant);
  if (grant.scopeDigest !== scopeDigest || grant.writerGeneration !== generation) {
    throw new Error("WorkspaceWriterNotFenced");
  }
  const workspaceEvidence = activationEvidence.workspace as
    | { writerGeneration?: number | null; grantRef?: string | null; restoration?: unknown }
    | undefined;
  if (
    workspaceEvidence?.writerGeneration != null &&
    workspaceEvidence.writerGeneration !== generation
  ) {
    throw new Error("WorkspaceWriterNotFenced");
  }
  if (workspaceEvidence?.grantRef && workspaceEvidence.grantRef !== grant.grantRef) {
    throw new Error("WorkspaceWriterNotFenced");
  }
  if (input.recoveryAnchorDigest) {
    const restoration = workspaceEvidence?.restoration as { manifestDigest?: string } | undefined;
    if (!restoration || restoration.manifestDigest !== input.recoveryAnchorDigest) {
      throw new Error("CheckpointStale");
    }
  }
  return {
    bindingId: binding.id,
    continuityMode: binding.continuityMode,
    writerGeneration: generation,
    scopeDigest,
    storageIdentity: contract.storageIdentity,
    grantRef: grant.grantRef,
    environmentLeaseId: owner.environmentLeaseId ?? null,
  };
}
