/**
 * Job CompletionPolicy 的真实领域判定（R06 §5）。
 *
 * 契约来源：docs/V12/02/snowharness-execution-design/schema-dictionary.json
 *   jsonContracts.CompletionPolicy =
 *     { kind: all_success|fail_fast|threshold|registered,
 *       scope: root_invocation_and_required_children,
 *       threshold: kind=threshold 必填，successRatio 0..1 及明确 child 集合来源,
 *       policyRef: registered 必填受管实现 key 与 content digest，不接受任意 JS,
 *       unknownEffects: always_wait_or_manual }
 *
 * 为什么必须有这个模块：Job 的终态不能由"顶层 Invocation completed"直接映射成
 * "Job completed"。策略与输入在 Job 创建时一起冻结，判定必须按**冻结的必需子执行集合**
 * 做，不能拿当前返回数量当分母，也不能在存在未确定外部 Effect 时伪成功。
 *
 * 三条硬性约束：
 * - 成员集合来自已提交事实（`job.step.accepted` 的 Ingress 行），或策略里显式冻结的
 *   member 列表；调用方不能传入一个集合来影响判定。
 * - `unknownEffects = always_wait_or_manual`：Unknown 既不是成功也不是失败，
 *   一律等待（或转人工），**不**把它当失败去重跑。
 * - `registered` 只派发到受管白名单评估器并核对固定 digest，绝不执行用户传入代码。
 */
import { JOB_STEP_ACCEPTED_EVENT_TYPE } from "@/lib/capability/effect-owner";
import { type DbOrTx, db } from "@/lib/db/client";
import { runtimeEventIngressTable } from "@/lib/persistence/schema/executions";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { and, asc, eq } from "drizzle-orm";

export const COMPLETION_POLICY_KINDS = [
  "all_success",
  "fail_fast",
  "threshold",
  "registered",
] as const;
export type CompletionPolicyKind = (typeof COMPLETION_POLICY_KINDS)[number];

/** 契约唯一允许的 Unknown Effect 处置方式。 */
export const UNKNOWN_EFFECT_HANDLING = "always_wait_or_manual";

/** 冻结成员集合的来源。两者都在 Job 创建时确定，与"当前返回数量"无关。 */
export const COMPLETION_MEMBER_SOURCES = ["accepted_job_steps", "declared_members"] as const;
export type CompletionMemberSource = (typeof COMPLETION_MEMBER_SOURCES)[number];

export const JOB_STEP_COMPLETED_EVENT_TYPE = "job.step.completed";
export const JOB_STEP_FAILED_EVENT_TYPE = "job.step.failed";

/**
 * 策略形状非法时抛出。
 *
 * 必须 fail-closed：一个无法解析的策略意味着"不知道完成条件是什么"，
 * 此时把 Job 判成 completed 就是伪造业务终态。
 */
export class CompletionPolicyInvalidError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, detail: string) {
    super(`CompletionPolicyInvalid [${reasonCode}] ${detail}`);
    this.name = "CompletionPolicyInvalid";
    this.reasonCode = reasonCode;
  }
}

/** `registered` 引用了白名单外的实现 key 或其 digest 不匹配。 */
export class CompletionPolicyEvaluatorUnknownError extends Error {
  readonly reasonCode = "CompletionPolicyEvaluatorUnknown";
  constructor(detail: string) {
    super(`CompletionPolicyEvaluatorUnknown: ${detail}`);
    this.name = "CompletionPolicyEvaluatorUnknown";
  }
}

/** 契约里最常用的策略字面量：全部必需子执行成功。 */
export const ALL_SUCCESS_COMPLETION_POLICY = {
  kind: "all_success",
  scope: "root_invocation_and_required_children",
  unknownEffects: UNKNOWN_EFFECT_HANDLING,
} as const;

