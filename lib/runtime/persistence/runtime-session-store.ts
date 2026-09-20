/**
 * RuntimeSessionBinding persistence: one logical session per ownership generation.
 *
 * R02 §8（Session 写入规范）：
 * - **本模块是 Session 的唯一写入口**。所有写方法都必需真实事务（`SessionTx`），
 *   没有 `executor = db` 的自动提交路径；调用方必须先持有 Invocation 根锁。
 * - 每次写入都 `SELECT ... FOR UPDATE` 锁当前行，并用调用方读到的 `versionNo`
 *   做 CAS；迟到的 ACK/旧代际 Worker 因此不可能覆盖新状态
 *   （不匹配抛 `RuntimeSessionVersionConflictError`）。
 * - 生命周期是**单向**的声明式转换表（`assertSessionTransition`），
 *   不再用散落的 `if (state === ...)` 修补无条件 UPDATE。
 */
import { randomUUID } from "node:crypto";
import type { DbOrTx } from "@/lib/db/client";
import { db } from "@/lib/db/client";
import {
  type RuntimeSessionBinding,
  type RuntimeSessionBindingState,
  type RuntimeSessionIntentType,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { RuntimeSessionBindingNotFoundError } from "@/lib/runtime/errors";
import { canonicalizeJson } from "@/lib/runtime/runtime-protocol";
import { type SQL, and, desc, eq, sql } from "drizzle-orm";

export type SessionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 迟到写入被版本 CAS 拒绝：调用方持有的行版本已经不是当前行版本。 */
export class RuntimeSessionVersionConflictError extends Error {
  constructor(
    readonly sessionBindingId: string,
    readonly expectedVersionNo: number,
    readonly actualVersionNo: number,
  ) {
    super(
      `RuntimeSessionBinding 版本冲突（id=${sessionBindingId} expected=${expectedVersionNo} actual=${actualVersionNo}）`,
    );
    this.name = "RuntimeSessionVersionConflictError";
  }
}

/**
 * 单向生命周期转换表（R02 §8）。
 *
 * `dispatching` 自转换为重发/重试；`active` 只允许自转换与收口；
 * `closed`/`lost` 是终态，只能自转换（幂等），
 * 因此「把 active/closed/lost Session 改回 dispatching」在类型层面就不可能成立。
 */
const SESSION_TRANSITIONS: Record<RuntimeSessionBindingState, RuntimeSessionBindingState[]> = {
  // `prepared → active` 允许：平台可能在一个事务内完成「派发接纳 + execution.started」，
  // 中间态没有单独的写入。反向（active → dispatching/prepared）永不允许。
  prepared: ["prepared", "dispatching", "active", "lost", "closed"],
  dispatching: ["dispatching", "active", "lost", "closed"],
  active: ["active", "lost", "closed"],
  closed: ["closed"],
  lost: ["lost"],
};

/** 终态代际不接受任何派发/ACK 写入（R02 §1）。 */
const TERMINAL_SESSION_STATES = new Set<RuntimeSessionBindingState>(["closed", "lost"]);

/**
 * A03：收口/失联时把工作身份标记为「已退休」。
 *
 * 只写墓碑，**不清** claim 列：`supervisorClaimId` 非空表示该代际已经分配过唯一的实际
 * 推进者；清零会让「同一代际换执行者」重新变得可表达，而那恰是本包要消除的漏洞。
 * 从未领取过的代际（claimId 为 NULL）没有任何可退休的东西，返回空补丁。
 */
function retireSupervisorClaim(
  current: RuntimeSessionBinding,
  now: Date,
): { supervisorReleasedAt?: Date } {
  if (current.supervisorClaimId === null || current.supervisorReleasedAt !== null) return {};
  return { supervisorReleasedAt: now };
}

function assertSessionTransition(
  current: RuntimeSessionBindingState,
  next: RuntimeSessionBindingState,
): void {
  if (!SESSION_TRANSITIONS[current].includes(next)) {
    throw new Error(`RuntimeSessionMismatch: ${current} → ${next}`);
  }
}

/**
 * 派发尝试的目标状态：只允许前进到 `dispatching`，或保持当前已接纳状态。
 * 「active 回 dispatching」在类型层面不可能出现——丢 ACK 的重发不得把已启动代际降级。
 */
function dispatchTargetState(current: RuntimeSessionBindingState): RuntimeSessionBindingState {
  if (TERMINAL_SESSION_STATES.has(current)) {
    throw new Error(`RuntimeSessionMismatch: ${current} 已收口，不接受派发写入`);
  }
  return current === "prepared" ? "dispatching" : current;
}

export interface CreateRuntimeSessionBindingInput {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  ownershipId: string;
  runtimeRevisionId: string;
  leaseEpoch: number;
  intentType: RuntimeSessionIntentType;
  startIntentKey: string;
  /**
   * A05：**来源操作键** —— 稳定、重投不变，回答"哪一个外部请求要求这次执行/恢复"。
   *
   * - 用户恢复：已持久 `InvocationCommand.id`；
   * - 子调用续接：已持久 continuation 的原始身份；
   * - 首次 Start：Invocation 自身身份。
   *
   * 绝不用当前时间、随机数或调用序号：只有稳定，ACK/`execution.started` 丢失后的第二次
   * 投递才会被认出来是"同一意图重投"，从而沿用已建好的 ready/激活事实。
   * 它与 `startIntentKey` 分工不同：后者是 O 生成**之后**的 Runtime 传输键（`start:<ownershipId>`），
   * 而来源意图必须在 O 存在**之前**就能比对。两者不是重复账本。
   */
  sourceOperationKey: string;
  /**
   * A05：该来源意图的**语义摘要**（tenant/Invocation/Attempt/intentType/锚点/Binding/Revision）。
   *
   * 同来源换摘要 = 另一份语义请求 → 必须拒绝，绝不采用"最新输入"覆盖原锚点。
   * 凭据轮换、trace、重试次数**不进入**摘要。
   */
  sourceRequestDigest: string;
  semanticRequestJson?: unknown;
  semanticRequestDigest?: string | null;
  runtimeCapabilitiesJson?: unknown;
}

/**
 * 读 + 行锁。所有写方法的第一步；也供调用方在比较后决定下一步转换。
 */
export async function lockRuntimeSessionBindingInTransaction(
  tx: SessionTx,
  tenantId: string,
  id: string,
): Promise<RuntimeSessionBinding> {
  const [row] = await tx
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(eq(runtimeSessionBindingTable.tenantId, tenantId), eq(runtimeSessionBindingTable.id, id)),
    )
    .for("update")
    .limit(1);
  if (!row) throw new RuntimeSessionBindingNotFoundError(id);
  return row;
}

