/** The only transaction that turns a Runtime event into platform facts. */
import { randomUUID } from "node:crypto";
import { handleChildThreadTerminal } from "@/lib/conversations/child-thread-queries";
import { createThreadItem } from "@/lib/conversations/thread-item-queries";
import {
  allocateEventSequences,
  allocateItemSequence,
  insertThreadEvent,
} from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { requireCurrentExecutionAuthority } from "@/lib/executions/application/require-current-execution-authority";
import type { ExecutionOperationKind } from "@/lib/executions/application/require-current-execution-authority";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { bridgeInvocationTerminalToJob } from "@/lib/job/job-terminal-bridge";
import { createUserActionRequest } from "@/lib/permission/user-action-queries";
import { threadItemTable, turnTable } from "@/lib/persistence/schema/conversation";
import { environmentLeaseTable } from "@/lib/persistence/schema/environment";
import {
  INVOCATION_TERMINAL_STATES,
  type Invocation,
  executionBindingTable,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
  runtimeEventIngressTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { filesystemCheckpointTable } from "@/lib/persistence/schema/filesystem-checkpoint";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { workspaceBinding } from "@/lib/persistence/schema/workspace";
import { workspaceWriteLock } from "@/lib/persistence/schema/workspace-lock";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import {
  activateRuntimeSessionBindingInTransaction,
  closeRuntimeSessionBindingInTransaction,
} from "@/lib/runtime/persistence/runtime-session-store";
import {
  type AuthorityIdentity,
  type EventReceipt,
  type RuntimeEvent,
  RuntimeEventBatchSchema,
  computeEventPayloadHash,
} from "@/lib/runtime/runtime-protocol";
import { isWorkspaceWriterFenced } from "@/lib/workspace/workspace-writer-fence";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

export type IngressTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class IngressInvocationNotFoundError extends Error {
  constructor(public readonly invocationId: string) {
    super(`Invocation 不存在或不可见：${invocationId}`);
    this.name = "IngressInvocationNotFoundError";
  }
}

export class IngressInvocationTerminalError extends Error {
  constructor(
    public readonly invocationId: string,
    public readonly currentState: string,
  ) {
    super(`Invocation 已处于终态：${invocationId}/${currentState}`);
    this.name = "IngressInvocationTerminalError";
  }
}

export class IngressBatchEmptyError extends Error {
  constructor(public readonly invocationId: string) {
    super(`Runtime Event batch 不能为空：${invocationId}`);
    this.name = "IngressBatchEmptyError";
  }
}

export class IngressAuthorityMismatchError extends Error {
  constructor(public readonly invocationId: string) {
    super(`Runtime Event 不属于当前 ExecutionOwnership：${invocationId}`);
    this.name = "IngressAuthorityMismatchError";
  }
}

export class EventPayloadHashConflictError extends Error {
  constructor(
    public readonly invocationId: string,
    public readonly eventId: string,
    public readonly producerSequence: string,
    public readonly expectedHash: string,
    public readonly actualHash: string,
  ) {
    super(`Runtime Event payloadHash 冲突：${invocationId}/${eventId}/${producerSequence}`);
    this.name = "EventPayloadHashConflictError";
  }
}

export class ProducerSequenceGapError extends Error {
  constructor(
    public readonly invocationId: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Runtime Event producerSequence 不连续：${invocationId} expected=${expected} actual=${actual}`,
    );
    this.name = "ProducerSequenceGapError";
  }
}

export class IngressCandidateTypeUnsupportedError extends Error {
  constructor(
    public readonly invocationId: string,
    public readonly candidateType: string,
  ) {
    super(`Runtime Event type 不支持：${invocationId}/${candidateType}`);
    this.name = "IngressCandidateTypeUnsupportedError";
  }
}

export interface IngressRuntimeEventsInput {
  tenantId: string;
  invocationId: string;
  batch: unknown;
  receivedAt?: Date;
}

export interface IngressRuntimeEventsResult {
  invocationId: string;
  receipts: EventReceipt[];
  replayedEventIds: string[];
  acceptedThroughProducerSequence: string;
}

function sameAuthority(left: AuthorityIdentity, right: AuthorityIdentity): boolean {
  return (
    left.invocationId === right.invocationId &&
    left.runtimeRevisionId === right.runtimeRevisionId &&
    left.attemptId === right.attemptId &&
    left.ownershipId === right.ownershipId &&
    left.leaseEpoch === right.leaseEpoch &&
    left.sessionBindingId === right.sessionBindingId
  );
}

function toNumber(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RangeError(`decimal value exceeds local safe integer boundary: ${value}`);
  return result;
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * 由正式 Event Schema 决定操作类别（不接受调用方传字符串）。
 *
 * - new_action：产生新决策/新行动，必须 Gate=open。
 * - accepted_action_completion：已接纳行动的完成/失败回执，quiescing 下仍必须落库。
 * - terminal：终态与暂停收口。
 * - control：控制/用户输入事实。
 * - progress：展示性进度与启动证明，本身不产生新决策。
 */
function classifyOperationKind(event: RuntimeEvent): ExecutionOperationKind {
  switch (event.type) {
    case "action":
    case "harness.action.proposed":
    case "response.completed":
    case "job.step.accepted":
      return "new_action";
    case "harness.action.started":
    case "harness.action.completed":
    case "harness.action.failed":
    case "job.step.completed":
    case "job.step.failed":
      return "accepted_action_completion";
    case "execution.completed":
    case "execution.failed":
    case "execution.cancelled":
    case "execution.suspended":
    case "terminal":
      return "terminal";
    case "user-action":
      return "control";
    default:
      return "progress";
  }
}

/** 已接纳行动回执必须引用本 Invocation 先前正式接纳过的 action_id。 */
function actionIdOf(event: RuntimeEvent): string | null {
  const value = event.payload.action_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 已接纳行动回执不能借 completion 分支创建新 Action：
 * 必须能在本 Invocation 已提交的 Ledger 中找到同一 action_id（harness.action.*）
 * 或同一 ownerRef + stepKey（job.step.*）的接纳事实。
 *
 * job.step 的 ownerRef 就是 job.step.accepted 那条已提交 Ingress 记录 id：
 * 重试必须定位同一逻辑步骤，而不是创建一个新 owner 来逃避 Unknown。
 */
async function assertAcceptedParentAction(
  tx: IngressTx,
  tenantId: string,
  invocationId: string,
  event: RuntimeEvent,
): Promise<void> {
  if (event.type === "harness.action.started") return;
  if (event.type === "job.step.completed" || event.type === "job.step.failed") {
    const ownerRef =
      typeof event.payload.ownerRef === "string" && event.payload.ownerRef
        ? event.payload.ownerRef
        : null;
    const stepKey =
      typeof event.payload.stepKey === "string" && event.payload.stepKey
        ? event.payload.stepKey
        : null;
    if (!ownerRef || !stepKey) {
      throw new IngressAuthorityMismatchError(invocationId);
    }
    const [accepted] = await tx
      .select({ id: runtimeEventIngressTable.id })
      .from(runtimeEventIngressTable)
      .where(
        and(
          eq(runtimeEventIngressTable.tenantId, tenantId),
          eq(runtimeEventIngressTable.invocationId, invocationId),
          eq(runtimeEventIngressTable.id, ownerRef),
          eq(runtimeEventIngressTable.candidateType, "job.step.accepted"),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${runtimeEventIngressTable.payloadJson}, '$.stepKey')) = ${stepKey}`,
        ),
      )
      .limit(1);
    if (!accepted) throw new IngressAuthorityMismatchError(invocationId);
    return;
  }
  const actionId = actionIdOf(event);
  if (!actionId) {
    throw new IngressAuthorityMismatchError(invocationId);
  }
  const acceptedTypes = ["harness.action.proposed", "harness.action.started"];
  const [accepted] = await tx
    .select({ id: runtimeEventIngressTable.id })
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, tenantId),
        eq(runtimeEventIngressTable.invocationId, invocationId),
        inArray(runtimeEventIngressTable.candidateType, acceptedTypes),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${runtimeEventIngressTable.payloadJson}, '$.action_id')) = ${actionId}`,
      ),
    )
    .limit(1);
  if (!accepted) throw new IngressAuthorityMismatchError(invocationId);
}

/**
 * `job.step.accepted` 的必需 payload 事实 + 真实平台回读：
 * jobId / stepKey / stage / inputRefs[{ref,digest}] / processorDigest /
 * profileDigest / requestDigest 全部非空；Job 主体、真实 service Principal 与
 * 当前 Authority 由平台侧核对，而不是信任 Runtime 自报。
 *
 * stage / stepKey 只是业务标识，绝不作为任意代码执行来源。
 */
function assertJobStepAcceptedFacts(
  invocation: Invocation,
  event: RuntimeEvent,
  binding: { principalType: string; principalSource: string },
): void {
  if (invocation.subjectType !== "job" || !invocation.jobId) {
    throw new IngressAuthorityMismatchError(invocation.id);
  }
  if (binding.principalType !== "service" || binding.principalSource !== "trusted_service") {
    throw new IngressAuthorityMismatchError(invocation.id);
  }
  const payload = event.payload;
  const jobId = nonEmptyString(payload.jobId);
  const stepKey = nonEmptyString(payload.stepKey);
  const stage = nonEmptyString(payload.stage);
  const processorDigest = nonEmptyString(payload.processorDigest);
  const profileDigest = nonEmptyString(payload.profileDigest);
  const requestDigest = nonEmptyString(payload.requestDigest);
  if (!jobId || jobId !== invocation.jobId) {
    throw new IngressAuthorityMismatchError(invocation.id);
  }
  if (!stepKey || !stage || !processorDigest || !profileDigest || !requestDigest) {
    throw new IngressAuthorityMismatchError(invocation.id);
  }
  if (!SHA256_DIGEST.test(requestDigest) || !SHA256_DIGEST.test(profileDigest)) {
    throw new IngressAuthorityMismatchError(invocation.id);
  }
  const inputRefs = payload.inputRefs;
  if (!Array.isArray(inputRefs) || inputRefs.length === 0) {
    throw new IngressAuthorityMismatchError(invocation.id);
  }
  for (const ref of inputRefs) {
    if (!ref || typeof ref !== "object") throw new IngressAuthorityMismatchError(invocation.id);
    const entry = ref as Record<string, unknown>;
    if (!nonEmptyString(entry.ref) || !nonEmptyString(entry.digest)) {
      throw new IngressAuthorityMismatchError(invocation.id);
    }
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Batch 内部集合校验：同 eventId 重复、同 producerSequence 重复、同 eventId 不同
 * payloadHash 都必须在写前识别，不能靠逐条 savepoint 兜底后留下半批事实。
 */
function assertBatchSetConsistency(events: readonly RuntimeEvent[]): void {
  const byEventId = new Map<string, string>();
  const bySequence = new Map<string, string>();
  for (const event of events) {
    const payloadHash = computeEventPayloadHash(event);
    const seenEventId = byEventId.get(event.eventId);
    if (seenEventId !== undefined) {
      if (seenEventId !== payloadHash)
        throw new EventPayloadHashConflictError(
          "batch",
          event.eventId,
          event.producerSequence,
          seenEventId,
          payloadHash,
        );
      throw new ProducerSequenceGapError("batch", "唯一 eventId", event.eventId);
    }
    byEventId.set(event.eventId, payloadHash);
    const seenSequence = bySequence.get(event.producerSequence);
    if (seenSequence !== undefined) {
      throw new ProducerSequenceGapError("batch", "唯一 producerSequence", event.producerSequence);
    }
    bySequence.set(event.producerSequence, event.eventId);
  }
}

async function lockInvocation(
  tx: IngressTx,
  tenantId: string,
  invocationId: string,
): Promise<Invocation> {
  const [row] = await tx
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .for("update")
    .limit(1);
  if (!row) throw new IngressInvocationNotFoundError(invocationId);
  return row;
}

async function requireIngressAuthority(
  tx: IngressTx,
  tenantId: string,
  authority: AuthorityIdentity,
  requiredPhase: "dispatching" | "executing",
  operationKind: ExecutionOperationKind,
) {
  const owner = await requireCurrentExecutionAuthority({
    tenantId,
    authority,
    executor: tx,
    requiredPhase,
    operationKind,
  });
  const [attempt] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, tenantId),
        eq(invocationAttemptTable.id, authority.attemptId),
        eq(invocationAttemptTable.invocationId, authority.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const [session] = await tx
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.id, authority.sessionBindingId),
        eq(runtimeSessionBindingTable.invocationId, authority.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const [binding] = await tx
    .select()
    .from(executionBindingTable)
    .where(
      and(
        eq(executionBindingTable.tenantId, tenantId),
        eq(executionBindingTable.invocationId, authority.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !attempt ||
    !session ||
    !binding ||
    attempt.id !== owner.attemptId ||
    session.attemptId !== authority.attemptId ||
    session.ownershipId !== authority.ownershipId ||
    session.leaseEpoch !== toNumber(authority.leaseEpoch) ||
    session.runtimeRevisionId !== authority.runtimeRevisionId ||
    binding.runtimeRevisionId !== authority.runtimeRevisionId ||
    ["closed", "lost"].includes(session.bindingState)
  ) {
    throw new IngressAuthorityMismatchError(authority.invocationId);
  }
  if (binding.environmentMode === "MANAGED") {
    if (!binding.environmentDefinitionRevisionId || !owner.environmentLeaseId) {
      throw new IngressAuthorityMismatchError(authority.invocationId);
    }
    const [lease] = await tx
      .select()
      .from(environmentLeaseTable)
      .where(
        and(
          eq(environmentLeaseTable.tenantId, tenantId),
          eq(environmentLeaseTable.id, owner.environmentLeaseId),
          eq(environmentLeaseTable.invocationId, authority.invocationId),
          eq(environmentLeaseTable.attemptId, authority.attemptId),
          eq(
            environmentLeaseTable.environmentDefinitionRevisionId,
            binding.environmentDefinitionRevisionId,
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !lease ||
      lease.leaseState !== "active" ||
      lease.readinessState !== "ready" ||
      lease.activationOwnershipId !== authority.ownershipId
    ) {
      throw new IngressAuthorityMismatchError(authority.invocationId);
    }
  }
  if (binding.environmentMode === "MANAGED" || binding.workspaceBindingId) {
    const [workspace] = await tx
      .select()
      .from(workspaceBinding)
      .where(
        and(
          eq(workspaceBinding.tenantId, tenantId),
          eq(workspaceBinding.id, binding.workspaceBindingId),
        ),
      )
      .limit(1);
    if (!workspace) throw new IngressAuthorityMismatchError(authority.invocationId);
    // R08 §1/§4：Writer 围栏只约束「服务端持有 Writer」的连续性模式；`HOST_AFFINE` 的写由
    // 绑定设备本机执行，服务端不是该目录的 Writer（`workspaceWriterGeneration` 恒为 null）。
    // 判定与 Current Authority 守卫共用同一份实现，避免两处各留一个版本。
    const fenced = await isWorkspaceWriterFenced({
      tenantId,
      invocationId: authority.invocationId,
      workspaceBinding: workspace,
      holder: {
        attemptId: authority.attemptId,
        ownershipId: authority.ownershipId,
        writerGeneration: owner.workspaceWriterGeneration,
      },
      executor: tx,
    });
    if (!fenced) throw new IngressAuthorityMismatchError(authority.invocationId);
  }
  return { owner, attempt, session, binding };
}

/**
 * 一个 Event 在 Ledger 中的身份定位结果。
 *
 * `exact` 才允许作为精确历史 Replay 返回原回执：两个唯一键（producerEventId、
 * producerSequence）必须同时命中同一行，且行内 eventId / sequence 与请求逐字相同。
 * 任一键命中而另一键缺失/指向别处 = 稳定身份冲突，不能退化成"payload 相同所以是重放"。
 */
type ExistingEventLookup =
  | { kind: "none" }
  | { kind: "exact"; row: typeof runtimeEventIngressTable.$inferSelect }
  | { kind: "conflict"; reason: string };

async function findExisting(
  tx: IngressTx,
  tenantId: string,
  invocationId: string,
  event: RuntimeEvent,
): Promise<ExistingEventLookup> {
  const [byId] = await tx
    .select()
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, tenantId),
        eq(runtimeEventIngressTable.invocationId, invocationId),
        eq(runtimeEventIngressTable.producerEventId, event.eventId),
      ),
    )
    .limit(1);
  const [bySequence] = await tx
    .select()
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, tenantId),
        eq(runtimeEventIngressTable.invocationId, invocationId),
        eq(runtimeEventIngressTable.producerSequence, toNumber(event.producerSequence)),
      ),
    )
    .limit(1);

  if (!byId && !bySequence) return { kind: "none" };
  if (!byId) {
    return {
      kind: "conflict",
      reason: `producerSequence ${event.producerSequence} 已被另一 eventId 占用（${bySequence?.producerEventId ?? "?"}）`,
    };
  }
  if (!bySequence) {
    return {
      kind: "conflict",
      reason: `eventId ${event.eventId} 已存在但携带另一 producerSequence（${byId.producerSequence}）`,
    };
  }
  if (byId.id !== bySequence.id) {
    return {
      kind: "conflict",
      reason: `eventId 与 producerSequence 分别命中不同 Ledger 行（${byId.id} / ${bySequence.id}）`,
    };
  }
  if (
    byId.producerEventId !== event.eventId ||
    byId.producerSequence !== toNumber(event.producerSequence)
  ) {
    return {
      kind: "conflict",
      reason: `Ledger 行身份与请求不一致（${byId.producerEventId}/${byId.producerSequence}）`,
    };
  }
  return { kind: "exact", row: byId };
}

function receiptFromRow(row: typeof runtimeEventIngressTable.$inferSelect): EventReceipt {
  const parsed = row.receiptJson as EventReceipt;
  if (!parsed || parsed.eventId !== row.producerEventId)
    throw new IngressAuthorityMismatchError(row.invocationId);
  return parsed;
}

function requireStartedPayloadString(
  payload: Record<string, unknown>,
  field:
    | "intentKey"
    | "semanticRequestDigest"
    | "remoteSessionRef"
    | "remoteExecutionRef"
    | "capabilitiesDigest",
): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new IngressAuthorityMismatchError("execution.started");
  }
  return value;
}

function validateExecutionStarted(
  event: RuntimeEvent,
  session: typeof runtimeSessionBindingTable.$inferSelect,
): void {
  if (event.type !== "execution.started") return;
  if (session.bindingState !== "dispatching" || !session.semanticRequestDigest) {
    throw new IngressAuthorityMismatchError(session.invocationId);
  }
  const payload = event.payload;
  const intentKey = requireStartedPayloadString(payload, "intentKey");
  const semanticRequestDigest = requireStartedPayloadString(payload, "semanticRequestDigest");
  const remoteSessionRef = requireStartedPayloadString(payload, "remoteSessionRef");
  const remoteExecutionRef = requireStartedPayloadString(payload, "remoteExecutionRef");
  const capabilitiesDigest = requireStartedPayloadString(payload, "capabilitiesDigest");
  if (
    !/^sha256:[0-9a-f]{64}$/.test(semanticRequestDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(capabilitiesDigest) ||
    intentKey !== session.startIntentKey ||
    semanticRequestDigest !== session.semanticRequestDigest ||
    (session.remoteSessionRef !== null && remoteSessionRef !== session.remoteSessionRef) ||
    (session.remoteExecutionRef !== null && remoteExecutionRef !== session.remoteExecutionRef)
  ) {
    throw new IngressAuthorityMismatchError(session.invocationId);
  }
  // R02 §3：发布证据是唯一比对源。ACK 之前到达的 execution.started 也必须与
  // Session 冻结的 RuntimeRevision manifest 摘要一致，不能只按"可选 ACK"校验。
  const expectedCapabilities = expectedCapabilityManifestDigest({
    runtimeRevisionId: session.runtimeRevisionId,
    runtimeCapabilitiesJson: session.runtimeCapabilitiesJson,
  });
  if (capabilitiesDigest !== expectedCapabilities) {
    throw new IngressAuthorityMismatchError(session.invocationId);
  }
  const acknowledgedCapabilities =
    session.transportAcknowledgement &&
    typeof session.transportAcknowledgement === "object" &&
    !Array.isArray(session.transportAcknowledgement)
      ? (session.transportAcknowledgement as Record<string, unknown>).capabilitiesDigest
      : null;
  if (acknowledgedCapabilities !== null && acknowledgedCapabilities !== capabilitiesDigest) {
    throw new IngressAuthorityMismatchError(session.invocationId);
  }
}

/**
 * R05：Turn 状态变换必须**同时**写入 canonical ThreadEvent（`turn.*`）。
 *
 * 权威 Turn 表与 Thread 事件流是同一事实的两个投影面。Runtime 事件改写 Turn 表却不写
 * 事件时，`rebuildProjectionsForThread`（刷新产品页/从 DB 重建时间线）重放后 Turn 时间线
 * 仍停在旧状态，页面与正式输出不一致 —— 而这类不一致只靠 SSE 内存态是看不出来的。
 */
async function appendTurnStateEvent(
  tx: IngressTx,
  input: {
    threadId: string;
    turnId: string;
    invocationId: string;
    eventType:
      | "turn.started"
      | "turn.waiting"
      | "turn.completed"
      | "turn.failed"
      | "turn.cancelled";
    itemId?: string | null;
    errorCode?: string | null;
  },
): Promise<void> {
  const sequence = await allocateEventSequences(tx, input.threadId);
  await insertThreadEvent(tx, input.threadId, sequence, {
    eventType: input.eventType,
    turnId: input.turnId,
    itemId: input.itemId ?? undefined,
    invocationId: input.invocationId,
    actorType: "service",
    payload: { error_code: input.errorCode ?? null },
  });
}

async function mapEvent(
  tx: IngressTx,
  invocation: Invocation,
  event: RuntimeEvent,
): Promise<{ itemId?: string; threadEventId?: string; jobEventId?: string }> {
  if (event.type === "execution.started") return {};
  if (invocation.subjectType === "job") return {};
  if (!invocation.threadId || !invocation.turnId)
    throw new IngressInvocationNotFoundError(invocation.id);

  // R05：Thread 事件流只承载 `docs/contracts/event-catalog.json` 登记的事件类型。
  // `execution.*` / `action` / `terminal` 是 Runtime Protocol 的候选事件名，产品侧的
  // 对应事实由 canonical `turn.*` 事件（`applyEvent` 同事务写入）与 Item 承载。
  // 把它们当 ThreadEvent 写入会让投影器判 `schema_unsupported`，而投影器**不前移
  // checkpoint**，整个 Thread 的读模型从此停滞 —— 刷新产品页后时间线与页面永久不一致。
  if (
    event.type === "execution.suspended" ||
    event.type === "execution.completed" ||
    event.type === "execution.failed" ||
    event.type === "execution.cancelled" ||
    event.type === "action" ||
    event.type === "terminal"
  ) {
    return {};
  }

  if (
    event.type === "progress" ||
    event.type === "response.completed" ||
    event.type === "user-action"
  ) {
    const itemType =
      event.type === "response.completed"
        ? "assistant_message"
        : event.type === "user-action"
          ? "user_action"
          : "user_guidance";
    const item = await createThreadItem(tx, {
      threadId: invocation.threadId,
      turnId: invocation.turnId,
      itemSequence: await allocateItemSequence(tx, invocation.threadId),
      itemType,
      itemState: event.type === "user-action" ? "pending" : "completed",
      authorType: "assistant",
      authorId: null,
      content: { type: event.type, ...event.payload },
      contextPolicy: event.type === "progress" ? "exclude" : undefined,
      invocationId: invocation.id,
    });
    let userActionRequestId: string | null = null;
    if (event.type === "user-action") {
      // user-action Runtime 事件是 Parent UserActionRequest 的事实源：同事务原子创建
      // UAR 并关联员工可见投影 Item；promptJson 携带 agent_call_* 引用，resolve 链路
      // 据此恢复原 AgentCall/task/context（agentCallResumeRefs）。
      const payload = event.payload as Record<string, unknown>;
      const requestType =
        payload.request_type === "confirmation" || payload.request_type === "input"
          ? payload.request_type
          : null;
      if (requestType) {
        // UAR 幂等键取 payload.action_id（input 按 input event、confirmation 按外部
        // 业务提议的稳定键）；payload.harness_action_id 只是 Parent Harness action
        // 的关联引用，绝不作为 UAR 幂等键（同 action 可连续产生多次 confirmation）。
        const uarIdempotencyKey =
          typeof payload.action_id === "string" && payload.action_id
            ? payload.action_id
            : typeof payload.harness_action_id === "string" && payload.harness_action_id
              ? payload.harness_action_id
              : null;
        // (invocationId, harnessActionId) 唯一索引：同一幂等键的重复 user-action
        // 事件以首个 UAR 为准（事件本身已按 producerEventId 幂等）。
        const [existingUar] = uarIdempotencyKey
          ? await tx
              .select({ id: userActionRequestTable.id })
              .from(userActionRequestTable)
              .where(
                and(
                  eq(userActionRequestTable.tenantId, invocation.tenantId),
                  eq(userActionRequestTable.invocationId, invocation.id),
                  eq(userActionRequestTable.harnessActionId, uarIdempotencyKey),
                ),
              )
              .limit(1)
          : [];
        if (!existingUar) {
          const expiresAt =
            typeof payload.expires_at === "string" ? new Date(payload.expires_at) : null;
          const asString = (value: unknown): string | null =>
            typeof value === "string" && value ? value : null;
          const created = await createUserActionRequest(
            {
              tenantId: invocation.tenantId,
              threadId: invocation.threadId,
              turnId: invocation.turnId,
              invocationId: invocation.id,
              harnessActionId: uarIdempotencyKey,
              itemId: item.id,
              requestType,
              purpose: asString(payload.purpose),
              promptJson: {
                prompt: asString(payload.prompt),
                title: asString(payload.title),
                summary: asString(payload.summary),
                impact: asString(payload.impact),
                preview: payload.preview ?? null,
                action_id: asString(payload.action_id),
                action_key: asString(payload.action_key),
                proposal_id: asString(payload.proposal_id),
                harness_action_id: asString(payload.harness_action_id),
                agent_call_id: asString(payload.agent_call_id),
                agent_call_event_id: asString(payload.agent_call_event_id),
                task_id: asString(payload.task_id),
                context_id: asString(payload.context_id),
                agent_display_name: asString(payload.agent_display_name),
              },
              ...(requestType === "input" ? { inputSchemaJson: payload.input_schema } : {}),
              ...(expiresAt && !Number.isNaN(expiresAt.getTime()) ? { expiresAt } : {}),
            },
            { tx },
          );
          userActionRequestId = created.request.id;
        } else {
          userActionRequestId = existingUar.id;
        }
      }
    }
    const sequence = await allocateEventSequences(tx, invocation.threadId);
    const threadEvent = await insertThreadEvent(tx, invocation.threadId, sequence, {
      eventType: event.type === "user-action" ? "user_action.requested" : "item.created",
      turnId: invocation.turnId,
      itemId: item.id,
      invocationId: invocation.id,
      actorType: "service",
      payload: {
        source: event.type,
        itemId: item.id,
        contentHash: item.contentHash,
        ...event.payload,
        ...(userActionRequestId ? { request_id: userActionRequestId } : {}),
      },
      idempotencyKey: `runtime-event:${event.eventId}`,
    });
    return { itemId: item.id, threadEventId: threadEvent.id };
  }

  const sequence = await allocateEventSequences(tx, invocation.threadId);
  const threadEvent = await insertThreadEvent(tx, invocation.threadId, sequence, {
    eventType: event.type,
    turnId: invocation.turnId,
    invocationId: invocation.id,
    actorType: "service",
    payload: event.payload,
    idempotencyKey: `runtime-event:${event.eventId}`,
  });
  return { threadEventId: threadEvent.id };
}

/**
 * §3 恢复版本推进判定——**唯一来源**。
 *
 * 推进（这些"已应用事实"改变了可恢复边界，旧 Checkpoint 因此可能陈旧）：
 * - 新模型/Action 结果被应用：`response.completed`、`action`
 * - Agent/Tool/Effect 结果被 Loop 正式采用：`harness.action.completed` / `.failed`
 * - Job step 完成被应用：`job.step.completed` / `.failed`
 * - 已解决 UserAction 进入继续执行：`execution.started` 从 `waiting_user` 恢复
 * - 用户/服务输入被正式接纳为待解决事实：`user-action`
 * - 正式暂停与终态：`execution.suspended`、`execution.completed|failed|cancelled`
 *
 * 不推进：`progress`（无语义变化的展示）、`harness.action.proposed|started` 与
 * `job.step.accepted`（只是进行中/已接纳，尚无已应用结果）、首次 `execution.started`。
 * 纯 Replay 根本不进入本判定（`findExisting` 命中 exact 后直接返回）。
 */
export function advancesRecoveryVersion(
  event: RuntimeEvent,
  previousState: Invocation["executionState"],
): boolean {
  switch (event.type) {
    case "response.completed":
    case "action":
    case "harness.action.completed":
    case "harness.action.failed":
    case "job.step.completed":
    case "job.step.failed":
    case "user-action":
    case "execution.suspended":
    case "execution.completed":
    case "execution.failed":
    case "execution.cancelled":
      return true;
    case "execution.started":
      // 暂停后的正式恢复就是"已解决 UserAction 进入继续执行"；首次启动不改变恢复边界。
      return previousState === "waiting_user";
    default:
      return false;
  }
}

/**
 * 分支返回前统一推进水位并回读最新行。
 *
 * 除终态分支外的所有分支都经过这里；终态分支把水位与终态放在**同一条** UPDATE 里，
 * 因为 `JobCommand.terminalVersion` 必须等于最终提交版本，桥接 Job 之后不能再写 Invocation。
 */
async function advanceRecoveryVersionIfApplied(
  tx: IngressTx,
  current: Invocation,
  previousState: Invocation["executionState"],
  event: RuntimeEvent,
  now: Date,
): Promise<Invocation> {
  if (!advancesRecoveryVersion(event, previousState)) return current;
  await tx
    .update(invocationTable)
    .set({
      recoveryVersion: current.recoveryVersion + 1,
      versionNo: current.versionNo + 1,
      updatedAt: now,
    })
    .where(eq(invocationTable.id, current.id));
  const [updated] = await tx
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, current.id))
    .limit(1);
  if (!updated) throw new IngressInvocationNotFoundError(current.id);
  return updated;
}

async function applyLifecycle(
  tx: IngressTx,
  invocation: Invocation,
  event: RuntimeEvent,
  now: Date,
  attemptId: string,
  ownershipId: string,
  sessionBindingId: string,
  binding: typeof executionBindingTable.$inferSelect,
  /** 本事件 `requireIngressAuthority` 锁到的 Session 行版本（R02 §8 CAS 依据）。 */
  sessionVersionNo: number,
): Promise<Invocation> {
  if (event.type === "execution.started") {
    const started = event.payload;
    // R02 §7：`running` 只能由合法 `execution.started` 映射。既包含首次 queued→running，
    // 也包含受控暂停后的正式恢复转换 waiting_user→running；控制命令 ACK 不推进状态。
    if (invocation.executionState === "queued" || invocation.executionState === "waiting_user") {
      await tx
        .update(invocationTable)
        .set({
          executionState: "running",
          errorCode: null,
          errorSummary: null,
          ...(invocation.executionState === "queued" ? { startedAt: now } : {}),
          versionNo: invocation.versionNo + 1,
          updatedAt: now,
        })
        .where(eq(invocationTable.id, invocation.id));
      if (invocation.turnId) {
        await tx
          .update(turnTable)
          .set({
            turnState: "running",
            errorCode: null,
            waitingAt: null,
            versionNo: sql`${turnTable.versionNo} + 1`,
          })
          .where(eq(turnTable.id, invocation.turnId));
        if (invocation.threadId)
          await appendTurnStateEvent(tx, {
            threadId: invocation.threadId,
            turnId: invocation.turnId,
            invocationId: invocation.id,
            eventType: "turn.started",
          });
      }
    }
    await tx
      .update(executionOwnershipTable)
      .set({ executionPhase: "executing", updatedAt: now })
      .where(
        and(
          eq(executionOwnershipTable.tenantId, invocation.tenantId),
          eq(executionOwnershipTable.id, ownershipId),
          eq(executionOwnershipTable.invocationId, invocation.id),
        ),
      );
    await tx
      .update(invocationAttemptTable)
      .set({ attemptState: "running", startedAt: now, updatedAt: now })
      .where(eq(invocationAttemptTable.id, attemptId));
    // R02 §8：Session 状态写入收敛到仓储方法（行锁 + 单向转换表；closed/lost 不可回 active）。
    await activateRuntimeSessionBindingInTransaction(tx, {
      tenantId: invocation.tenantId,
      id: sessionBindingId,
      expectedVersionNo: sessionVersionNo,
      startedEventId: event.eventId,
      remoteSessionRef:
        typeof started.remoteSessionRef === "string" ? started.remoteSessionRef : null,
      remoteExecutionRef:
        typeof started.remoteExecutionRef === "string" ? started.remoteExecutionRef : null,
    });
    const [updated] = await tx
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, invocation.id))
      .limit(1);
    if (!updated) throw new IngressInvocationNotFoundError(invocation.id);
    return advanceRecoveryVersionIfApplied(tx, updated, invocation.executionState, event, now);
  }
  if (event.type === "user-action") {
    if (!["completed", "failed", "cancelled", "lost"].includes(invocation.executionState)) {
      await tx
        .update(invocationTable)
        .set({
          executionState: "waiting_user",
          versionNo: invocation.versionNo + 1,
          updatedAt: now,
        })
        .where(eq(invocationTable.id, invocation.id));
      if (invocation.turnId) {
        await tx
          .update(turnTable)
          .set({ turnState: "waiting_user" })
          .where(eq(turnTable.id, invocation.turnId));
        if (invocation.threadId)
          await appendTurnStateEvent(tx, {
            threadId: invocation.threadId,
            turnId: invocation.turnId,
            invocationId: invocation.id,
            eventType: "turn.waiting",
          });
      }
    }
    const [updated] = await tx
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, invocation.id))
      .limit(1);
    if (!updated) throw new IngressInvocationNotFoundError(invocation.id);
    return advanceRecoveryVersionIfApplied(tx, updated, invocation.executionState, event, now);
  }
  if (event.type === "execution.suspended") {
    if (!INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) {
      const recovery = await resolveSuspensionRecovery({
        tx,
        invocation,
        event,
        binding,
        attemptId,
        ownershipId,
      });
      await tx
        .update(invocationTable)
        .set({
          executionState: "waiting_user",
          versionNo: invocation.versionNo + 1,
          updatedAt: now,
        })
        .where(eq(invocationTable.id, invocation.id));
      await tx
        .update(invocationAttemptTable)
        .set({
          attemptState: "suspended",
          preparationState: "pending",
          preparationEvidence: null,
          preparationDigest: null,
          preparedAt: null,
          filesystemCheckpointId: recovery.checkpointId,
          resumeAnchor: recovery.anchor,
          resumeAnchorDigest: recovery.anchorDigest,
          versionNo: sql`${invocationAttemptTable.versionNo} + 1`,
          updatedAt: now,
        })
        .where(eq(invocationAttemptTable.id, attemptId));
      if (invocation.turnId) {
        await tx
          .update(turnTable)
          .set({ turnState: "waiting_user" })
          .where(eq(turnTable.id, invocation.turnId));
        if (invocation.threadId)
          await appendTurnStateEvent(tx, {
            threadId: invocation.threadId,
            turnId: invocation.turnId,
            invocationId: invocation.id,
            eventType: "turn.waiting",
          });
      }
      // R04 §3：**不**在已持有 I 根锁时调用 WorkspaceWriteLock 撤销/释放。
      // 本事务只失效 Authority、关闭 Session；Writer 的物理 stop/drain 由持久
      // Workspace Writer 释放 lane 按 W→I 顺序处理（`workspace-writer-release.ts`）。
      // 释放请求的持久事实就是这里写的 "Ownership 已非 current + W 行仍被其持有"，
      // 崩溃后仍可被扫描发现，不依赖任何内存定时器。
      await tx
        .update(executionOwnershipTable)
        .set({
          ownershipState: "released",
          executionPhase: "suspending",
          releasedAt: now,
          reasonCode: "execution_suspended",
          versionNo: sql`${executionOwnershipTable.versionNo} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(executionOwnershipTable.tenantId, invocation.tenantId),
            eq(executionOwnershipTable.id, ownershipId),
            eq(executionOwnershipTable.invocationId, invocation.id),
          ),
        );
      // R02 §8：暂停收口同样只经仓储方法（行锁 + 单向转换表）。
      await closeRuntimeSessionBindingInTransaction(tx, {
        tenantId: invocation.tenantId,
        id: sessionBindingId,
        expectedVersionNo: sessionVersionNo,
      });
      const [owner] = await tx
        .select({ environmentLeaseId: executionOwnershipTable.environmentLeaseId })
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, invocation.tenantId),
            eq(executionOwnershipTable.id, ownershipId),
          ),
        )
        .limit(1);
      if (owner?.environmentLeaseId) {
        await tx
          .update(environmentLeaseTable)
          .set({
            leaseState: "active",
            readinessState: "preparing",
            activationOwnershipId: null,
            versionNo: sql`${environmentLeaseTable.versionNo} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(environmentLeaseTable.tenantId, invocation.tenantId),
              eq(environmentLeaseTable.id, owner.environmentLeaseId),
              eq(environmentLeaseTable.activationOwnershipId, ownershipId),
            ),
          );
      }
    }
    const [updated] = await tx
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, invocation.id))
      .limit(1);
    if (!updated) throw new IngressInvocationNotFoundError(invocation.id);
    return advanceRecoveryVersionIfApplied(tx, updated, invocation.executionState, event, now);
  }
  if (
    event.type === "execution.completed" ||
    event.type === "execution.failed" ||
    event.type === "execution.cancelled"
  ) {
    const state =
      event.type === "execution.completed"
        ? "completed"
        : event.type === "execution.failed"
          ? "failed"
          : "cancelled";
    if (!INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) {
      let resultRef = typeof event.payload.resultRef === "string" ? event.payload.resultRef : null;
      let resultDigest =
        typeof event.payload.resultDigest === "string" ? event.payload.resultDigest : null;
      // R06 §1：Job 的"真正结果"必须是**已持久内容与 digest**。Job 没有 Thread 可挂
      // assistant 消息，其产物的唯一事实源就是本 Invocation 已提交的 `response.completed`
      // Ingress 记录（`payloadHash` 就是该内容的正式摘要）。Runtime 自报的 resultRef
      // 若已给出则以其为准，绝不覆盖；只有当结果缺失时才从已持久事实推导，
      // 也从不在测试或生产填一个"没有对应内容"的引用就声明业务完成。
      if (
        state === "completed" &&
        invocation.subjectType === "job" &&
        (!resultRef || !resultDigest)
      ) {
        const [produced] = await tx
          .select({
            id: runtimeEventIngressTable.id,
            payloadHash: runtimeEventIngressTable.payloadHash,
          })
          .from(runtimeEventIngressTable)
          .where(
            and(
              eq(runtimeEventIngressTable.tenantId, invocation.tenantId),
              eq(runtimeEventIngressTable.invocationId, invocation.id),
              eq(runtimeEventIngressTable.candidateType, "response.completed"),
            ),
          )
          .orderBy(desc(runtimeEventIngressTable.producerSequence))
          .limit(1);
        if (produced) {
          resultRef = resultRef ?? `runtime-event:${produced.id}`;
          resultDigest = resultDigest ?? produced.payloadHash;
        }
      }
      const errorCode =
        typeof event.payload.errorCode === "string" ? event.payload.errorCode : null;
      // 先收口从属事实（Attempt/Turn/Ownership/Session 与物理 Writer），
      // 最后才写 Invocation 终态并桥接 Job——terminalVersion 必须等于最终提交版本。
      await tx
        .update(invocationAttemptTable)
        .set({ attemptState: state, finishedAt: now, updatedAt: now })
        .where(eq(invocationAttemptTable.id, attemptId));
      const turnId = invocation.turnId;
      const threadId = invocation.threadId;
      if (turnId && threadId) {
        // R05：产品页（`GET /api/threads/{id}/turns`）读的是**权威 Turn 表**，因此
        // 终态收口必须同时落地 Turn 的"采用关系"——否则页面刷新后看不到正式输出：
        // - `adoptedInvocationId` = 产出当前 final_item 的会话执行（本 Invocation）；
        // - `finalItemId` = 本 Invocation 已提交的 `response.completed` 对应的
        //   assistant_message Item；没有正式回答（失败/取消）时保持原值不动，
        //   绝不把失败的半截回答抬成"当前正式回答"。
        // - `activeInvocationId` 终态必须为空（列语义：只在 queued/running/waiting 有值）。
        const [produced] =
          state === "completed"
            ? await tx
                .select({ id: threadItemTable.id })
                .from(threadItemTable)
                .where(
                  and(
                    eq(threadItemTable.threadId, threadId),
                    eq(threadItemTable.invocationId, invocation.id),
                    eq(threadItemTable.itemType, "assistant_message"),
                  ),
                )
                .orderBy(desc(threadItemTable.itemSequence))
                .limit(1)
            : [];
        await tx
          .update(turnTable)
          .set({
            turnState:
              state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed",
            finishedAt: now,
            activeInvocationId: null,
            ...(produced ? { finalItemId: produced.id, adoptedInvocationId: invocation.id } : {}),
          })
          .where(eq(turnTable.id, turnId));
        await appendTurnStateEvent(tx, {
          threadId,
          turnId,
          invocationId: invocation.id,
          eventType:
            state === "completed"
              ? "turn.completed"
              : state === "cancelled"
                ? "turn.cancelled"
                : "turn.failed",
          itemId: produced?.id ?? null,
          errorCode,
        });
      }
      // R04 §3：同上——终态事务不释放 WorkspaceWriteLock，只把 Authority 置为终态；
      // 物理 Writer 由持久释放 lane 按 W→I 顺序撤销并留存真实 stop/drain 回执。
      await tx
        .update(executionOwnershipTable)
        .set({
          ownershipState: "released",
          releasedAt: now,
          reasonCode: "execution_terminal",
          versionNo: sql`${executionOwnershipTable.versionNo} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(executionOwnershipTable.tenantId, invocation.tenantId),
            eq(executionOwnershipTable.id, ownershipId),
            eq(executionOwnershipTable.invocationId, invocation.id),
          ),
        );
      // R02 §8：终态收口同样只经仓储方法（行锁 + 单向转换表）。
      await closeRuntimeSessionBindingInTransaction(tx, {
        tenantId: invocation.tenantId,
        id: sessionBindingId,
        expectedVersionNo: sessionVersionNo,
      });
      await tx
        .update(invocationTable)
        .set({
          executionState: state,
          finishedAt: now,
          resultRef,
          resultDigest,
          errorCode,
          // §3：终态也是"已应用事实"，但水位必须与终态**同一条** UPDATE 提交——
          // 下面紧跟 bridgeInvocationTerminalToJob，JobCommand.terminalVersion 必须
          // 等于最终提交版本，桥接之后再写 Invocation 会让它落后。
          recoveryVersion: invocation.recoveryVersion + 1,
          versionNo: invocation.versionNo + 1,
          updatedAt: now,
        })
        .where(eq(invocationTable.id, invocation.id));
      const [terminalRow] = await tx
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, invocation.id))
        .limit(1);
      if (!terminalRow) throw new IngressInvocationNotFoundError(invocation.id);
      await bridgeInvocationTerminalToJob(tx, terminalRow, now);
      return terminalRow;
    }
  }
  const [updated] = await tx
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, invocation.id))
    .limit(1);
  if (!updated) throw new IngressInvocationNotFoundError(invocation.id);
  return advanceRecoveryVersionIfApplied(tx, updated, invocation.executionState, event, now);
}