export interface ParsedCompletionPolicy {
  kind: CompletionPolicyKind;
  memberSource: CompletionMemberSource;
  /** memberSource=declared_members 时冻结的成员集合。 */
  declaredMembers: readonly string[];
  /** kind=threshold 必填。 */
  successRatio: number | null;
  /** kind=registered 必填。 */
  evaluatorKey: string | null;
  evaluatorDigest: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCompletionPolicyKind(value: string): value is CompletionPolicyKind {
  return (COMPLETION_POLICY_KINDS as readonly string[]).includes(value);
}

function isCompletionMemberSource(value: string): value is CompletionMemberSource {
  return (COMPLETION_MEMBER_SOURCES as readonly string[]).includes(value);
}

/**
 * 解析并校验冻结的 completionPolicyJson。
 *
 * 未知字段一律忽略（策略是向前兼容的 JSON），但**必需字段缺失或语义不合法必须拒绝**：
 * 静默降级成某个默认策略会让"冻结的完成条件"名存实亡。
 */
export function parseCompletionPolicy(value: unknown): ParsedCompletionPolicy {
  if (!isRecord(value)) {
    throw new CompletionPolicyInvalidError("NotAnObject", "completionPolicyJson 必须是对象");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !isCompletionPolicyKind(kind)) {
    throw new CompletionPolicyInvalidError(
      "UnknownKind",
      `kind 必须是 ${COMPLETION_POLICY_KINDS.join(" | ")} 之一，实际=${String(kind)}`,
    );
  }
  if (value.unknownEffects !== UNKNOWN_EFFECT_HANDLING) {
    throw new CompletionPolicyInvalidError(
      "UnknownEffectsHandlingMissing",
      `unknownEffects 必须是 ${UNKNOWN_EFFECT_HANDLING}（Unknown 不得当失败重跑）`,
    );
  }
  const memberSourceRaw = value.memberSource ?? "accepted_job_steps";
  if (typeof memberSourceRaw !== "string" || !isCompletionMemberSource(memberSourceRaw)) {
    throw new CompletionPolicyInvalidError(
      "UnknownMemberSource",
      `memberSource 必须是 ${COMPLETION_MEMBER_SOURCES.join(" | ")} 之一`,
    );
  }
  const memberSource = memberSourceRaw;

  let declaredMembers: string[] = [];
  if (memberSource === "declared_members") {
    const raw = value.members;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== "string")) {
      throw new CompletionPolicyInvalidError(
        "MembersMissing",
        "memberSource=declared_members 时必须冻结非空的 members 字符串数组",
      );
    }
    const members = raw as string[];
    if (new Set(members).size !== members.length) {
      throw new CompletionPolicyInvalidError("MembersDuplicated", "members 不得重复");
    }
    declaredMembers = [...members].sort();
  }

  let successRatio: number | null = null;
  if (kind === "threshold") {
    const threshold = value.threshold;
    const ratio = isRecord(threshold) ? threshold.successRatio : undefined;
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
      throw new CompletionPolicyInvalidError(
        "ThresholdMissing",
        "kind=threshold 必须提供 threshold.successRatio ∈ (0, 1]",
      );
    }
    successRatio = ratio;
  }

  let evaluatorKey: string | null = null;
  let evaluatorDigest: string | null = null;
  if (kind === "registered") {
    const ref = value.policyRef;
    const key = isRecord(ref) ? ref.key : undefined;
    const digest = isRecord(ref) ? ref.digest : undefined;
    if (typeof key !== "string" || key.length === 0 || typeof digest !== "string") {
      throw new CompletionPolicyInvalidError(
        "PolicyRefMissing",
        "kind=registered 必须提供 policyRef.key 与 policyRef.digest",
      );
    }
    if (!(key in MANAGED_COMPLETION_EVALUATORS)) {
      // 未知实现不是"策略非法"，而是"不可执行"：分开报错便于排障。
      throw new CompletionPolicyEvaluatorUnknownError(`未注册的受管评估器 key=${key}`);
    }
    evaluatorKey = key;
    evaluatorDigest = digest;
  }

  return { kind, memberSource, declaredMembers, successRatio, evaluatorKey, evaluatorDigest };
}

// ─── 冻结成员集合与结果 ────────────────────────────────────

