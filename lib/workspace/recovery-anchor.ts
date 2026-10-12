/**
 * 服务端唯一的 RecoveryAnchor 构建器（R09 §1）。
 *
 * 锚点必须由**已提交的正式事实**构建，不能接受调用方提交的成员数组：
 * - `consumedInputRefs` 与 `unconsumedInputWatermark` 完全由服务端从 RuntimeEventIngress
 *   推导。调用方连"哪些输入已被消费"都不需要（也不允许）声明——这从结构上消除了
 *   "把未消费输入伪造成已消费"（丢数据）与"把已消费输入伪造成未消费"（重复消费）两条路径。
 * - `actionFacts` / `childFacts` / `resolvedUserActionRefs` 是**待核验声明**：调用方只能提交
 *   引用 id，服务端逐条查库核验租户、正式身份、事件类型、结果 digest 与已消费状态，
 *   并只把核验通过的归一化事实写进锚点。声明里的任何自由载荷都不会进入锚点。
 *
 * 跨域或不存在（含租户不匹配、invocation 不匹配、结果 digest 不自洽、水位未推进）的引用
 * 一律拒绝，绝不静默丢弃后返回一个"看起来完整"的锚点。
 */
import { type DbOrTx, db } from "@/lib/db/client";
import { agentCallTable } from "@/lib/persistence/schema/agent-calls";
import {
  executionBindingTable,
  executionOwnershipTable,
  invocationTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { computeEventPayloadHash, protocolDigest } from "@/lib/runtime/runtime-protocol";
import { and, asc, eq } from "drizzle-orm";

/** 输入类事件：只有这些事件承载"新用户/服务输入"。 */
export const RECOVERY_ANCHOR_INPUT_EVENT_TYPES = ["user-action"] as const;

/**
 * 已应用行动类事件：模型/行动结果与 Job step 结果被正式采用的事实。
 * `harness.action.proposed` / `harness.action.started` 只是进行中状态，不是结果。
 */
export const RECOVERY_ANCHOR_ACTION_EVENT_TYPES = [
  "action",
  "harness.action.completed",
  "harness.action.failed",
  "job.step.completed",
  "job.step.failed",
] as const;

const INPUT_EVENT_TYPES: readonly string[] = RECOVERY_ANCHOR_INPUT_EVENT_TYPES;
const ACTION_EVENT_TYPES: readonly string[] = RECOVERY_ANCHOR_ACTION_EVENT_TYPES;

/** 归一化事实：只保留可重建、可核验的稳定字段，不复制调用方载荷。 */
export interface RecoveryAnchorFact {
  ref: string;
  factType: string;
  producerSequence: string;
  evidenceDigest: string;
}

export interface RecoveryAnchor {
  invocationId: string;
  bindingDigest: string;
  recoveryVersion: string;
  producerSequence: string;
  consumedInputRefs: RecoveryAnchorFact[];
  actionFacts: RecoveryAnchorFact[];
  childFacts: RecoveryAnchorFact[];
  resolvedUserActionRefs: RecoveryAnchorFact[];
  /** 水位：producerSequence ≤ 该值的输入事件全部已被正式消费。 */
  unconsumedInputWatermark: string;
}

/**
 * 调用方提交的待核验声明。注意没有 `consumedInputRefs`：输入消费事实由服务端推导。
 */
export interface RecoveryAnchorDeclarations {
  /** 待核验的未消费输入水位声明；与推导值不一致时拒绝。 */
  unconsumedInputWatermark?: string;
  actionFacts?: readonly string[];
  childFacts?: readonly string[];
  resolvedUserActionRefs?: readonly string[];
}

export class RecoveryAnchorRejectedError extends Error {
  constructor(
    readonly reasonCode: string,
    detail: string,
  ) {
    // 稳定错误码置于消息首位：调用方/fail-closed 判定只看稳定码，reasonCode 供排障。
    super(`CheckpointStale [${reasonCode}] ${detail}`);
    this.name = "CheckpointStale";
  }
}

function reject(reasonCode: string, detail: string): never {
  throw new RecoveryAnchorRejectedError(reasonCode, detail);
}

/** 重复引用必须先于核验被发现：同一事实被声明两次会掩盖调用方状态机的错误。 */
function assertNoDuplicates(refs: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) reject("DuplicateMember", `${label} 重复声明 ${ref}`);
    seen.add(ref);
  }
}

