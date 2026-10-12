/**
 * Effect 多态 owner 的事务内回读与类型校验。
 *
 * 事实源：docs/topic02/nexharness-topic02-closure/repairs/10-topic03-interfaces.md §T32
 * （「多态owner由唯一应用服务在事务中回读真实源对象并验证tenant/Invocation，
 * 不能只验证字符串格式」）。
 *
 * 这不是新的 Ledger：
 * - tool_call owner 的真实源对象是既有 ToolCall。
 * - job_step owner 的真实源对象是既有 RuntimeEventIngress 中已提交的
 * `job.step.accepted` 正式事件；step 事实不落在新表里。
 *
 * 只有本模块可以决定一个 ownerRef 是否为合法 Effect owner。
 */
import { type DbOrTx, db } from "@/lib/db/client";
import {
  EFFECT_OWNER_KINDS,
  type EffectOwnerKind,
  toolCallOperationKey,
} from "@/lib/persistence/schema/effect";
import { runtimeEventIngressTable } from "@/lib/persistence/schema/executions";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import { and, eq } from "drizzle-orm";

/** job.step.accepted 正式事件类型（与 RuntimeProtocol 事件联合一致）。 */
export const JOB_STEP_ACCEPTED_EVENT_TYPE = "job.step.accepted";
/** job.step.completed 正式事件类型。 */
export const JOB_STEP_COMPLETED_EVENT_TYPE = "job.step.completed";
/** job.step.failed 正式事件类型。 */
export const JOB_STEP_FAILED_EVENT_TYPE = "job.step.failed";

export class EffectOwnerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EffectOwnerValidationError";
  }
}

export class EffectOwnerNotFoundError extends Error {
  constructor(
    readonly ownerKind: EffectOwnerKind,
    readonly ownerRef: string,
    message: string,
  ) {
    super(message);
    this.name = "EffectOwnerNotFoundError";
  }
}

export class EffectOwnerInvocationMismatchError extends Error {
  constructor(
    readonly ownerRef: string,
    readonly expectedInvocationId: string,
    readonly actualInvocationId: string,
  ) {
    super(
      `Effect owner ${ownerRef} 归属 Invocation ${actualInvocationId}，与请求的 ${expectedInvocationId} 不一致`,
    );
    this.name = "EffectOwnerInvocationMismatchError";
  }
}

export interface ResolvedToolCallOwner {
  ownerKind: "tool_call";
  ownerRef: string;
  invocationId: string;
  /** Tool owner 的外部操作身份固定为 ToolCall 唯一外部操作键。 */
  operationKey: string;
  toolCall: { id: string; tenantId: string; invocationId: string; operationId: string };
}

export interface ResolvedJobStepOwner {
  ownerKind: "job_step";
  ownerRef: string;
  invocationId: string;
  jobStep: { ingressId: string; jobId: string; stepKey: string; stage: string };
}

export type ResolvedEffectOwner = ResolvedToolCallOwner | ResolvedJobStepOwner;

export interface ResolveEffectOwnerInput {
  tenantId: string;
  ownerKind: EffectOwnerKind;
  ownerRef: string;
  /** 调用方声明的 Invocation；提供时必须是源对象的真实归属。 */
  invocationId?: string;
}

export function isEffectOwnerKind(value: string): value is EffectOwnerKind {
  return (EFFECT_OWNER_KINDS as readonly string[]).includes(value);
}

/**
 * 在事务内回读真实 owner 源对象并校验 tenant / Invocation 关系。
 *
 * - ownerKind 非法、ownerRef 为空 → EffectOwnerValidationError（调用方输入错误）。
 * - 源对象不存在或跨租户 → EffectOwnerNotFoundError。
 * - 源对象归属 Invocation 与声明不一致 → EffectOwnerInvocationMismatchError。
 *
 * job_step 的 ownerRef 必须是已提交的 `job.step.accepted` Ingress 记录 id：
 * 未接纳的步骤不能凭空拥有 Effect，重试必须定位同一 ownerRef。
 */