async function applySessionWrite(
  tx: SessionTx,
  current: RuntimeSessionBinding,
  patch: SessionWritePatch,
): Promise<RuntimeSessionBinding> {
  const next = patch.bindingState ?? current.bindingState;
  assertSessionTransition(current.bindingState, next);
  await tx
    .update(runtimeSessionBindingTable)
    .set({ ...patch, bindingState: next, versionNo: current.versionNo + 1, updatedAt: new Date() })
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, current.tenantId),
        eq(runtimeSessionBindingTable.id, current.id),
      ),
    );
  const [updated] = await tx
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, current.tenantId),
        eq(runtimeSessionBindingTable.id, current.id),
      ),
    )
    .limit(1);
  if (!updated) throw new RuntimeSessionBindingNotFoundError(current.id);
  return updated;
}

function assertVersion(current: RuntimeSessionBinding, expectedVersionNo: number): void {
  if (current.versionNo !== expectedVersionNo) {
    throw new RuntimeSessionVersionConflictError(current.id, expectedVersionNo, current.versionNo);
  }
}

/** 写入补丁：列值可以是字面量，也可以是 SQL 表达式（如计数自增）。 */
type SessionWritePatch = {
  [K in keyof typeof runtimeSessionBindingTable.$inferInsert]?:
    | (typeof runtimeSessionBindingTable.$inferInsert)[K]
    | SQL;
} & { bindingState?: RuntimeSessionBindingState };

