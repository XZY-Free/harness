import { runtimeConfig } from "@/lib/config";
import { getDeviceById } from "@/lib/identity/device-queries";
import { workspaceRoot } from "@/lib/workspace";
import { getWorkspaceBindingById, getWorkspaceById } from "@/lib/workspace/workspace-queries";
import { resolveNetworkPolicy } from "./network-policy";
import { resolveQuota } from "./quota";
import type { ToolExecutionTarget } from "./tool-execution-target";

export async function resolveToolExecutionTarget(input: {
  tenantId: string;
  threadId: string;
  workspaceBindingId: string | null;
  ownerUserId: string;
}): Promise<ToolExecutionTarget | null> {
  if (input.workspaceBindingId) {
    const binding = await getWorkspaceBindingById(input.tenantId, input.workspaceBindingId);
    if (!binding) return null;
    if (!binding.workspaceId) return null;
    const workspace = await getWorkspaceById(input.tenantId, binding.workspaceId);
    if (
      !workspace ||
      workspace.lifecycleState !== "active" ||
      workspace.ownerUserId !== input.ownerUserId
    )
      return null;
    if (binding.continuityMode !== "HOST_AFFINE" || !binding.deviceId) return null;
    const device = await getDeviceById(binding.deviceId);
    if (
      !device ||
      device.tenantId !== input.tenantId ||
      device.userId !== input.ownerUserId ||
      device.deviceState !== "active"
    )
      return null;
    return {
      kind: "desktop",
      threadId: input.threadId,
      workspaceBindingId: binding.id,
      deviceId: binding.deviceId,
      ownerUserId: input.ownerUserId,
      bindingVersion: binding.contractDigest,
    };
  }
  const kind = runtimeConfig.defaultType;
  // Host 是显式开发选项，配置缺失不能把托管命令落到服务进程所在机器。
  if (kind === "host" && process.env.RUNTIME_DEFAULT !== "host") return null;
  return {
    kind,
    threadId: input.threadId,
    workspaceRoot: workspaceRoot(input.threadId),
    quota: resolveQuota(),
    networkPolicy: resolveNetworkPolicy({ runtimeType: kind }),
  };
}