async function resolveSuspensionRecovery(input: {
  tx: IngressTx;
  invocation: Invocation;
  event: RuntimeEvent;
  binding: typeof executionBindingTable.$inferSelect;
  attemptId: string;
  ownershipId: string;
}): Promise<{ checkpointId: string | null; anchor: unknown; anchorDigest: string }> {
  const checkpointId =
    typeof input.event.payload.checkpointId === "string" ? input.event.payload.checkpointId : null;
  const anchorDigest =
    typeof input.event.payload.resumeAnchorDigest === "string"
      ? input.event.payload.resumeAnchorDigest
      : null;
  if (!anchorDigest || !/^sha256:[0-9a-f]{64}$/.test(anchorDigest))
    throw new Error("CheckpointStale");
  const [workspace] = await input.tx
    .select()
    .from(workspaceBinding)
    .where(
      and(
        eq(workspaceBinding.tenantId, input.invocation.tenantId),
        eq(workspaceBinding.id, input.binding.workspaceBindingId),
      ),
    )
    .for("update")
    .limit(1);
  if (!workspace) throw new Error("WorkspaceNotReady");
  if (!checkpointId) {
    if (workspace.continuityMode === "CHECKPOINT_RESTORABLE") throw new Error("CheckpointStale");
    return {
      checkpointId: null,
      anchor: {
        kind: "runtime-suspension",
        invocationId: input.invocation.id,
        producerEventId: input.event.eventId,
        producerSequence: input.event.producerSequence,
      },
      anchorDigest,
    };
  }
  if (!input.binding.environmentDefinitionRevisionId)
    throw new Error("EnvironmentRevisionMismatch");
  const [checkpoint] = await input.tx
    .select()
    .from(filesystemCheckpointTable)
    .where(
      and(
        eq(filesystemCheckpointTable.tenantId, input.invocation.tenantId),
        eq(filesystemCheckpointTable.id, checkpointId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !checkpoint ||
    checkpoint.invocationId !== input.invocation.id ||
    checkpoint.attemptId !== input.attemptId ||
    checkpoint.ownershipId !== input.ownershipId ||
    checkpoint.workspaceBindingId !== input.binding.workspaceBindingId ||
    checkpoint.environmentDefinitionRevisionId !== input.binding.environmentDefinitionRevisionId ||
    checkpoint.recoveryAnchorDigest !== anchorDigest ||
    checkpoint.recoveryVersion !== input.invocation.checkpointRecoveryVersion ||
    checkpoint.producerSequence !== input.invocation.checkpointProducerSequence
  ) {
    throw new Error("CheckpointStale");
  }
  return {
    checkpointId: checkpoint.id,
    anchor: checkpoint.recoveryAnchor,
    anchorDigest: checkpoint.recoveryAnchorDigest,
  };
}

export async function ingressRuntimeEvents(
  input: IngressRuntimeEventsInput,
): Promise<IngressRuntimeEventsResult> {
  const parsed = RuntimeEventBatchSchema.parse(input.batch);
  if (parsed.authority.invocationId !== input.invocationId)
    throw new IngressAuthorityMismatchError(input.invocationId);
  if (parsed.events.length === 0) throw new IngressBatchEmptyError(input.invocationId);
  assertBatchSetConsistency(parsed.events);
  const now = input.receivedAt ?? new Date();
  const result = await db.transaction(async (tx) => {
    const invocation = await lockInvocation(tx, input.tenantId, input.invocationId);
    const newEvents: Array<{ event: RuntimeEvent; payloadHash: string }> = [];
    const receipts: EventReceipt[] = [];
    const replayedEventIds: string[] = [];
    let expected = invocation.lastProducerSequence + 1;
    for (const event of parsed.events) {
      const payloadHash = computeEventPayloadHash(event);
      const existing = await findExisting(tx, input.tenantId, input.invocationId, event);
      if (existing.kind === "conflict") {
        throw new ProducerSequenceGapError(input.invocationId, existing.reason, event.eventId);
      }
      if (existing.kind === "exact") {
        const row = existing.row;
        if (
          row.payloadHash !== payloadHash ||
          row.candidateType !== event.type ||
          row.schemaVersion !== event.schemaVersion
        ) {
          throw new EventPayloadHashConflictError(
            input.invocationId,
            event.eventId,
            event.producerSequence,
            row.payloadHash,
            payloadHash,
          );
        }
        const receipt = receiptFromRow(row);
        if (!sameAuthority(receipt.acceptedAuthority, parsed.authority))
          throw new IngressAuthorityMismatchError(input.invocationId);
        receipts.push(receipt);
        replayedEventIds.push(event.eventId);
        continue;
      }
      const sequence = toNumber(event.producerSequence);
      if (sequence !== expected)
        throw new ProducerSequenceGapError(
          input.invocationId,
          String(expected),
          event.producerSequence,
        );
      expected += 1;
      newEvents.push({ event, payloadHash });
    }
    if (newEvents.length === 0) {
      return {
        invocationId: input.invocationId,
        receipts,
        replayedEventIds,
        acceptedThroughProducerSequence: String(invocation.lastProducerSequence),
      };
    }
    if (INVOCATION_TERMINAL_STATES.includes(invocation.executionState))
      throw new IngressInvocationTerminalError(input.invocationId, invocation.executionState);
    // 本批的序列水位在本事务中先归并一次：终态写入与 Job 终态桥必须是这条 Invocation
    // 在本事务内的最后一次状态写入，否则 JobCommand.terminalVersion 会落后于实际版本。
    const lastSequence = toNumber(newEvents[newEvents.length - 1]?.event.producerSequence ?? "0");
    await tx
      .update(invocationTable)
      .set({
        lastProducerSequence: lastSequence,
        versionNo: sql`${invocationTable.versionNo} + 1`,
        updatedAt: now,
      })
      .where(eq(invocationTable.id, invocation.id));
    const [afterWatermark] = await tx
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, invocation.id))
      .limit(1);
    if (!afterWatermark) throw new IngressInvocationNotFoundError(input.invocationId);

    const newReceipts: EventReceipt[] = [];
    let lifecycleInvocation = afterWatermark;
    for (const { event, payloadHash } of newEvents) {
      if (INVOCATION_TERMINAL_STATES.includes(lifecycleInvocation.executionState))
        throw new IngressInvocationTerminalError(
          input.invocationId,
          lifecycleInvocation.executionState,
        );
      const requiredPhase = event.type === "execution.started" ? "dispatching" : "executing";
      const operationKind = classifyOperationKind(event);
      const authority = await requireIngressAuthority(
        tx,
        input.tenantId,
        parsed.authority,
        requiredPhase,
        operationKind,
      );
      if (operationKind === "accepted_action_completion") {
        await assertAcceptedParentAction(tx, input.tenantId, input.invocationId, event);
      }
      if (event.type === "job.step.accepted") {
        assertJobStepAcceptedFacts(lifecycleInvocation, event, authority.binding);
      }
      validateExecutionStarted(event, authority.session);
      const mapped = await mapEvent(tx, lifecycleInvocation, event);
      const ingressId = randomUUID();
      // 与 applyLifecycle 共用同一判定，避免"receipt 记了推进、Invocation 却没写"的双轨。
      // 终态事件同样计入，且 applyLifecycle 把水位与终态放在同一条 UPDATE 提交，二者必然一致。
      const recoveryVersionAfter =
        lifecycleInvocation.recoveryVersion +
        (advancesRecoveryVersion(event, lifecycleInvocation.executionState) ? 1 : 0);
      const receipt: EventReceipt = {
        eventId: event.eventId,
        producerSequence: event.producerSequence,
        ingressId,
        acceptedAt: now.getTime(),
        acceptedAuthority: parsed.authority,
        mappedReferences: { itemId: mapped.itemId, threadEventId: mapped.threadEventId },
        recoveryVersionAfter: String(recoveryVersionAfter),
      };
      await tx.insert(runtimeEventIngressTable).values({
        id: ingressId,
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        acceptedAttemptId: parsed.authority.attemptId,
        acceptedOwnershipId: parsed.authority.ownershipId,
        acceptedSessionId: parsed.authority.sessionBindingId,
        acceptedEpoch: toNumber(parsed.authority.leaseEpoch),
        producerEventId: event.eventId,
        producerSequence: toNumber(event.producerSequence),
        candidateType: event.type,
        schemaVersion: event.schemaVersion,
        payloadHash,
        payloadJson: event.payload,
        receiptJson: receipt,
        recoveryVersionAfter,
        receivedAt: now,
        acceptedAt: now,
      });
      newReceipts.push(receipt);
      lifecycleInvocation = await applyLifecycle(
        tx,
        lifecycleInvocation,
        event,
        now,
        authority.attempt.id,
        authority.owner.id,
        parsed.authority.sessionBindingId,
        authority.binding,
        authority.session.versionNo,
      );
    }
    return {
      invocationId: input.invocationId,
      receipts: [...receipts, ...newReceipts].sort(
        (a, b) => toNumber(a.producerSequence) - toNumber(b.producerSequence),
      ),
      replayedEventIds,
      acceptedThroughProducerSequence: String(lastSequence),
    };
  });
  // ─── Post-commit：子线程终态协调 ────────────────────────────
  // Runtime 终态事件经正式 ingress 落库后（事务已提交），若该 Invocation 属于某个
  // delegate 子 Thread 且已进入终态，自动调用 handleChildThreadTerminal：
  // - completed/failed → projectChildThreadResult（父线程结构化结果投影）
  // - cancelled → finalizeChildThreadCancellation（取消 ack 落库）
  // 这使 child-thread-isolation / child-cancel-requires-ack 的"终态自动接线"真正成立。
  await coordinateChildThreadTerminal(input.tenantId, input.invocationId);
  return result;
}