export async function createRuntimeSessionBindingInTransaction(
  tx: SessionTx,
  input: CreateRuntimeSessionBindingInput,
): Promise<RuntimeSessionBinding> {
  if (input.startIntentKey !== `start:${input.ownershipId}`) {
    throw new Error("StartIntentConflict");
  }
  if (!input.sourceOperationKey || !input.sourceRequestDigest) {
    throw new Error("StartIntentConflict");
  }
  if (
    (input.semanticRequestJson === undefined) !==
    (input.semanticRequestDigest === undefined || input.semanticRequestDigest === null)
  ) {
    throw new Error("RuntimeSessionBinding semantic request 必须成对冻结");
  }
  const id = randomUUID();
  const intentFrozenAt = input.semanticRequestJson === undefined ? null : new Date();
  await tx.insert(runtimeSessionBindingTable).values({
    id,
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    ownershipId: input.ownershipId,
    runtimeRevisionId: input.runtimeRevisionId,
    leaseEpoch: input.leaseEpoch,
    bindingState: "prepared",
    intentType: input.intentType,
    startIntentKey: input.startIntentKey,
    sourceOperationKey: input.sourceOperationKey,
    sourceRequestDigest: input.sourceRequestDigest,
    semanticRequestJson: input.semanticRequestJson ?? null,
    semanticRequestDigest: input.semanticRequestDigest ?? null,
    intentFrozenAt,
    remoteSessionRef: null,
    remoteExecutionRef: null,
    runtimeCapabilitiesJson: input.runtimeCapabilitiesJson ?? null,
    transportAcknowledgement: null,
    acknowledgedAt: null,
    startedEventId: null,
    dispatchCount: 0,
    nextDispatchAt: null,
    dispatchLeaseOwner: null,
    dispatchLeaseExpiresAt: null,
    lastDispatchAt: null,
    lastErrorCode: null,
    closedAt: null,
    versionNo: 1,
  });
  const row = await getRuntimeSessionBindingById(input.tenantId, id, tx);
  if (!row) throw new RuntimeSessionBindingNotFoundError(id);
  return row;
}

export async function getRuntimeSessionBindingById(
  tenantId: string,
  id: string,
  executor: DbOrTx = db,
): Promise<RuntimeSessionBinding | null> {
  const [row] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(eq(runtimeSessionBindingTable.tenantId, tenantId), eq(runtimeSessionBindingTable.id, id)),
    )
    .limit(1);
  return row ?? null;
}

export async function getRuntimeSessionBindingByStartIntent(
  tenantId: string,
  startIntentKey: string,
  executor: DbOrTx = db,
): Promise<RuntimeSessionBinding | null> {
  const [row] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.startIntentKey, startIntentKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * A05：按**来源意图**回读 Session（唯一索引 `tenant+invocation+attempt+intentType+sourceOperationKey`）。
 *
 * 这是决策表第 1/2/3 行的入口：来源意图先于 O 生成就存在，因此"同一请求的第二次投递"
 * 可以在这里被认出来，而不必去猜"最新 Attempt"。
 *
 * 注意它**不**用于历史行（`sourceOperationKey` 允许为 NULL：MySQL 唯一索引对 NULL 不冲突）。
 */
export async function getRuntimeSessionBindingBySourceIntent(
  tenantId: string,
  input: {
    invocationId: string;
    attemptId: string;
    intentType: RuntimeSessionIntentType;
    sourceOperationKey: string;
  },
  executor: DbOrTx = db,
): Promise<RuntimeSessionBinding | null> {
  const [row] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.invocationId, input.invocationId),
        eq(runtimeSessionBindingTable.attemptId, input.attemptId),
        eq(runtimeSessionBindingTable.intentType, input.intentType),
        eq(runtimeSessionBindingTable.sourceOperationKey, input.sourceOperationKey),
      ),
    )
    .for("update")
    .limit(1);
  return row ?? null;
}