function sortFacts(facts: RecoveryAnchorFact[]): RecoveryAnchorFact[] {
  return facts.sort((a, b) => {
    const left = BigInt(a.producerSequence);
    const right = BigInt(b.producerSequence);
    if (left !== right) return left < right ? -1 : 1;
    return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  });
}

/**
 * 构建并返回服务端唯一的 RecoveryAnchor。
 *
 * 调用方只需给出 invocation 的正式身份与（可选的）待核验声明；其余全部读库推导。
 */
export async function buildRecoveryAnchor(
  input: {
    tenantId: string;
    invocationId: string;
    ownershipId: string;
    declarations?: RecoveryAnchorDeclarations;
  },
  executor: DbOrTx = db,
): Promise<RecoveryAnchor> {
  const declarations = input.declarations;
  const [binding] = await executor
    .select()
    .from(executionBindingTable)
    .where(
      and(
        eq(executionBindingTable.tenantId, input.tenantId),
        eq(executionBindingTable.invocationId, input.invocationId),
      ),
    )
    .limit(1);
  if (!binding) reject("MissingInvocationFacts", `ExecutionBinding 不存在: ${input.invocationId}`);
  const [owner] = await executor
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.id, input.ownershipId),
        eq(executionOwnershipTable.invocationId, input.invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .limit(1);
  if (!owner) reject("NotCurrentExecutor", `Ownership 不是当前有效执行者: ${input.ownershipId}`);

  const rows = await executor
    .select()
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, input.tenantId),
        eq(runtimeEventIngressTable.invocationId, input.invocationId),
      ),
    )
    .orderBy(asc(runtimeEventIngressTable.producerSequence));

  // `advanced` = 这一行的被接纳确实推进了恢复水位（§3 推进表）。这是"已被正式消费/采用"
  // 在库里的单调证据，未消费输入与控制元数据不会推进它。推导规则与 §4 的恢复期重建
  // 共用 `deriveLedger`，保证冻结与恢复看到的是同一条规则。
  const ledger = deriveLedger(rows);
  const { byId: byIngressId, advancedById, consumedInputs, watermark } = ledger;
  if (
    declarations?.unconsumedInputWatermark !== undefined &&
    declarations.unconsumedInputWatermark !== String(watermark)
  ) {
    reject(
      "WatermarkMismatch",
      `声明的未消费水位 ${declarations.unconsumedInputWatermark} 与正式事实推导值 ${watermark} 不一致`,
    );
  }

  const actionFacts = (declarations?.actionFacts ?? []).map((ref) => {
    const fact = verifyIngressFact(byIngressId.get(ref), ref, ACTION_EVENT_TYPES, "actionFacts");
    // 「被 Loop 正式采用」必须留下水位证据：未推进水位的行动事实不能进锚点，
    // 否则恢复后会重复应用一个已经产生副作用的行动结果。
    if (advancedById.get(ref) !== true)
      reject("ActionFactNotApplied", `actionFacts 引用未应用事实: ${ref}`);
    return fact;
  });

  const childFacts: RecoveryAnchorFact[] = [];
  for (const ref of declarations?.childFacts ?? []) {
    const [call] = await executor
      .select()
      .from(agentCallTable)
      .where(and(eq(agentCallTable.tenantId, input.tenantId), eq(agentCallTable.id, ref)))
      .limit(1);
    if (!call || call.parentInvocationId !== input.invocationId)
      reject("MissingMember", `childFacts 引用不存在或跨域: ${ref}`);
    if (call.state !== "completed" && call.state !== "failed" && call.state !== "cancelled")
      reject("UnfinishedMember", `childFacts 引用非终态 AgentCall: ${ref}`);
    if (!call.resultDigest) reject("MissingResultDigest", `childFacts 缺少结果 digest: ${ref}`);
    childFacts.push({
      ref: call.id,
      factType: `agent_call.${call.state}`,
      producerSequence: String(call.versionNo),
      evidenceDigest: call.resultDigest,
    });
  }

  const resolvedUserActionRefs: RecoveryAnchorFact[] = [];
  for (const ref of declarations?.resolvedUserActionRefs ?? []) {
    const [request] = await executor
      .select()
      .from(userActionRequestTable)
      .where(
        and(
          eq(userActionRequestTable.tenantId, input.tenantId),
          eq(userActionRequestTable.id, ref),
        ),
      )
      .limit(1);
    if (!request || request.invocationId !== input.invocationId)
      reject("MissingMember", `resolvedUserActionRefs 引用不存在或跨域: ${ref}`);
    if (request.requestState !== "resolved" || !request.resolution)
      reject("UnresolvedMember", `resolvedUserActionRefs 引用未解析请求: ${ref}`);
    resolvedUserActionRefs.push({
      ref: request.id,
      factType: `user_action.${request.requestType}.${request.resolution}`,
      producerSequence: String(request.versionNo),
      // 结果 digest 由服务端从事实重算，不接受调用方提供的摘要。
      evidenceDigest: protocolDigest({
        id: request.id,
        requestType: request.requestType,
        resolution: request.resolution,
        resolvedAt: request.resolvedAt?.getTime() ?? null,
        response: request.responseRedactedJson,
      }),
    });
  }

  const [invocation] = await executor
    .select({
      recoveryVersion: invocationTable.recoveryVersion,
      lastProducerSequence: invocationTable.lastProducerSequence,
    })
    .from(invocationTable)
    .where(
      and(eq(invocationTable.tenantId, input.tenantId), eq(invocationTable.id, input.invocationId)),
    )
    .limit(1);
  if (!invocation) reject("MissingInvocationFacts", `Invocation 不存在: ${input.invocationId}`);

  assertNoDuplicates(declarations?.actionFacts ?? [], "actionFacts");
  assertNoDuplicates(declarations?.childFacts ?? [], "childFacts");
  assertNoDuplicates(declarations?.resolvedUserActionRefs ?? [], "resolvedUserActionRefs");

  return {
    invocationId: input.invocationId,
    bindingDigest: binding.configHash,
    recoveryVersion: String(invocation.recoveryVersion),
    producerSequence: String(invocation.lastProducerSequence),
    consumedInputRefs: sortFacts(consumedInputs),
    actionFacts: sortFacts(actionFacts),
    childFacts: sortFacts(childFacts),
    resolvedUserActionRefs: sortFacts(resolvedUserActionRefs),
    unconsumedInputWatermark: String(watermark),
  };
}

