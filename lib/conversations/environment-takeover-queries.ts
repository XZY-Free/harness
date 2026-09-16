/** Read-only environment availability conditions; changing a running revision is unsupported. */
import { listEffectRecordsByInvocation } from "@/lib/capability/effect-queries";
import { listToolCallsByInvocation } from "@/lib/capability/tool-call-queries";
import type { EnvironmentLease } from "@/lib/persistence/schema/environment";
import type { ExecutionOwnership } from "@/lib/persistence/schema/executions";
import type { ToolCallState } from "@/lib/persistence/schema/tool-call";
import { getActiveLocksByInvocation } from "@/lib/workspace/workspace-write-lock-queries";

export const DEVICE_HEARTBEAT_TIMEOUT_MS = 90_000 as const;

export function isDeviceHeartbeatStale(
  device: { lastActiveAt: Date | null } | null,
  now = new Date(),
): boolean {
  return (
    !device?.lastActiveAt ||
    now.getTime() - device.lastActiveAt.getTime() > DEVICE_HEARTBEAT_TIMEOUT_MS
  );
}

export interface TakeoverConditions {
  readonly can_takeover: boolean;
  readonly blocking_reasons: readonly string[];
  readonly pending_tool_calls: number;
  readonly unknown_effects: number;
  readonly active_write_locks: number;
  readonly owner_heartbeat_stale: boolean;
  readonly owner_device_id: string | null;
  readonly ownership_id: string | null;
}

export const EMPTY_CONDITIONS: TakeoverConditions = {
  can_takeover: false,
  blocking_reasons: [],
  pending_tool_calls: 0,
  unknown_effects: 0,
  active_write_locks: 0,
  owner_heartbeat_stale: false,
  owner_device_id: null,
  ownership_id: null,
};

export class TakeoverConditionsNotMetError extends Error {
  constructor(public readonly conditions: TakeoverConditions) {
    super(`当前执行仍由正式执行权控制：${conditions.blocking_reasons.join("；") || "未知原因"}`);
    this.name = "TakeoverConditionsNotMetError";
  }
}

export class NoActiveOwnershipError extends Error {
  constructor(public readonly threadId: string) {
    super(`Thread ${threadId} 当前无活跃 ExecutionOwnership`);
    this.name = "NoActiveOwnershipError";
  }
}

export async function getTakeoverConditions(
  input: {
    tenantId: string;
    activeInvocationId: string | null;
    activeOwnership: ExecutionOwnership | null;
    activeLease: EnvironmentLease | null;
  },
  options?: { now?: Date },
): Promise<TakeoverConditions> {
  if (!input.activeInvocationId || !input.activeOwnership) return EMPTY_CONDITIONS;
  const [toolCalls, effects, locks] = await Promise.all([
    listToolCallsByInvocation({ tenantId: input.tenantId, invocationId: input.activeInvocationId }),
    listEffectRecordsByInvocation(input.tenantId, input.activeInvocationId),
    getActiveLocksByInvocation(input.tenantId, input.activeInvocationId),
  ]);
  const blockingStates: readonly ToolCallState[] = ["proposed", "paused", "queued", "running"];
  const pendingToolCalls = toolCalls.filter((call) =>
    blockingStates.includes(call.callState as ToolCallState),
  ).length;
  const unknownEffects = effects.filter((effect) => effect.effectState === "unknown_effect").length;
  const now = options?.now ?? new Date();
  const ownerHeartbeatStale =
    now.getTime() - input.activeOwnership.lastHeartbeatAt.getTime() > DEVICE_HEARTBEAT_TIMEOUT_MS;
  const reasons: string[] = [];
  if (pendingToolCalls) reasons.push(`有 ${pendingToolCalls} 个未完成 ToolCall`);
  if (unknownEffects) reasons.push(`有 ${unknownEffects} 个 unknown_effect 待核对`);
  if (locks.length) reasons.push(`有 ${locks.length} 个活跃写锁未释放`);
  if (!ownerHeartbeatStale) reasons.push("owner 心跳未超时，不能改变当前执行权");
  return {
    can_takeover: false,
    blocking_reasons: reasons,
    pending_tool_calls: pendingToolCalls,
    unknown_effects: unknownEffects,
    active_write_locks: locks.length,
    owner_heartbeat_stale: ownerHeartbeatStale,
    owner_device_id: input.activeLease?.deviceId ?? null,
    ownership_id: input.activeOwnership.id,
  };
}