export async function resolveEffectOwner(
  tx: DbOrTx,
  input: ResolveEffectOwnerInput,
): Promise<ResolvedEffectOwner> {
  if (!input.tenantId) throw new EffectOwnerValidationError("tenantId 不能为空");
  if (!isEffectOwnerKind(input.ownerKind)) {
    throw new EffectOwnerValidationError(`非法 ownerKind: ${input.ownerKind}`);
  }
  if (!input.ownerRef) throw new EffectOwnerValidationError("ownerRef 不能为空");

  if (input.ownerKind === "tool_call") {
    const [toolCall] = await tx
      .select({
        id: toolCallTable.id,
        tenantId: toolCallTable.tenantId,
        invocationId: toolCallTable.invocationId,
        operationId: toolCallTable.operationId,
      })
      .from(toolCallTable)
      .where(and(eq(toolCallTable.tenantId, input.tenantId), eq(toolCallTable.id, input.ownerRef)))
      .limit(1);
    if (!toolCall) {
      throw new EffectOwnerNotFoundError(
        "tool_call",
        input.ownerRef,
        `ToolCall 不存在或跨租户不可见: ${input.ownerRef}`,
      );
    }
    assertInvocation(input.ownerRef, toolCall.invocationId, input.invocationId);
    return {
      ownerKind: "tool_call",
      ownerRef: toolCall.id,
      invocationId: toolCall.invocationId,
      operationKey: toolCallOperationKey(toolCall.id),
      toolCall,
    };
  }

  const [ingress] = await tx
    .select({
      id: runtimeEventIngressTable.id,
      tenantId: runtimeEventIngressTable.tenantId,
      invocationId: runtimeEventIngressTable.invocationId,
      candidateType: runtimeEventIngressTable.candidateType,
      payloadJson: runtimeEventIngressTable.payloadJson,
    })
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, input.tenantId),
        eq(runtimeEventIngressTable.id, input.ownerRef),
      ),
    )
    .limit(1);
  if (!ingress) {
    throw new EffectOwnerNotFoundError(
      "job_step",
      input.ownerRef,
      `job step accepted 事实不存在或跨租户不可见: ${input.ownerRef}`,
    );
  }
  if (ingress.candidateType !== JOB_STEP_ACCEPTED_EVENT_TYPE) {
    throw new EffectOwnerValidationError(
      `ownerRef ${input.ownerRef} 不是 ${JOB_STEP_ACCEPTED_EVENT_TYPE} 事件，不能作为 job_step owner`,
    );
  }
  const payload = (ingress.payloadJson ?? {}) as Record<string, unknown>;
  const jobId = typeof payload.jobId === "string" ? payload.jobId : null;
  const stepKey = typeof payload.stepKey === "string" ? payload.stepKey : null;
  const stage = typeof payload.stage === "string" ? payload.stage : null;
  if (!jobId || !stepKey || !stage) {
    throw new EffectOwnerValidationError(
      `${JOB_STEP_ACCEPTED_EVENT_TYPE} 事实缺少 jobId/stepKey/stage: ${input.ownerRef}`,
    );
  }
  assertInvocation(ingress.id, ingress.invocationId, input.invocationId);
  return {
    ownerKind: "job_step",
    ownerRef: ingress.id,
    invocationId: ingress.invocationId,
    jobStep: { ingressId: ingress.id, jobId, stepKey, stage },
  };
}

function assertInvocation(
  ownerRef: string,
  actualInvocationId: string,
  expectedInvocationId: string | undefined,
): void {
  if (expectedInvocationId && expectedInvocationId !== actualInvocationId) {
    throw new EffectOwnerInvocationMismatchError(
      ownerRef,
      expectedInvocationId,
      actualInvocationId,
    );
  }
}

/** 便捷入口：以默认连接在事务内回读 owner（单次读取，用于校验与查询路径）。 */
export async function resolveEffectOwnerOnDb(
  input: ResolveEffectOwnerInput,
): Promise<ResolvedEffectOwner> {
  return resolveEffectOwner(db, input);
}