export async function getRuntimeSessionBindingByOwnership(
  tenantId: string,
  ownershipId: string,
  executor: DbOrTx = db,
): Promise<RuntimeSessionBinding | null> {
  const [row] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.ownershipId, ownershipId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getRuntimeSessionBindingByAttempt(
  tenantId: string,
  attemptId: string,
  executor: DbOrTx = db,
): Promise<RuntimeSessionBinding | null> {
  const [row] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.attemptId, attemptId),
      ),
    )
    .orderBy(desc(runtimeSessionBindingTable.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getRuntimeSessionBindingsByInvocation(
  tenantId: string,
  invocationId: string,
): Promise<RuntimeSessionBinding[]> {
  return db
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.invocationId, invocationId),
      ),
    )
    .orderBy(desc(runtimeSessionBindingTable.createdAt));
}

export interface RuntimeSessionDispatchPatch {
  bindingState?: RuntimeSessionBindingState;
  semanticRequestJson?: unknown;
  semanticRequestDigest?: string | null;
  remoteSessionRef?: string | null;
  remoteExecutionRef?: string | null;
  transportAcknowledgement?: unknown;
  acknowledgedAt?: Date | null;
  startedEventId?: string | null;
  nextDispatchAt?: Date | null;
  dispatchLeaseOwner?: string | null;
  dispatchLeaseExpiresAt?: Date | null;
  lastErrorCode?: string | null;
}

export interface UpdateRuntimeSessionDispatchInput {
  tenantId: string;
  id: string;
  /**
   * 调用方**决策所依据**的行版本；给出时必须严格相等，否则拒绝迟到写入。
   *
   * 何时给：网络侧 ACK（`app/runtime/invocations/**`）——读与写之间存在真实竞争者。
   * 何时省略：进程内派发/ACK（`runtime-start`）——该写入是**单调合并**
   * （转换表不回退、语义请求冻结后不可改写、远端引用写一次），
   * 因此「execution.started 先于 HTTP 202 到达」这类合法前移不得被判成迟到冲突。
   */
  expectedVersionNo?: number;
  patch: RuntimeSessionDispatchPatch;
}

/**
 * 唯一 dispatch 意图 / ACK 写入口（`runtime-start` 与两个 HTTP ACK 路由共用）。
 *
 * 语义不变量（R02 §1 / §2 / §8）：
 * - 语义请求成对冻结，且**一旦冻结不得改写**（不同内容抛 `StartIntentConflict`）；
 *   即「同 Key 同 digest 返回原接纳、同 Key 不同 digest 冲突」。
 * - 远端不可变引用一旦写入不得改写（`ProtocolViolation`）。
 * - 目标状态只允许「前进到 dispatching 或保持已接纳状态」，**绝不回退**
 *   （`active` 不会因为丢 ACK 的重发被改回 `dispatching`）。
 * - `closed`/`lost` 代际拒绝任何派发/ACK 写入。
 */
export async function updateRuntimeSessionDispatchInTransaction(
  tx: SessionTx,
  input: UpdateRuntimeSessionDispatchInput,
): Promise<RuntimeSessionBinding> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  if (input.expectedVersionNo !== undefined) assertVersion(current, input.expectedVersionNo);
  const patch = input.patch;
  const semanticRequestChanged =
    patch.semanticRequestJson !== undefined || patch.semanticRequestDigest !== undefined;
  if (semanticRequestChanged) {
    if (patch.semanticRequestJson === undefined || !patch.semanticRequestDigest) {
      throw new Error("RuntimeSessionBinding semantic request 必须成对冻结");
    }
    if (
      current.semanticRequestDigest &&
      current.semanticRequestDigest !== patch.semanticRequestDigest
    ) {
      throw new Error("StartIntentConflict");
    }
    if (
      current.semanticRequestJson &&
      canonicalizeJson(current.semanticRequestJson) !== canonicalizeJson(patch.semanticRequestJson)
    ) {
      throw new Error("StartIntentConflict");
    }
  }
  if (
    current.remoteSessionRef &&
    patch.remoteSessionRef &&
    current.remoteSessionRef !== patch.remoteSessionRef
  ) {
    throw new Error("ProtocolViolation");
  }
  if (
    current.remoteExecutionRef &&
    patch.remoteExecutionRef &&
    current.remoteExecutionRef !== patch.remoteExecutionRef
  ) {
    throw new Error("ProtocolViolation");
  }
  const intentFrozenAt = semanticRequestChanged && !current.intentFrozenAt ? new Date() : undefined;
  return applySessionWrite(tx, current, {
    ...patch,
    // 显式状态按单向转换表校验；缺省时推导前向目标（`prepared → dispatching`，或保持已接纳状态）。
    // 两者都不会让 `active` 回退——这正是「丢 ACK 的重发不得降级已启动代际」的保证。
    bindingState: patch.bindingState ?? dispatchTargetState(current.bindingState),
    ...(intentFrozenAt ? { intentFrozenAt } : {}),
  });
}