export interface FrozenCompletionMembers {
  /** 冻结的必需子执行集合（stepKey）。 */
  members: readonly string[];
  succeeded: readonly string[];
  failed: readonly string[];
  /** 尚未有终态结果的成员。 */
  pending: readonly string[];
  /** 声称 completed 但结果无效（缺 resultRef / resultDigest / 摘要形式非法）。 */
  invalid: readonly string[];
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * 读取冻结成员集合与各自结果。
 *
 * 成员来自 `job.step.accepted` 的**已提交 Ingress 事实**（或将策略里冻结的 members），
 * 因此分母与"某一时刻的返回数量"无关；结果来自 `job.step.completed` / `job.step.failed`
 * 的正式受理行。同一 stepKey 出现多次以最后一次受理为准（重试收敛后的最终事实）。
 */
export async function loadFrozenCompletionMembers(
  input: {
    tenantId: string;
    invocationId: string;
    policy: ParsedCompletionPolicy;
  },
  executor: DbOrTx = db,
): Promise<FrozenCompletionMembers> {
  const rows = await executor
    .select({
      candidateType: runtimeEventIngressTable.candidateType,
      producerSequence: runtimeEventIngressTable.producerSequence,
      payloadJson: runtimeEventIngressTable.payloadJson,
    })
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, input.tenantId),
        eq(runtimeEventIngressTable.invocationId, input.invocationId),
      ),
    )
    .orderBy(asc(runtimeEventIngressTable.producerSequence));

  const accepted: string[] = [];
  const acceptedSeen = new Set<string>();
  const outcomeByStep = new Map<
    string,
    { state: "completed"; valid: boolean } | { state: "failed" }
  >();
  for (const row of rows) {
    const payload = isRecord(row.payloadJson) ? row.payloadJson : {};
    const stepKey = typeof payload.stepKey === "string" ? payload.stepKey : null;
    if (!stepKey) continue;
    if (row.candidateType === JOB_STEP_ACCEPTED_EVENT_TYPE) {
      if (!acceptedSeen.has(stepKey)) {
        acceptedSeen.add(stepKey);
        accepted.push(stepKey);
      }
      continue;
    }
    if (row.candidateType === JOB_STEP_COMPLETED_EVENT_TYPE) {
      const resultRef = payload.resultRef;
      const resultDigest = payload.resultDigest;
      // "结果有效" = 有稳定引用且摘要是合法 sha256 形式。这里**不**发明一个新的
      // digest 公式去复核业务结果内容：那会把合法的业务摘要误判为无效。
      outcomeByStep.set(stepKey, {
        state: "completed",
        valid:
          typeof resultRef === "string" &&
          resultRef.length > 0 &&
          typeof resultDigest === "string" &&
          DIGEST_PATTERN.test(resultDigest),
      });
      continue;
    }
    if (row.candidateType === JOB_STEP_FAILED_EVENT_TYPE) {
      outcomeByStep.set(stepKey, { state: "failed" });
    }
  }

  const members =
    input.policy.memberSource === "declared_members"
      ? input.policy.declaredMembers
      : [...accepted].sort();
  const succeeded: string[] = [];
  const failed: string[] = [];
  const pending: string[] = [];
  const invalid: string[] = [];
  for (const member of members) {
    const outcome = outcomeByStep.get(member);
    if (!outcome) {
      // declared_members 必须始终由 accepted 事实兜底：冻结成员却从未被接纳，
      // 说明成员集合与执行事实脱节，按"未完成"处理（等待），不当作成功。
      pending.push(member);
      continue;
    }
    if (outcome.state === "failed") failed.push(member);
    else if (outcome.valid) succeeded.push(member);
    else invalid.push(member);
  }
  return { members, succeeded, failed, pending, invalid };
}

// ─── 受管评估器白名单 ──────────────────────────────────────

/**
 * 受管评估器：key → { digest, evaluate }。
 *
 * `digest` 是评估器实现的 content digest（当前由实现自身的规范摘要固定），
 * 策略里冻结的 `policyRef.digest` 必须与之相等。白名单只由本模块（服务端代码）
 * 维护，用户输入既不能新增评估器也不能携带可执行代码。
 */
export interface ManagedCompletionEvaluator {
  digest: string;
  evaluate: (input: {
    members: FrozenCompletionMembers;
    policy: ParsedCompletionPolicy;
  }) => "completed" | "failed" | "waiting_external";
}