function ingressFact(row: {
  id: string;
  candidateType: string;
  producerSequence: bigint;
  payloadHash: string;
}): RecoveryAnchorFact {
  return {
    ref: row.id,
    factType: row.candidateType,
    producerSequence: String(row.producerSequence),
    evidenceDigest: row.payloadHash,
  };
}

function verifyIngressFact(
  row: typeof runtimeEventIngressTable.$inferSelect | undefined,
  ref: string,
  allowedTypes: readonly string[],
  label: string,
): RecoveryAnchorFact {
  if (!row) reject("MissingMember", `${label} 引用不存在或跨域: ${ref}`);
  if (!allowedTypes.includes(row.candidateType))
    reject("WrongFactType", `${label} 引用类型 ${row.candidateType} 不属于该事实类: ${ref}`);
  // 结果 digest 必须与服务端按落库载荷重算的值一致：被改写过的账本行不能冒充正式事实。
  const recomputed = computeEventPayloadHash({
    eventId: row.producerEventId,
    producerSequence: String(row.producerSequence),
    type: row.candidateType as never,
    schemaVersion: row.schemaVersion,
    payload: row.payloadJson as Record<string, unknown>,
  });
  if (recomputed !== row.payloadHash)
    reject("EvidenceDigestMismatch", `${label} 引用的事实结果 digest 不自洽: ${ref}`);
  return ingressFact(row);
}