/**
 * 正式启动事实写入（`execution.started`）。
 *
 * 同时补齐远端引用与 `startedEventId`；`active` 是唯一允许的下一步，
 * 「closed/lost 回 active」被转换表拒绝。行锁本身已是最强 CAS，`expectedVersionNo`
 * 只作为额外的代际一致性断言（同事务内下游写入可按需省略）。
 */
export async function activateRuntimeSessionBindingInTransaction(
  tx: SessionTx,
  input: {
    tenantId: string;
    id: string;
    expectedVersionNo?: number;
    startedEventId: string;
    remoteSessionRef?: string | null;
    remoteExecutionRef?: string | null;
  },
): Promise<RuntimeSessionBinding> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  if (input.expectedVersionNo !== undefined) assertVersion(current, input.expectedVersionNo);
  if (
    current.remoteSessionRef &&
    input.remoteSessionRef &&
    current.remoteSessionRef !== input.remoteSessionRef
  ) {
    throw new Error("ProtocolViolation");
  }
  if (
    current.remoteExecutionRef &&
    input.remoteExecutionRef &&
    current.remoteExecutionRef !== input.remoteExecutionRef
  ) {
    throw new Error("ProtocolViolation");
  }
  return applySessionWrite(tx, current, {
    bindingState: "active",
    startedEventId: input.startedEventId,
    ...(input.remoteSessionRef ? { remoteSessionRef: input.remoteSessionRef } : {}),
    ...(input.remoteExecutionRef ? { remoteExecutionRef: input.remoteExecutionRef } : {}),
  });
}

/** 收口为 closed（暂停/终态）。幂等：已 closed/lost 时原样返回。 */
export async function closeRuntimeSessionBindingInTransaction(
  tx: SessionTx,
  input: { tenantId: string; id: string; expectedVersionNo?: number },
): Promise<RuntimeSessionBinding> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  if (current.bindingState === "closed" || current.bindingState === "lost") return current;
  if (input.expectedVersionNo !== undefined) assertVersion(current, input.expectedVersionNo);
  // A03：收口即撤销工作身份。否则维护/回收视角会把一条已 closed 的 Session 看成"仍有人执行"。
  // 撤销只写 `supervisorReleasedAt` 墓碑：`supervisorClaimId` 是**一经写入不可清零**的历史
  // 领取证据，把它清掉就等于让该代际回到"从未领取"——那正是本包要消除的失权漏洞。
  return applySessionWrite(tx, current, {
    bindingState: "closed",
    closedAt: new Date(),
    ...retireSupervisorClaim(current, new Date()),
  });
}

/**
 * 标记代际失联（R03 §4/§5：替换/接管/过期时收口旧代际）。
 * 幂等：已 lost/closed 时原样返回；同时释放 dispatch lease。
 */
export async function markRuntimeSessionLostInTransaction(
  tx: SessionTx,
  input: { tenantId: string; id: string; expectedVersionNo?: number },
): Promise<RuntimeSessionBinding> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  if (current.bindingState === "lost" || current.bindingState === "closed") return current;
  if (input.expectedVersionNo !== undefined) assertVersion(current, input.expectedVersionNo);
  return applySessionWrite(tx, current, {
    bindingState: "lost",
    closedAt: new Date(),
    dispatchLeaseOwner: null,
    dispatchLeaseExpiresAt: null,
    ...retireSupervisorClaim(current, new Date()),
  });
}