/**
 * 子线程终态协调（post-commit）。
 *
 * ingress 事务把子 Invocation 推向终态后调用；`handleChildThreadTerminal` 内部按
 * childThreadId 查 delegate ThreadRelation——非 delegate 线程返回 skipped（无副作用），
 * delegate 线程按其终态投影结果/终结取消。子线程终态事件顺序稳定，由 ingress 事务
 * 与 handleChildThreadTerminal 各自独立事务（父/子线程行锁不重叠）保证。
 */
async function coordinateChildThreadTerminal(
  tenantId: string,
  invocationId: string,
): Promise<void> {
  const invocation = await getInvocationById(tenantId, invocationId);
  if (!invocation) return;
  if (!invocation.threadId) return;
  const terminalState = invocation.executionState;
  if (
    terminalState !== "completed" &&
    terminalState !== "failed" &&
    terminalState !== "cancelled"
  ) {
    // lost 等其他终态不触发 child 投影/取消终结（保持 fail-closed）。
    return;
  }
  await handleChildThreadTerminal({
    tenantId,
    childThreadId: invocation.threadId,
    terminalState,
  });
}

export async function getIngressByInvocation(
  tenantId: string,
  invocationId: string,
  options?: { afterSequence?: number; limit?: number },
) {
  const query = db
    .select()
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, tenantId),
        eq(runtimeEventIngressTable.invocationId, invocationId),
        options?.afterSequence === undefined
          ? sql`1=1`
          : sql`${runtimeEventIngressTable.producerSequence} > ${options.afterSequence}`,
      ),
    )
    .orderBy(asc(runtimeEventIngressTable.producerSequence));
  return options?.limit === undefined
    ? query
    : query.limit(Math.min(Math.max(options.limit, 1), 500));
}

export async function getIngressByProducerEventId(
  tenantId: string,
  invocationId: string,
  producerEventId: string,
) {
  const [row] = await db
    .select()
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, tenantId),
        eq(runtimeEventIngressTable.invocationId, invocationId),
        eq(runtimeEventIngressTable.producerEventId, producerEventId),
      ),
    )
    .limit(1);
  return row ?? null;
}
