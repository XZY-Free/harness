/**
 * Job step 的正式接纳与 Effect 派发/收口入口（T32 窄接口）。
 *
 * 事实源：docs/topic02/nexharness-topic02-closure/repairs/10-topic03-interfaces.md §T32。
 *
 * 设计边界：
 * - 不新增 JobStep / IngestionJob / IngestionAttempt 表。Job step 是同一 Job Invocation
 * 内部的正式阶段操作，其持久身份就是 RuntimeEventIngress 中已提交的
 * `job.step.accepted` 记录 id（即 EffectRecord.ownerRef）。
 * - 阶段接纳一律走既有 RuntimeEventIngress：producerSequence 分配、eventId 去重、
 * receipt 与 Authority 校验都不绕开。
 * - stepKey 由业务阶段 + 固定输入 Hash + 处理配置 Hash 稳定生成，不包含 Attempt、
 * Owner epoch、重启时间或随机临时目录。
 * - 真正发起不可回滚外部写入前先持久记录派发意图，并把未确定结果表示为
 * unknown_effect；网络调用在事务外。未知外部 Effect 禁止标成功，也禁止当确定失败。
 * - 本模块只提供入口与持久事实，不实现专题03 的 Parse/Chunk/Index 业务算法。
 */
import { createHash } from "node:crypto";
import { JOB_STEP_ACCEPTED_EVENT_TYPE, resolveEffectOwner } from "@/lib/capability/effect-owner";
import {
  createEffectRecord,
  createEffectTargets,
  getEffectRecordByOwner,
  listEffectTargets,
  recordEffectDispatchIntent,
} from "@/lib/capability/effect-queries";
import { type DbOrTx, db } from "@/lib/db/client";
import {
  EFFECT_TERMINAL_STATES,
  type EffectDispatchEvidence,
  type EffectRecord,
  type EffectState,
  type EffectTarget,
  type EffectType,
  effectRecordTable,
} from "@/lib/persistence/schema/effect";
import { invocationTable, runtimeEventIngressTable } from "@/lib/persistence/schema/executions";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import {
  type AuthorityIdentity,
  PROTOCOL_VERSION,
  protocolDigest,
} from "@/lib/runtime/runtime-protocol";
import { and, asc, eq } from "drizzle-orm";

/** job.step.completed 正式事件类型。 */
export const JOB_STEP_COMPLETED = "job.step.completed";
/** job.step.failed 正式事件类型。 */
export const JOB_STEP_FAILED = "job.step.failed";

export class JobStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobStepError";
  }
}

/**
 * 同一 (ownerRef, operationKey) 已被一个语义不同的请求占用。
 *
 * operationKey 是 owner 内的外部操作身份：同 Key 同请求是重试（必须复用原 Effect），
 * 同 Key 不同请求是身份冲突。既不允许静默复用旧 Effect（会把旧请求的结果当成本次结果），
 * 也不允许调用方换一个 Key 新建 Effect 来逃避 Unknown。
 */
export class JobStepEffectRequestConflictError extends Error {
  public readonly ownerRef: string;
  public readonly operationKey: string;
  public readonly existingRequestDigest: string;
  public readonly requestedRequestDigest: string;

  constructor(input: {
    ownerRef: string;
    operationKey: string;
    existingRequestDigest: string;
    requestedRequestDigest: string;
  }) {
    super(
      `Job step Effect 身份冲突：ownerRef=${input.ownerRef} operationKey=${input.operationKey} 已被 requestDigest=${input.existingRequestDigest} 占用，不接受 requestDigest=${input.requestedRequestDigest}`,
    );
    this.name = "JobStepEffectRequestConflictError";
    this.ownerRef = input.ownerRef;
    this.operationKey = input.operationKey;
    this.existingRequestDigest = input.existingRequestDigest;
    this.requestedRequestDigest = input.requestedRequestDigest;
  }
}

/**
 * 步骤收口时仍存在未确定的外部 Effect。
 *
 * Unknown 既不等于成功也不等于失败：必须先用 Provider 证据（查询 / 回执 / 人工）
 * 收敛，才能提交 job.step.completed / job.step.failed。
 */
export class JobStepEffectUnresolvedError extends Error {
  public readonly unresolvedOperationKeys: readonly string[];