/** 按 Ownership 收口整代 Session（Resume 换代/接管路径）。 */
export async function markRuntimeSessionLostByOwnershipInTransaction(
  tx: SessionTx,
  tenantId: string,
  ownershipId: string,
): Promise<RuntimeSessionBinding | null> {
  const [current] = await tx
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.ownershipId, ownershipId),
      ),
    )
    .for("update")
    .limit(1);
  if (!current) return null;
  if (current.bindingState === "lost" || current.bindingState === "closed") return current;
  return applySessionWrite(tx, current, {
    bindingState: "lost",
    closedAt: new Date(),
    dispatchLeaseOwner: null,
    dispatchLeaseExpiresAt: null,
    ...retireSupervisorClaim(current, new Date()),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Dispatch lease（R04 §5 / R02 §2）：授权、计数与退避排定都走同一行 CAS。
// ───────────────────────────────────────────────────────────────────────────

/** 授予一次 dispatch lease。`expectedVersionNo` 不匹配说明代际已被接管 → 拒绝。 */
export async function claimRuntimeSessionDispatchInTransaction(
  tx: SessionTx,
  input: {
    tenantId: string;
    id: string;
    expectedVersionNo: number;
    leaseOwner: string;
    leaseExpiresAt: Date;
  },
): Promise<RuntimeSessionBinding> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  assertVersion(current, input.expectedVersionNo);
  return applySessionWrite(tx, current, {
    dispatchLeaseOwner: input.leaseOwner,
    dispatchLeaseExpiresAt: input.leaseExpiresAt,
  });
}

/** 计数一次真实派发（网络发送前）。 */
export async function recordRuntimeSessionDispatchInTransaction(
  tx: SessionTx,
  input: { tenantId: string; id: string; expectedVersionNo: number; now: Date },
): Promise<RuntimeSessionBinding> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  assertVersion(current, input.expectedVersionNo);
  return applySessionWrite(tx, current, {
    dispatchCount: sql`${runtimeSessionBindingTable.dispatchCount} + 1`,
    lastDispatchAt: input.now,
  });
}

