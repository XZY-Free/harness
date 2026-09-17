import { createHash } from "node:crypto";
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import { computeWorkspaceContractDigest } from "@/lib/workspace/workspace-contract";
import { createWorkspaceBinding, getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";

export { getWorkspaceBindingById };

/**
 * 退化 no-platform 契约的稳定身份。
 *
 * `NO_PLATFORM_WORKSPACE` 的语义完全由 (continuityMode, filesystemSemantics) 决定，
 * 不含任何 Job / Thread 专属信息，因此它的正确模型是**租户级稳定事实**，而不是
 * "每次解析铸造一行新记录"。派生 id 让重复与并发解析落到同一行：
 * R06 §2 要求重复调度返回已冻结关联，若每次换一个新的 WorkspaceBinding id，
 * 同一 Job 的冻结执行语义会随解析次数漂移，幂等重投会被误判为语义冲突。
 */
function noPlatformWorkspaceBindingId(tenantId: string, createdBy: string): string {
  const hex = createHash("sha256")
    .update(`no-platform-workspace\u0000${tenantId}\u0000${createdBy}`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex
    .slice(16, 20)
    .join("")}-${hex.slice(20).join("")}`;
}

/** Creates the explicit no-platform continuity contract used by cloud executions. */
export async function createNoPlatformWorkspaceBinding(
  tenantId: string,
  createdBy: string,
): Promise<WorkspaceBinding> {
  const semantics = {
    kind: "none",
    caseSensitive: true,
    symlinks: false,
    permissions: false,
    hardlinks: false,
    specialFiles: false,
    xattrsAcl: false,
    mtime: "not_applicable",
  };
  const contract = {
    bindingId: "pending",
    continuityMode: "NO_PLATFORM_WORKSPACE" as const,
    storageScopeDigest: null,
    hostIdentity: null,
    storageIdentity: null,
    backendKind: null,
    filesystemSemantics: semantics,
    checkpointPolicy: null,
  };
  return createWorkspaceBinding({
    // 稳定身份：同一 (tenant, creator) 的退化契约只有一行。
    id: noPlatformWorkspaceBindingId(tenantId, createdBy),
    tenantId,
    workspaceId: null,
    continuityMode: contract.continuityMode,
    bindingType: null,
    filesystemSemantics: semantics,
    contractDigest: computeWorkspaceContractDigest(contract),
    createdBy,
  });
}