function managedDigest(seed: Record<string, unknown>): string {
  return protocolDigest({ managedCompletionEvaluator: seed });
}

export const MANAGED_COMPLETION_EVALUATOR_KEYS = [
  "managed:required_steps_all_succeeded/v1",
  "managed:required_steps_success_ratio/v1",
] as const;
export type ManagedCompletionEvaluatorKey = (typeof MANAGED_COMPLETION_EVALUATOR_KEYS)[number];

export const MANAGED_COMPLETION_EVALUATORS: Record<string, ManagedCompletionEvaluator> = {
  "managed:required_steps_all_succeeded/v1": {
    digest: managedDigest({ key: "managed:required_steps_all_succeeded/v1", kind: "all_success" }),
    evaluate: ({ members }) =>
      members.failed.length > 0 || members.invalid.length > 0
        ? "failed"
        : members.pending.length > 0
          ? "waiting_external"
          : "completed",
  },
  "managed:required_steps_success_ratio/v1": {
    digest: managedDigest({ key: "managed:required_steps_success_ratio/v1", kind: "threshold" }),
    evaluate: ({ members, policy }) => {
      const ratio = policy.successRatio ?? 1;
      const total = members.members.length;
      if (total === 0) return "completed";
      const needed = Math.ceil(ratio * total);
      if (members.succeeded.length >= needed) return "completed";
      // 剩余可能成功数仍够阈值 → 继续等；不够 → 确定失败。
      const stillPossible = total - members.failed.length - members.invalid.length;
      return stillPossible >= needed ? "waiting_external" : "failed";
    },
  },
};

// ─── 判定 ─────────────────────────────────────────────────

export interface CompletionEvaluationInput {
  tenantId: string;
  jobId: string;
  invocationId: string;
  /** 冻结的完成策略（Job 行上的 completionPolicyJson）。 */
  policyJson: unknown;
  /** 顶层 Invocation 的终态与结果有效性（来自正式事实，不由调用方拼装）。 */
  rootInvocation: {
    executionState: string;
    resultRef: string | null;
    resultDigest: string | null;
    errorCode: string | null;
  };
  /** 关联执行范围内是否仍有未确定外部 Effect（Unknown 一律等待，不伪成功）。 */
  hasUnknownEffect: boolean;
}

export type CompletionDecision =
  | {
      kind: "completed";
      reasonCode: string;
      members: FrozenCompletionMembers;
    }
  | {
      kind: "failed";
      reasonCode: string;
      members: FrozenCompletionMembers | null;
    }
  | {
      kind: "waiting_external";
      reasonCode: string;
      members: FrozenCompletionMembers | null;
    }
  | {
      kind: "cancelled";
      reasonCode: string;
      members: FrozenCompletionMembers | null;
    };

/**
 * 真实判定 Job 是否可收口。
 *
 * 顺序固定：
 * 1. Unknown Effect → 等待（契约 unknownEffects=always_wait_or_manual，优先于一切策略）。
 * 2. 顶层 Invocation 未终态 → 等待。
 * 3. 策略解析失败 / 评估器不可执行 → 失败（fail-closed，不伪成功也不永久挂起）。
 * 4. 按 kind 判定必需子执行集合。
 */