/** 记录一次暂态失败并排定 durable retry（释放 lease）。 */
export async function rescheduleRuntimeSessionDispatchInTransaction(
  tx: SessionTx,
  input: {
    tenantId: string;
    id: string;
    expectedVersionNo: number;
    dispatchCount: number;
    nextDispatchAt: Date | null;
    lastErrorCode: string | null;
  },
): Promise<RuntimeSessionBinding> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  assertVersion(current, input.expectedVersionNo);
  return applySessionWrite(tx, current, {
    dispatchCount: input.dispatchCount,
    nextDispatchAt: input.nextDispatchAt,
    lastErrorCode: input.lastErrorCode,
    dispatchLeaseOwner: null,
    dispatchLeaseExpiresAt: null,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// A03 · Session 级工作身份：一个 Ownership 代际最多一次实际 claim
// ───────────────────────────────────────────────────────────────────────────

/** 领取被拒绝的持久原因（`claimed === false` 时给出）。 */
export type SupervisorClaimDenial =
  /** 本代际已经分配过实际推进者 —— **包含已过期的历史 claim**。 */
  | "held"
  /** 该 claim 已由持有者主动退休（`supervisorReleasedAt` 非空）。 */
  | "retired";

export interface SupervisorClaimOutcome {
  /** 是否由本次调用取得（或按同一 claim 重放确认）该代际的工作身份。 */
  claimed: boolean;
  reason: "granted" | SupervisorClaimDenial;
  session: RuntimeSessionBinding;
}

/** 联合续租失败的原因。每一种都表示「本进程不再是该代际的合法执行者」。 */
export type SupervisorClaimRenewalReason =
  | "renewed"
  | "claim_superseded"
  | "claim_released"
  | "claim_expired"
  | "session_terminal";

export interface SupervisorClaimRenewal {
  renewed: boolean;
  reason: SupervisorClaimRenewalReason;
  session: RuntimeSessionBinding;
}

/**
 * 领取「本代际 Supervisor 工作身份」（A03 / R02 §2）。
 *
 * 契约把 Session 定义为**代际唯一的工作身份**，但 `bindingState = active` 本身不是排他
 * 领取——它反而明确允许"继续进入执行"，所以两个进程各自读到同一 active Owner/Session 后
 * 都能起一个决策循环（进程内 `liveRunners` 在对方进程里是空的）。
 *
 * 修复后的排他依据由三件**互不相同**的事实组成（`contracts/shared-contracts.md` §3）：
 * - `claimId`：每次真实领取另生的 nonce，决定"是哪一次领取"。一经写入**不可清零**，
 *   NULL 只表示"从未领取"。
 * - `instanceId`：领取者**进程启动**的实例 id，仅用于诊断归属。PID/hostname/时间戳在容器
 *   里会碰撞，因此不参与唯一性判定——用它们当身份正是被修复的缺陷。
 * - `leaseExpiresAt`：与 Owner 在**同一事务**里写下的同一个截止时间。
 *
 * 核心不变量：**过期不释权、释放不复位**。一旦写入 `claimId`，本代际就不再接受第二个
 * 执行者；后续推进只能经正式恢复器建立**新的 Ownership 代际**（基础设施替换时按既定
 * Attempt 规则建新 Attempt）。旧代际的迟到提交由既有 Ownership fencing 拒绝，不另造一个
 * 与它并列的正式执行权。
 *
 * 本写入**不推进 `versionNo`**：工作身份不是生命周期状态。若领取推进版本号，会让并发的
 * 网络 ACK（`expectedVersionNo` CAS）因为一次心跳而失败——那是把两件不同的事绑在同一个
 * 乐观锁上。排他用例的 CAS 条件是工作身份列自身（下面的 `if`）。
 */
export async function claimRuntimeSessionSupervisorInTransaction(
  tx: SessionTx,
  input: {
    tenantId: string;
    id: string;
    /** 本次实际领取的 nonce。不接受 PID、workerName 或实例 id 作为它。 */
    claimId: string;
    /** 领取者进程启动 id（`workerInstanceId()`），仅诊断归属。 */
    instanceId: string;
    leaseExpiresAt: Date;
    now: Date;
  },
): Promise<SupervisorClaimOutcome> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  if (TERMINAL_SESSION_STATES.has(current.bindingState)) {
    throw new Error(
      `RuntimeSessionMismatch: ${current.bindingState} 已收口，不接受 Supervisor 领取`,
    );
  }
  if (current.supervisorClaimId !== null) {
    if (current.supervisorClaimId === input.claimId && current.supervisorReleasedAt === null) {
      // 同一次领取的重放（响应丢失后重试）：只刷新自己的截止时间，不产生第二次领取。
      // 「不能另起 Loop」由调用方的进程内索引保证——同一个 claimId 在本进程只会有一个 Loop。
      return {
        claimed: true,
        reason: "granted",
        session: await writeSupervisorColumns(
          tx,
          current,
          { leaseExpiresAt: input.leaseExpiresAt },
          input.now,
        ),
      };
    }
    // 别的 nonce（哪怕 PID 相同、哪怕旧 claim 已过期）一律拒绝：本代际的推进者已经确定。
    return {
      claimed: false,
      reason: current.supervisorReleasedAt === null ? "held" : "retired",
      session: current,
    };
  }
  return {
    claimed: true,
    reason: "granted",
    session: await writeSupervisorColumns(
      tx,
      current,
      {
        claimId: input.claimId,
        instanceId: input.instanceId,
        leaseExpiresAt: input.leaseExpiresAt,
        releasedAt: null,
      },
      input.now,
    ),
  };
}

/**
 * 按**同一 claim** 续期 Session 侧截止时间（A03-03）。
 *
 * 它只写 Session 的 `supervisorLeaseExpiresAt`，因此**必须**由 Hosted 联合续租
 * （`execution-ownership-store` 的 `renewHostedExecutionLeaseInTransaction`）在
 * `I → Attempt → O → S` 同一事务里调用：Owner 与 claim 必须同步失效。契约明确禁止
 * "先无条件续 Owner，再发现 Session claim 已失效"，也禁止"未取得 claim 的请求续 Owner"。
 *
 * `now` 必须来自**数据库时间**（`getAuthorityDatabaseTime`）。用本机 `Date.now()` 会让
 * 两个进程对"是否已经过期"得出不同结论，那正是"过期 claim 被复活"的入口。
 */
export async function renewSupervisorClaimInTransaction(
  tx: SessionTx,
  input: {
    tenantId: string;
    id: string;
    claimId: string;
    instanceId: string;
    leaseExpiresAt: Date;
    now: Date;
  },
): Promise<SupervisorClaimRenewal> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  if (TERMINAL_SESSION_STATES.has(current.bindingState)) {
    return { renewed: false, reason: "session_terminal", session: current };
  }
  // 完整身份：claim nonce 与进程实例都必须逐项相符。少了后一项，"同 claim 但换了进程"
  // 会被误判成本人续租。
  if (
    current.supervisorClaimId !== input.claimId ||
    current.supervisorInstanceId !== input.instanceId
  ) {
    return { renewed: false, reason: "claim_superseded", session: current };
  }
  if (current.supervisorReleasedAt !== null) {
    return { renewed: false, reason: "claim_released", session: current };
  }
  if (current.supervisorLeaseExpiresAt === null || current.supervisorLeaseExpiresAt <= input.now) {
    // 过期不复活：唯一延长路径是"过期之前的续租"。
    return { renewed: false, reason: "claim_expired", session: current };
  }
  return {
    renewed: true,
    reason: "renewed",
    session: await writeSupervisorColumns(
      tx,
      current,
      { leaseExpiresAt: input.leaseExpiresAt },
      input.now,
    ),
  };
}

