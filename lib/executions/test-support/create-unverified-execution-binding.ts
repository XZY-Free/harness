/**
 * 测试专用的无控制面证据 ExecutionBinding 写入夹具。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.3（ExecutionBinding L405-423）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §6（Invocation 生命周期）
 * - ../v11-agentkit-platform-development-plan/05-runtime-dispatch-and-attempt.md S05-C01
 *
 * 仅供旧集成测试构造历史数据；生产调度必须通过正式 Application Service
 * 校验 Route、Publication、Attestation 和 Conformance 证据。
 *
 * 关键约束：
 * - 一条 Invocation 恰有一条不可变绑定（invocationId 为主键，1:1）。
 * - 启动后不可变：只有 create，没有 update。
 * - Route 更新不修改进行中的 ExecutionBinding（affects_new_invocations_only）。
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import { ExecutionBindingAlreadyExistsError } from "@/lib/v11/runtime/errors";
import type { V11ExecutionBinding } from "@/lib/v11/schema/runtime";
import { v11ExecutionBinding } from "@/lib/v11/schema/runtime";
import { eq } from "drizzle-orm";

/** createExecutionBinding 入参。 */
export interface CreateExecutionBindingParams {
  invocationId: string;
  tenantId: string;
  agentRevisionId: string;
  runtimeRevisionId: string;
  deploymentRouteId: string;
  modelProvider: string;
  modelId: string;
  modelRevisionRef?: string | null;
  initialEnvironmentLeaseId?: string | null;
  workspaceBindingId?: string | null;
  policyRevisionId?: string | null;
  contextCheckpointId?: string | null;
}

/** computeBindingConfigHash 入参（与 CreateExecutionBindingParams 字段一致，便于规范化）。 */
export interface BindingConfigHashInput {
  agentRevisionId: string;
  runtimeRevisionId: string;
  deploymentRouteId: string;
  modelProvider: string;
  modelId: string;
  modelRevisionRef: string | null;
  initialEnvironmentLeaseId: string | null;
  workspaceBindingId: string | null;
  policyRevisionId: string | null;
  contextCheckpointId: string | null;
}

/**
 * 计算 ExecutionBinding 的 configHash（sha256，递归排序 key 保证稳定）。
 *
 * 事实源：§6.3 L423 "config_hash 由规范化字段后 SHA-256 计算"。
 * 规范化：递归排序 JSON key，null 字段统一为 null，避免字段顺序影响 hash。
 *
 * 返回格式：`sha256:<64hex>`。
 */
export function computeBindingConfigHash(input: BindingConfigHashInput): string {
  const normalized: Record<string, unknown> = {
    agentRevisionId: input.agentRevisionId,
    contextCheckpointId: input.contextCheckpointId,
    deploymentRouteId: input.deploymentRouteId,
    initialEnvironmentLeaseId: input.initialEnvironmentLeaseId,
    modelId: input.modelId,
    modelProvider: input.modelProvider,
    modelRevisionRef: input.modelRevisionRef,
    policyRevisionId: input.policyRevisionId,
    runtimeRevisionId: input.runtimeRevisionId,
    workspaceBindingId: input.workspaceBindingId,
  };
  const sorted = JSON.stringify(sortKeys(normalized));
  return `sha256:${createHash("sha256").update(sorted, "utf8").digest("hex")}`;
}

/** 递归排序对象 key，保证 hash 稳定。 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * 创建 ExecutionBinding（不可变，1:1）。
 *
 * 流程：
 * 1. 校验同 invocationId 是否已有 Binding（已存在 → ExecutionBindingAlreadyExistsError）。
 * 2. 计算 configHash（规范化字段后 SHA-256）。
 * 3. INSERT ExecutionBinding。
 * 4. 返回 ExecutionBinding。
 *
 * @throws ExecutionBindingAlreadyExistsError 同一 Invocation 已有 Binding
 */
export async function createExecutionBinding(
  params: CreateExecutionBindingParams,
): Promise<V11ExecutionBinding> {
  // 1. 校验同 invocationId 是否已有 Binding
  const [existing] = await db
    .select({ id: v11ExecutionBinding.invocationId })
    .from(v11ExecutionBinding)
    .where(eq(v11ExecutionBinding.invocationId, params.invocationId))
    .limit(1);
  if (existing) {
    throw new ExecutionBindingAlreadyExistsError(params.invocationId);
  }

  // 2. 计算 configHash
  const configHash = computeBindingConfigHash({
    agentRevisionId: params.agentRevisionId,
    runtimeRevisionId: params.runtimeRevisionId,
    deploymentRouteId: params.deploymentRouteId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    modelRevisionRef: params.modelRevisionRef ?? null,
    initialEnvironmentLeaseId: params.initialEnvironmentLeaseId ?? null,
    workspaceBindingId: params.workspaceBindingId ?? null,
    policyRevisionId: params.policyRevisionId ?? null,
    contextCheckpointId: params.contextCheckpointId ?? null,
  });

  // 3. INSERT ExecutionBinding（invocationId 为主键，1:1）
  await db.insert(v11ExecutionBinding).values({
    invocationId: params.invocationId,
    tenantId: params.tenantId,
    agentRevisionId: params.agentRevisionId,
    runtimeRevisionId: params.runtimeRevisionId,
    deploymentRouteId: params.deploymentRouteId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    modelRevisionRef: params.modelRevisionRef ?? null,
    initialEnvironmentLeaseId: params.initialEnvironmentLeaseId ?? null,
    workspaceBindingId: params.workspaceBindingId ?? null,
    policyRevisionId: params.policyRevisionId ?? null,
    contextCheckpointId: params.contextCheckpointId ?? null,
    configHash,
  });

  // 4. 回读
  const [row] = await db
    .select()
    .from(v11ExecutionBinding)
    .where(eq(v11ExecutionBinding.invocationId, params.invocationId))
    .limit(1);
  if (!row) {
    throw new Error(
      `createExecutionBinding: ExecutionBinding 行未找到（invocationId=${params.invocationId}）`,
    );
  }
  return row;
}