export async function evaluateJobCompletion(
  input: CompletionEvaluationInput,
  executor: DbOrTx = db,
): Promise<CompletionDecision> {
  // 1. Unknown Effect 优先于一切策略：契约要求 always_wait_or_manual。
  if (input.hasUnknownEffect) {
    return { kind: "waiting_external", reasonCode: "EffectUnresolved", members: null };
  }
  const state = input.rootInvocation.executionState;
  // 2. 顶层 Invocation 尚未终态 → 等待（不能提前收口）。
  if (state !== "completed" && state !== "failed" && state !== "lost" && state !== "cancelled") {
    return { kind: "waiting_external", reasonCode: "RootInvocationPending", members: null };
  }
  if (state === "cancelled") {
    return { kind: "cancelled", reasonCode: "RootInvocationCancelled", members: null };
  }

  // 3. 策略解析 / 评估器可执行性（fail-closed）。
  let policy: ParsedCompletionPolicy;
  try {
    policy = parseCompletionPolicy(input.policyJson);
  } catch (error) {
    if (error instanceof CompletionPolicyEvaluatorUnknownError) {
      return { kind: "failed", reasonCode: error.reasonCode, members: null };
    }
    return {
      kind: "failed",
      reasonCode:
        error instanceof CompletionPolicyInvalidError ? error.reasonCode : "PolicyInvalid",
      members: null,
    };
  }

  // 4. 顶层执行已确认失败：Job 不可能成功，无论子执行集合剩余多少。
  if (state === "failed" || state === "lost") {
    return { kind: "failed", reasonCode: "RootInvocationFailed", members: null };
  }
  // 5. 顶层 completed 但结果无效：业务结果不存在，Job 业务失败（不是"成功"）。
  if (!input.rootInvocation.resultRef || !input.rootInvocation.resultDigest) {
    return { kind: "failed", reasonCode: "ResultInvalid", members: null };
  }

  if (policy.kind === "registered") {
    const evaluator = MANAGED_COMPLETION_EVALUATORS[policy.evaluatorKey as string];
    if (!evaluator || evaluator.digest !== policy.evaluatorDigest) {
      // digest 与受管实现不一致：可能是策略被改写，或被指向了另一个实现版本。
      return { kind: "failed", reasonCode: "CompletionPolicyEvaluatorUnknown", members: null };
    }
    const members = await loadFrozenCompletionMembers(
      { tenantId: input.tenantId, invocationId: input.invocationId, policy },
      executor,
    );
    const verdict = evaluator.evaluate({ members, policy });
    if (verdict === "completed")
      return { kind: "completed", reasonCode: `Registered:${policy.evaluatorKey}`, members };
    if (verdict === "failed")
      return { kind: "failed", reasonCode: "RegisteredEvaluatorUnsatisfied", members };
    return { kind: "waiting_external", reasonCode: "RegisteredEvaluatorPending", members };
  }

  const members = await loadFrozenCompletionMembers(
    { tenantId: input.tenantId, invocationId: input.invocationId, policy },
    executor,
  );

  if (policy.kind === "all_success") {
    if (members.failed.length > 0 || members.invalid.length > 0)
      return { kind: "failed", reasonCode: "RequiredStepFailed", members };
    if (members.pending.length > 0)
      return { kind: "waiting_external", reasonCode: "RequiredStepPending", members };
    return { kind: "completed", reasonCode: "AllRequiredStepsSucceeded", members };
  }

  if (policy.kind === "fail_fast") {
    // 确认失败立即终止（不必等其余成员）；Unknown Effect 已在入口处先行等待，
    // 因此这里不会把未收敛的外部副作用当失败吞掉。
    if (members.failed.length > 0 || members.invalid.length > 0)
      return { kind: "failed", reasonCode: "RequiredStepFailed", members };
    // 仍有未完成成员时不能收口：fail_fast 缩短"失败后继续派发"的路径，
    // 不是"看到顶层完成就忽略子执行"。
    if (members.pending.length > 0)
      return { kind: "waiting_external", reasonCode: "RequiredStepPending", members };
    return { kind: "completed", reasonCode: "FailFastSatisfied", members };
  }

  // threshold：分母是**冻结成员集合**，不是当前返回数量。
  const total = members.members.length;
  if (total === 0) {
    // 没有冻结成员时退化为顶层结果判定（单一顶层 Invocation 的 Job）。
    return { kind: "completed", reasonCode: "ThresholdVacuouslySatisfied", members };
  }
  const needed = Math.ceil((policy.successRatio ?? 1) * total);
  if (members.succeeded.length >= needed)
    return { kind: "completed", reasonCode: "ThresholdSatisfied", members };
  const stillPossible = total - members.failed.length - members.invalid.length;
  if (stillPossible < needed)
    return { kind: "failed", reasonCode: "ThresholdUnreachable", members };
  return { kind: "waiting_external", reasonCode: "ThresholdPending", members };
}