/**
 * 退休本代际的 Supervisor claim（持有者正常退出的握手点）。
 *
 * 只写 `supervisorReleasedAt` 墓碑，**保留** claimId/instanceId/expiry：契约要求
 * "领取过的代际保留历史 claim，关闭 Session"，并且"claimed 后释放或过期不得变回未领取"。
 * `claimId` 一经写入不可清零，所以释放只是把该代际标记成"已经用过"，不会让它重新可领；
 * 下一个推进者必须经正式恢复取得**新代际**。
 *
 * 只退休自己的 claim：代际身份已被别的执行者持有时原样返回 false，绝不误删他人身份。
 */
export async function releaseRuntimeSessionSupervisorInTransaction(
  tx: SessionTx,
  input: { tenantId: string; id: string; claimId: string; now: Date },
): Promise<boolean> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  if (current.supervisorClaimId !== input.claimId) return false;
  if (current.supervisorReleasedAt !== null) return true;
  await writeSupervisorColumns(tx, current, { releasedAt: input.now }, input.now);
  return true;
}

/**
 * 写 claim 列（**只写显式给出的列**）。
 *
 * 逐列判 `undefined` 而不是整体 `set(patch)`：`null` 与"未提供"在这里语义完全不同——
 * 领取时显式写 `releasedAt: null` 表示"这次领取是活的"，而续租绝不能把墓碑抹掉。
 */
async function writeSupervisorColumns(
  tx: SessionTx,
  current: RuntimeSessionBinding,
  patch: {
    claimId?: string;
    instanceId?: string;
    leaseExpiresAt?: Date;
    releasedAt?: Date | null;
  },
  now: Date,
): Promise<RuntimeSessionBinding> {
  await tx
    .update(runtimeSessionBindingTable)
    .set({
      ...(patch.claimId !== undefined ? { supervisorClaimId: patch.claimId } : {}),
      ...(patch.instanceId !== undefined ? { supervisorInstanceId: patch.instanceId } : {}),
      ...(patch.leaseExpiresAt !== undefined
        ? { supervisorLeaseExpiresAt: patch.leaseExpiresAt }
        : {}),
      ...(patch.releasedAt !== undefined ? { supervisorReleasedAt: patch.releasedAt } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, current.tenantId),
        eq(runtimeSessionBindingTable.id, current.id),
      ),
    );
  return readSessionRow(tx, current.tenantId, current.id);
}

async function readSessionRow(
  tx: SessionTx,
  tenantId: string,
  id: string,
): Promise<RuntimeSessionBinding> {
  const [row] = await tx
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(eq(runtimeSessionBindingTable.tenantId, tenantId), eq(runtimeSessionBindingTable.id, id)),
    )
    .limit(1);
  if (!row) throw new RuntimeSessionBindingNotFoundError(id);
  return row;
}