export function computeRecoveryAnchorDigest(anchor: RecoveryAnchor): string {
  return protocolDigest(anchor);
}

/**
 * 从持久事实里读回 Anchor 时的形状校验。
 *
 * `FilesystemCheckpoint.recoveryAnchor` 是 JSON 列（drizzle 侧类型为 `unknown`）。
 * 直接 `as RecoveryAnchor` 会让形状被篡改的锚点在后续 `.map` / 字段读取处崩溃，
 * 表现为一个含义模糊的运行时错误；这里显式收敛为 `null`，由调用方判 `CheckpointIntegrityFailed`。
 */
export function parseRecoveryAnchor(value: unknown): RecoveryAnchor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const anchor = value as Record<string, unknown>;
  const requiredStrings = [
    "invocationId",
    "bindingDigest",
    "recoveryVersion",
    "producerSequence",
    "unconsumedInputWatermark",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof anchor[key] !== "string") return null;
  }
  const factGroups = [
    "consumedInputRefs",
    "actionFacts",
    "childFacts",
    "resolvedUserActionRefs",
  ] as const;
  for (const key of factGroups) {
    const group = anchor[key];
    if (!Array.isArray(group)) return null;
    for (const fact of group) {
      if (!fact || typeof fact !== "object" || Array.isArray(fact)) return null;
      const candidate = fact as Record<string, unknown>;
      if (
        typeof candidate.ref !== "string" ||
        typeof candidate.factType !== "string" ||
        typeof candidate.producerSequence !== "string" ||
        typeof candidate.evidenceDigest !== "string"
      ) {
        return null;
      }
    }
  }
  return anchor as unknown as RecoveryAnchor;
}

// ---------------------------------------------------------------------------
// §4：恢复期从**当前正式事实**重建允许的恢复边界，并与 Checkpoint 的完整 Anchor 核对。
//
// 这里刻意不复用 `checkpoint.checkpointRecoveryVersion` / `checkpointProducerSequence`
// 与 Checkpoint 自身比较（那样恒真）。重建走的是与冻结期完全相同的推导路径：读一遍
// 当前 RuntimeEventIngress 账本 + Invocation 当前水位，然后逐项对齐。
//
// 允许的差异只有一种：Checkpoint 之后到达的**未消费输入**与控制元数据（它们不推进
// recoveryVersion，也不改变已消费水位）。任何已经应用的行动/Job step 结果都会把
// recoveryVersion 抬高，从而使 `appliedHighWater` 越过 Anchor 的水位 → CheckpointStale。
// ---------------------------------------------------------------------------

/**
 * 用当前账本推导"已消费输入集合 + 已消费水位 + 已应用事实水位"。
 * 与 `buildRecoveryAnchor` 共用同一条推导规则，避免两处规则漂移。
 */
interface LedgerDerivation {
  rows: (typeof runtimeEventIngressTable.$inferSelect)[];
  byId: Map<string, typeof runtimeEventIngressTable.$inferSelect>;
  advancedById: Map<string, boolean>;
  consumedInputs: RecoveryAnchorFact[];
  watermark: bigint;
  /** 已应用（推进过 recoveryVersion）事实的最大 producerSequence；没有则为 0。 */
  appliedHighWater: bigint;
}

function deriveLedger(rows: (typeof runtimeEventIngressTable.$inferSelect)[]): LedgerDerivation {
  const advancedById = new Map<string, boolean>();
  const consumedInputs: RecoveryAnchorFact[] = [];
  let previousRecoveryVersion: number | null = null;
  let watermark = 0n;
  let appliedHighWater = 0n;
  let interrupted = false;
  for (const row of rows) {
    // `advanced` = 这一行的被接纳确实推进了恢复水位（§3 推进表）。这是"已被正式消费/采用"
    // 在库里的单调证据，未消费输入与控制元数据不会推进它。
    const advanced =
      previousRecoveryVersion !== null && row.recoveryVersionAfter > previousRecoveryVersion;
    advancedById.set(row.id, advanced);
    previousRecoveryVersion = row.recoveryVersionAfter;
    if (advanced && row.producerSequence > appliedHighWater)
      appliedHighWater = row.producerSequence;
    if (!INPUT_EVENT_TYPES.includes(row.candidateType)) continue;
    if (advanced && !interrupted) {
      watermark = row.producerSequence;
      consumedInputs.push(ingressFact(row));
    } else {
      // 首个未消费输入之后的输入都不能计入水位——水位表达"整段已消费"。
      interrupted = true;
    }
  }
  return {
    rows,
    byId: new Map(rows.map((row) => [row.id, row] as const)),
    advancedById,
    consumedInputs,
    watermark,
    appliedHighWater,
  };
}