  constructor(unresolvedOperationKeys: readonly string[]) {
    super(
      `Job step 存在未确定的外部 Effect，禁止标成功或标失败：${unresolvedOperationKeys.join(", ")}`,
    );
    this.name = "JobStepEffectUnresolvedError";
    this.unresolvedOperationKeys = unresolvedOperationKeys;
  }
}

// ─── stepKey / operationKey ──────────────────────────────

export interface JobStepKeyInput {
  /** 业务阶段标识（例如 parse / chunk / index）。 */
  stage: string;
  /** 该阶段的固定输入引用与摘要（顺序无关，用于稳定性）。 */
  inputRefs: readonly { ref: string; digest: string }[];
  /** 处理配置摘要。 */
  processorDigest: string;
}

/**
 * 业务源与处理配置稳定生成的 stepKey。
 *
 * 明确排除 Attempt / Owner epoch / 重启时间 / 随机临时目录：同一步骤跨重试必须得到
 * 同一个 stepKey，重试才能定位同一个已接纳步骤，而不是新建逻辑操作逃避 Unknown。
 */
export function computeJobStepKey(input: JobStepKeyInput): string {
  if (!input.stage) throw new JobStepError("stage 不能为空");
  if (!input.processorDigest) throw new JobStepError("processorDigest 不能为空");
  if (input.inputRefs.length === 0) throw new JobStepError("inputRefs 不能为空");
  const normalizedRefs = [...input.inputRefs]
    .map((ref) => ({ ref: ref.ref, digest: ref.digest }))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const digest = protocolDigest({
    stage: input.stage,
    inputRefs: normalizedRefs,
    processorDigest: input.processorDigest,
  });
  return `${input.stage}:${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}

/**
 * Provider 侧稳定的外部操作键。
 *
 * 一个 job step 可以有多个显式 operationKey（如同一步的不同目标动作），每个都必须有
 * 独立的 requestDigest 与 EffectTarget 集合；不允许用一个 Key 无限拆重试。
 */
export function computeJobStepOperationKey(input: {
  stepKey: string;
  action: string;
  target: string;
}): string {
  if (!input.stepKey || !input.action || !input.target) {
    throw new JobStepError("stepKey / action / target 都不能为空");
  }
  return `job-step:${input.stepKey}:${input.action}:${input.target}`;
}

// ─── admitJobStep ────────────────────────────────────────

export interface AdmitJobStepInput {
  tenantId: string;
  jobId: string;
  authority: AuthorityIdentity;
  stepKey: string;
  stage: string;
  inputRefs: readonly { ref: string; digest: string }[];
  processorDigest: string;
  profileDigest: string;
  requestDigest: string;
  receivedAt?: Date;
}

export interface JobStepAdmission {
  /** job.step.accepted 的 Ingress 记录 id，也就是所有 Effect 的 ownerRef。 */
  ownerRef: string;
  invocationId: string;
  jobId: string;
  stepKey: string;
  stage: string;
  acceptedThroughProducerSequence: string;
  /** true 表示该步骤此前已接纳（重试定位到同一持久事实，未新建）。 */
  replayed: boolean;
}

/**
 * 正式接纳一个 Job 阶段。
 *
 * 幂等语义：stepKey 稳定 ⇒ eventId 稳定 ⇒ 重复接纳命中同一条 Ingress 记录并返回
 * 原 ownerRef（不新建逻辑操作）。同一 stepKey 但不同 payload（不同输入/处理器 digest）
 * 是稳定身份冲突，由 Ingress 的 payloadHash 校验拒绝，不会静默产生第二个逻辑操作。
 *
 * 重放按「首次接纳的那一代 Authority」校验：已提交事实的代际身份不可被改写，
 * 换一代 Owner 重投同一事件会被 Ingress 判为 Authority 不匹配。接管进程必须按
 * jobId + stepKey 定位已提交的 ownerRef 继续推进，而不是重新接纳该步骤。
 */
export async function admitJobStep(input: AdmitJobStepInput): Promise<JobStepAdmission> {
  if (!input.tenantId) throw new JobStepError("tenantId 不能为空");
  if (!input.jobId) throw new JobStepError("jobId 不能为空");
  if (!input.stepKey) throw new JobStepError("stepKey 不能为空");
  const invocation = await getJobInvocation(input.tenantId, input.jobId);
  if (!invocation) throw new JobStepError(`Job 缺少 Invocation：${input.jobId}`);

  const eventId = deterministicUuid(
    `job-step-accepted:${input.tenantId}:${invocation.id}:${input.stepKey}`,
  );
  const payload = {
    jobId: input.jobId,
    stepKey: input.stepKey,
    stage: input.stage,
    inputRefs: input.inputRefs.map((ref) => ({ ref: ref.ref, digest: ref.digest })),
    processorDigest: input.processorDigest,
    profileDigest: input.profileDigest,
    requestDigest: input.requestDigest,
  };
  const result = await appendInvocationEvent({
    tenantId: input.tenantId,
    invocationId: invocation.id,
    authority: input.authority,
    eventId,
    type: JOB_STEP_ACCEPTED_EVENT_TYPE,
    payload,
    receivedAt: input.receivedAt,
  });
  return {
    ownerRef: result.ingressId,
    invocationId: invocation.id,
    jobId: input.jobId,
    stepKey: input.stepKey,
    stage: input.stage,
    acceptedThroughProducerSequence: result.acceptedThroughProducerSequence,
    replayed: result.replayed,
  };
}

// ─── runJobStepEffect ────────────────────────────────────

export interface RunJobStepEffectInput {
  tenantId: string;
  /** job.step.accepted 的 Ingress 记录 id。 */
  ownerRef: string;
  invocationId: string;
  operationKey: string;
  requestDigest: string;
  effectType: EffectType;
  /** 外部目标引用集合（每个目标一条 EffectTarget）。 */
  targetRefs: readonly string[];
  targetSummaryJson: unknown;
  authority: AuthorityIdentity;
  /** 首次派发的 Provider / Connection / 端点指纹证据（不含凭据明文）。 */
  provider: EffectDispatchEvidence["provider"];
  externalIdempotencyKey?: string | null;
  recordedAt?: Date;
}

export interface JobStepEffectRun {
  effectRecord: EffectRecord;
  effectTargets: EffectTarget[];
  /** true = 复用已存在 Effect（新 Owner 恢复路径，绝不重新发起已确认副作用）。 */
  reused: boolean;
}

/**
 * 在已接纳的 step owner 下取得或创建 Effect，并在同一事务内固定首次派发意图。
 *
 * - Effect 初始状态是 unknown_effect：意图已写但可能尚未发出的保守表示。
 * - 已存在同一 (ownerRef, operationKey) 的 Effect 时直接复用，不做第二次外部写入；
 *   若它已收敛为 confirmed_*，调用方应使用其结果而不是重新执行。复用只对同一
 *   requestDigest 成立，同 Key 不同请求抛 JobStepEffectRequestConflictError。
 * - ownerRef 会先被真实回读校验（必须是本 Invocation 已提交的 job.step.accepted 事实），
 *   伪造其他 tenant / Invocation 的 ownerRef 或任意 jobStep 字串一律拒绝。
 */
export async function runJobStepEffect(input: RunJobStepEffectInput): Promise<JobStepEffectRun> {
  if (!input.tenantId) throw new JobStepError("tenantId 不能为空");
  if (!input.operationKey) throw new JobStepError("operationKey 不能为空");

  return db.transaction(async (tx) => {
    const owner = await resolveEffectOwner(tx, {
      tenantId: input.tenantId,
      ownerKind: "job_step",
      ownerRef: input.ownerRef,
      invocationId: input.invocationId,
    });
    if (owner.ownerKind !== "job_step") {
      throw new JobStepError("job step Effect 的 ownerKind 必须是 job_step");
    }

    const existing = await getEffectRecordByOwner(
      input.tenantId,
      "job_step",
      owner.ownerRef,
      input.operationKey,
      tx,
    );
    if (existing) {
      // 复用只对「同一请求」成立：requestDigest 是外部目标 / 连接身份 / 动作与参数的
      // 语义摘要（已排除凭据与 TTL），因此同一步骤的合法重试必然得到同一个值。
      // 不同请求落到同一个 operationKey 说明调用方在复用别人的操作身份，
      // 静默复用会把旧请求的结果当成本次结果，必须显式冲突。
      if (existing.requestDigest !== input.requestDigest) {
        throw new JobStepEffectRequestConflictError({
          ownerRef: owner.ownerRef,
          operationKey: input.operationKey,
          existingRequestDigest: existing.requestDigest,
          requestedRequestDigest: input.requestDigest,
        });
      }
      const targets = await listEffectTargets(input.tenantId, existing.id, tx);
      return { effectRecord: existing, effectTargets: targets, reused: true };
    }

    const created = await createEffectRecord(
      {
        tenantId: input.tenantId,
        ownerKind: "job_step",
        ownerRef: owner.ownerRef,
        invocationId: owner.invocationId,
        operationKey: input.operationKey,
        requestDigest: input.requestDigest,
        effectType: input.effectType,
        targetSummaryJson: input.targetSummaryJson,
        externalIdempotencyKey: input.externalIdempotencyKey ?? null,
        initialEffectState: "unknown_effect",
      },
      tx,
    );
    const targets = await createEffectTargets(
      {
        tenantId: input.tenantId,
        effectRecordId: created.id,
        targets: input.targetRefs.map((targetRef) => ({ targetRef })),
      },
      tx,
    );
    const withIntent = await recordEffectDispatchIntent(
      {
        tenantId: input.tenantId,
        effectRecordId: created.id,
        authority: {
          invocationId: input.invocationId,
          attemptId: input.authority.attemptId,
          ownershipId: input.authority.ownershipId,
          sessionBindingId: input.authority.sessionBindingId,
          leaseEpoch: input.authority.leaseEpoch,
        },
        provider: input.provider,
        requestDigest: input.requestDigest,
        recordedAt: input.recordedAt,
      },
      tx,
    );
    return { effectRecord: withIntent, effectTargets: targets, reused: false };
  });
}

// ─── step 收口 ───────────────────────────────────────────

export interface JobStepOutcomeInput {
  tenantId: string;
  authority: AuthorityIdentity;
  ownerRef: string;
  invocationId: string;
  stepKey: string;
  stage: string;
  /** 关联的外部操作键；用于在收口前核对是否仍有 Unknown。 */
  operationKeys: readonly string[];
  /** 稳定结果引用与摘要（completed 必需）。 */
  resultRef?: string | null;
  resultDigest?: string | null;
  /** 稳定失败引用与摘要（failed 必需）。 */
  errorRef?: string | null;
  errorDigest?: string | null;
  errorCode?: string | null;
  receivedAt?: Date;
}

export interface JobStepOutcome {
  ingressId: string;
  replayed: boolean;
  effectStates: Record<string, EffectState>;
}

/** 提交 job.step.completed：只在关联 Effect 全部收敛为 confirmed_* 后允许。 */
export async function completeJobStep(input: JobStepOutcomeInput): Promise<JobStepOutcome> {
  if (!input.resultRef || !input.resultDigest) {
    throw new JobStepError("job.step.completed 必须携带稳定结果引用与摘要");
  }
  const states = await assertStepEffectsResolved(input);
  const result = await appendInvocationEvent({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    authority: input.authority,
    eventId: deterministicUuid(`job-step-completed:${input.ownerRef}`),
    type: JOB_STEP_COMPLETED,
    payload: {
      ownerRef: input.ownerRef,
      stepKey: input.stepKey,
      stage: input.stage,
      resultRef: input.resultRef,
      resultDigest: input.resultDigest,
      operationKeys: [...input.operationKeys],
    },
    receivedAt: input.receivedAt,
  });
  return { ingressId: result.ingressId, replayed: result.replayed, effectStates: states };
}

/** 提交 job.step.failed：Unknown 不是确定失败，必须先收敛。 */
export async function failJobStep(input: JobStepOutcomeInput): Promise<JobStepOutcome> {
  if (!input.errorRef || !input.errorDigest) {
    throw new JobStepError("job.step.failed 必须携带稳定失败引用与摘要");
  }
  const states = await assertStepEffectsResolved(input);
  const result = await appendInvocationEvent({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    authority: input.authority,
    eventId: deterministicUuid(`job-step-failed:${input.ownerRef}`),
    type: JOB_STEP_FAILED,
    payload: {
      ownerRef: input.ownerRef,
      stepKey: input.stepKey,
      stage: input.stage,
      errorRef: input.errorRef,
      errorDigest: input.errorDigest,
      errorCode: input.errorCode ?? null,
      operationKeys: [...input.operationKeys],
    },
    receivedAt: input.receivedAt,
  });
  return { ingressId: result.ingressId, replayed: result.replayed, effectStates: states };
}

/**
 * 收口前核对：每个关联 operationKey 都必须有已收敛（confirmed_*）的 Effect。
 *
 * 缺失 Effect 视为未收敛：尚无外部副作用证据的步骤既不能标成功也不能标失败。
 */
async function assertStepEffectsResolved(
  input: JobStepOutcomeInput,
): Promise<Record<string, EffectState>> {
  const states: Record<string, EffectState> = {};
  const unresolved: string[] = [];
  for (const operationKey of input.operationKeys) {
    const record = await getEffectRecordByOwner(
      input.tenantId,
      "job_step",
      input.ownerRef,
      operationKey,
    );
    if (!record) {
      unresolved.push(`${operationKey}(missing)`);
      continue;
    }
    states[operationKey] = record.effectState;
    if (!EFFECT_TERMINAL_STATES.includes(record.effectState)) {
      unresolved.push(`${operationKey}(${record.effectState})`);
    }
  }
  if (unresolved.length > 0) throw new JobStepEffectUnresolvedError(unresolved);
  return states;
}

// ─── 读取 ────────────────────────────────────────────────

/** 列出某已接纳 step 的全部 Effect（两类 owner 共存时按 invocation 维度查询另有入口）。 */
export async function listJobStepEffects(
  tenantId: string,
  ownerRef: string,
  tx?: DbOrTx,
): Promise<EffectRecord[]> {
  return (tx ?? db)
    .select()
    .from(effectRecordTable)
    .where(
      and(
        eq(effectRecordTable.tenantId, tenantId),
        eq(effectRecordTable.ownerKind, "job_step"),
        eq(effectRecordTable.ownerRef, ownerRef),
      ),
    )
    .orderBy(asc(effectRecordTable.createdAt), asc(effectRecordTable.operationKey));
}

// ─── 内部辅助 ────────────────────────────────────────────

async function getJobInvocation(tenantId: string, jobId: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: invocationTable.id })
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.jobId, jobId)))
    .limit(1);
  return row ?? null;
}

/**
 * 走唯一 Ingress 追加一条本平台产生的事件。
 *
 * producerSequence 由当前 Invocation 水位推导；并发写入导致的 gap 会重读水位重试，
 * 不自行构造或跳过序列号，也不绕过 eventId 去重。
 *
 * eventId 已经是稳定派生值（同一步骤/同一 owner 重试得到同一个 id），因此重放必须
 * 沿用该事件首次被接纳时的 producerSequence：Ingress 把「同 eventId + 不同
 * producerSequence」判为冲突，若每次都用新水位，重试就永远无法定位已提交事实，
 * 只能不断撞冲突（T32「重试必须定位原 ownerRef」）。
 */
async function appendInvocationEvent(input: {
  tenantId: string;
  invocationId: string;
  authority: AuthorityIdentity;
  eventId: string;
  type: string;
  payload: Record<string, unknown>;
  receivedAt?: Date;
}): Promise<{ ingressId: string; replayed: boolean; acceptedThroughProducerSequence: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [invocation] = await db
      .select({ lastProducerSequence: invocationTable.lastProducerSequence })
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      )
      .limit(1);
    if (!invocation) throw new JobStepError(`Invocation 不存在：${input.invocationId}`);
    const [alreadyAccepted] = await db
      .select({ producerSequence: runtimeEventIngressTable.producerSequence })
      .from(runtimeEventIngressTable)
      .where(
        and(
          eq(runtimeEventIngressTable.tenantId, input.tenantId),
          eq(runtimeEventIngressTable.invocationId, input.invocationId),
          eq(runtimeEventIngressTable.producerEventId, input.eventId),
        ),
      )
      .limit(1);
    const producerSequence = alreadyAccepted
      ? String(alreadyAccepted.producerSequence)
      : String(invocation.lastProducerSequence + 1);
    try {
      const result = await ingressRuntimeEvents({
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        receivedAt: input.receivedAt,
        batch: {
          protocolVersion: PROTOCOL_VERSION,
          authority: input.authority,
          events: [
            {
              eventId: input.eventId,
              producerSequence,
              type: input.type,
              schemaVersion: 1,
              payload: input.payload,
            },
          ],
        },
      });
      const receipt = result.receipts.find((item) => item.eventId === input.eventId);
      if (!receipt) throw new JobStepError(`事件未被接纳：${input.eventId}`);
      return {
        ingressId: receipt.ingressId,
        replayed: result.replayedEventIds.includes(input.eventId),
        acceptedThroughProducerSequence: result.acceptedThroughProducerSequence,
      };
    } catch (error) {
      lastError = error;
      // 只有序列号竞争可以重试；身份冲突、Authority 失败等必须直接上抛。
      if ((error as { name?: string }).name !== "ProducerSequenceGapError") throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new JobStepError("事件追加重试耗尽");
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
