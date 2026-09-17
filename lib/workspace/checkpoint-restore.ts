import { mkdir } from "node:fs/promises";
import path from "node:path";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { getFilesystemCheckpoint } from "@/lib/workspace/checkpoint-store";
import { assertRestoreBoundary, parseRecoveryAnchor } from "@/lib/workspace/recovery-anchor";
import { FileSnapshotStorage } from "@/lib/workspace/snapshot-storage";
import type { WorkspaceBackend } from "@/lib/workspace/workspace-backend";
import { validateWorkspaceContract } from "@/lib/workspace/workspace-contract";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";

/**
 * 恢复期望值——必须是**Current Invocation 的正式事实**，不是 Checkpoint 自己的记载。
 *
 * §4：`checkpointRecoveryVersion` / `checkpointProducerSequence` 只是该 Checkpoint 创建时的
 * 记载，拿它们与 Checkpoint 自己比较是恒真的，不能用来证明"现在仍然一致"。
 */
export interface CheckpointRestoreExpectation {
  invocationId: string;
  workspaceBindingId: string;
  environmentDefinitionRevisionId: string;
  /**
   * **当前** Invocation 的 `recoveryVersion`。
   *
   * 这里要求 Checkpoint 记载的水位与当前水位相等：§3 推进表里的任一事实（已被正式
   * 消费的新输入、被应用的行动/Effect 结果、被采用的 Job step 结果等）在 Checkpoint
   * 之后被应用，水位就会前进，该 Checkpoint 即判定陈旧。反之，未消费输入与控制
   * 元数据不推进水位，因此不会误伤"原锚点恢复后再消费新输入"这条路径。
   */
  recoveryVersion: number;
}

export async function restoreFilesystemCheckpoint(input: {
  tenantId: string;
  checkpointId: string;
  destination: string;
  storageRoot: string;
  backend?: WorkspaceBackend;
  expected: CheckpointRestoreExpectation;
}): Promise<{
  checkpointId: string;
  destination: string;
  manifestDigest: string;
  /** 该 Checkpoint 的水位；恢复后从这里之后继续消费新输入。 */
  replayFromProducerSequence: number;
}> {
  const checkpoint = await getFilesystemCheckpoint(input.tenantId, input.checkpointId);
  if (!checkpoint) throw new Error("CheckpointStale");
  if (
    checkpoint.invocationId !== input.expected.invocationId ||
    checkpoint.workspaceBindingId !== input.expected.workspaceBindingId ||
    checkpoint.environmentDefinitionRevisionId !== input.expected.environmentDefinitionRevisionId
  ) {
    throw new Error("CheckpointStale");
  }
  // Checkpoint 自身必须自洽：锚点内容与其 digest 一致，防止被篡改的锚点冒充已提交事实。
  const anchor = parseRecoveryAnchor(checkpoint.recoveryAnchor);
  if (!anchor || protocolDigest(anchor) !== checkpoint.recoveryAnchorDigest) {
    throw new Error("CheckpointIntegrityFailed");
  }
  // §4：不能拿 Checkpoint 记载的 recoveryVersion 与它自己比。这里从**当前**正式事实
  // （Binding 摘要、RuntimeEventIngress 账本、Invocation 水位）重建允许的恢复边界，
  // 再与完整 Anchor 逐项核对；已应用的行动/Job step 结果一旦越过锚点即 CheckpointStale。
  await assertRestoreBoundary({
    tenantId: input.tenantId,
    invocationId: checkpoint.invocationId,
    anchor,
  });
  if (checkpoint.recoveryVersion !== input.expected.recoveryVersion) {
    throw new Error("CheckpointStale");
  }
  const binding = await getWorkspaceBindingById(input.tenantId, checkpoint.workspaceBindingId);
  if (!binding) throw new Error("CheckpointStale");
  validateWorkspaceContract({
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
  await mkdir(path.dirname(input.destination), { recursive: true });
  const storage = new FileSnapshotStorage(input.storageRoot);
  const requirements = {
    checkpointPolicy: binding.checkpointPolicy as Record<string, unknown> | null,
    filesystemSemantics: binding.filesystemSemantics as never,
  };
  if (input.backend)
    await input.backend.host.restore({
      manifestRef: checkpoint.manifestRef,
      manifestDigest: checkpoint.manifestDigest,
      destination: input.destination,
      storage,
      // §7：staging generation 按 operation 唯一；重试用同一 operationId 复核归属。
      operationId: checkpoint.checkpointIntentId,
      requirements,
    });
  else
    await storage.restoreSnapshot(
      await storage.readManifest(checkpoint.manifestRef, checkpoint.manifestDigest, requirements),
      input.destination,
      checkpoint.checkpointIntentId,
      requirements,
    );
  return {
    checkpointId: checkpoint.id,
    destination: input.destination,
    manifestDigest: checkpoint.manifestDigest,
    replayFromProducerSequence: checkpoint.producerSequence,
  };
}