/** 事实成员集合必须逐项与 Anchor 记载等价（顺序由 Anchor 内部排序规则决定）。 */
function sameFacts(
  left: readonly RecoveryAnchorFact[],
  right: readonly RecoveryAnchorFact[],
): boolean {
  if (left.length !== right.length) return false;
  const key = (fact: RecoveryAnchorFact) =>
    `${fact.ref}\u0000${fact.factType}\u0000${fact.producerSequence}\u0000${fact.evidenceDigest}`;
  const leftKeys = left.map(key).sort();
  const rightKeys = right.map(key).sort();
  return leftKeys.every((value, index) => value === rightKeys[index]);
}

async function assertRecoveryBoundaryIntact(
  input: { tenantId: string; invocationId: string; anchor: RecoveryAnchor },
  executor: DbOrTx = db,
): Promise<void> {
  const anchor = input.anchor;
  if (anchor.invocationId !== input.invocationId)
    reject(
      "AnchorInvocationMismatch",
      `Anchor 归属 ${anchor.invocationId}，当前恢复 ${input.invocationId}`,
    );

  // 1) Binding 摘要仍与 Anchor 冻结时一致——契约/存储归属变了就不能拿旧 Snapshot 恢复。
  const [binding] = await executor
    .select()
    .from(executionBindingTable)
    .where(
      and(
        eq(executionBindingTable.tenantId, input.tenantId),
        eq(executionBindingTable.invocationId, input.invocationId),
      ),
    )
    .limit(1);
  if (!binding) reject("MissingInvocationFacts", `ExecutionBinding 不存在: ${input.invocationId}`);
  if (binding.configHash !== anchor.bindingDigest)
    reject(
      "BindingChanged",
      `Binding 摘要已变化: ${binding.configHash} != ${anchor.bindingDigest}`,
    );

  // 2) 账本重建。
  const rows = await executor
    .select()
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, input.tenantId),
        eq(runtimeEventIngressTable.invocationId, input.invocationId),
      ),
    )
    .orderBy(asc(runtimeEventIngressTable.producerSequence));
  const ledger = deriveLedger(rows);

  // 3) 已消费输入集合与水位必须逐项相同：被回退（丢数据）或被追加消费（重复消费）都拒绝。
  if (!sameFacts(ledger.consumedInputs, anchor.consumedInputRefs))
    reject("ConsumedInputsDiverged", "当前已消费输入集合与 Anchor 不一致");
  if (String(ledger.watermark) !== anchor.unconsumedInputWatermark)
    reject(
      "WatermarkMismatch",
      `当前已消费水位 ${ledger.watermark} 与 Anchor ${anchor.unconsumedInputWatermark} 不一致`,
    );

  // 4) 已应用事实不能越过 Anchor 水位。未消费输入/控制元数据不在此列（它们不推进水位）。
  if (ledger.appliedHighWater > BigInt(anchor.producerSequence))
    reject(
      "AppliedFactAfterCheckpoint",
      `Checkpoint 之后已应用事实 producerSequence=${ledger.appliedHighWater} 超出锚点 ${anchor.producerSequence}`,
    );

  // 5) Invocation 当前水位：recoveryVersion 必须与 Anchor 相同（任何推进都会被第 4 步捕获，
  //    这里再核一次是为了覆盖"推进了未入账本的版本变化"这种不自洽状态）。
  const [invocation] = await executor
    .select({
      recoveryVersion: invocationTable.recoveryVersion,
      lastProducerSequence: invocationTable.lastProducerSequence,
    })
    .from(invocationTable)
    .where(
      and(eq(invocationTable.tenantId, input.tenantId), eq(invocationTable.id, input.invocationId)),
    )
    .limit(1);
  if (!invocation) reject("MissingInvocationFacts", `Invocation 不存在: ${input.invocationId}`);
  if (String(invocation.recoveryVersion) !== anchor.recoveryVersion)
    reject(
      "RecoveryVersionAdvanced",
      `当前 recoveryVersion ${invocation.recoveryVersion} 与 Anchor ${anchor.recoveryVersion} 不一致`,
    );
  if (invocation.lastProducerSequence < BigInt(anchor.producerSequence))
    reject(
      "ProducerSequenceRegressed",
      `当前 producerSequence ${invocation.lastProducerSequence} 回退到锚点 ${anchor.producerSequence} 之前`,
    );

  // 6) 声明类成员必须仍是有效正式事实（不是"Anchor 与自己比"，是拿当前事实逐条回读）。
  for (const fact of anchor.actionFacts) {
    const current = verifyIngressFact(
      ledger.byId.get(fact.ref),
      fact.ref,
      ACTION_EVENT_TYPES,
      "actionFacts",
    );
    if (current.evidenceDigest !== fact.evidenceDigest || current.factType !== fact.factType)
      reject("MemberDiverged", `actionFacts 成员与当前事实不一致: ${fact.ref}`);
    if (ledger.advancedById.get(fact.ref) !== true)
      reject("ActionFactNotApplied", `actionFacts 引用的事实已不再是已应用状态: ${fact.ref}`);
  }
  for (const fact of anchor.childFacts) {
    const [call] = await executor
      .select()
      .from(agentCallTable)
      .where(and(eq(agentCallTable.tenantId, input.tenantId), eq(agentCallTable.id, fact.ref)))
      .limit(1);
    if (!call || call.parentInvocationId !== input.invocationId)
      reject("MemberDiverged", `childFacts 成员不存在或跨域: ${fact.ref}`);
    if (call.state !== "completed" && call.state !== "failed" && call.state !== "cancelled")
      reject("MemberDiverged", `childFacts 成员已非终态: ${fact.ref}`);
    if (!call.resultDigest || call.resultDigest !== fact.evidenceDigest)
      reject("MemberDiverged", `childFacts 成员结果 digest 不一致: ${fact.ref}`);
  }
  for (const fact of anchor.resolvedUserActionRefs) {
    const [request] = await executor
      .select()
      .from(userActionRequestTable)
      .where(
        and(
          eq(userActionRequestTable.tenantId, input.tenantId),
          eq(userActionRequestTable.id, fact.ref),
        ),
      )
      .limit(1);
    if (!request || request.invocationId !== input.invocationId)
      reject("MemberDiverged", `resolvedUserActionRefs 成员不存在或跨域: ${fact.ref}`);
    if (request.requestState !== "resolved" || !request.resolution)
      reject("MemberDiverged", `resolvedUserActionRefs 成员已非 resolved: ${fact.ref}`);
    const recomputed = protocolDigest({
      id: request.id,
      requestType: request.requestType,
      resolution: request.resolution,
      resolvedAt: request.resolvedAt?.getTime() ?? null,
      response: request.responseRedactedJson,
    });
    // 允许的唯一差异是"之后再次刷新的 response 载荷"——此处按 §4 严格拒绝，
    // 由上层决定重新冻结与新 Checkpoint，而不是静默采用被改写的事实。
    if (recomputed !== fact.evidenceDigest)
      reject("MemberDiverged", `resolvedUserActionRefs 成员结果 digest 不一致: ${fact.ref}`);
  }
}

/**
 * §4 公开入口：恢复前用它核对"当前事实仍允许这次恢复"。
 * 不通过时抛 `CheckpointStale [reason] ...`，调用方必须 fail-closed。
 */
export async function assertRestoreBoundary(
  input: { tenantId: string; invocationId: string; anchor: RecoveryAnchor },
  executor: DbOrTx = db,
): Promise<void> {
  await assertRecoveryBoundaryIntact(input, executor);
}
