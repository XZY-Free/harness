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
  return applySessionWrite(tx, current, {
    bindingState: "closed",
    closedAt: new Date(),
    supervisorLeaseOwner: null,
    supervisorLeaseExpiresAt: null,
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
    supervisorLeaseOwner: null,
    supervisorLeaseExpiresAt: null,
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
    supervisorLeaseOwner: null,
    supervisorLeaseExpiresAt: null,
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
// A03 · Session 级工作身份：同代际只能有一个实际推进者
// ───────────────────────────────────────────────────────────────────────────

export interface SupervisorLeaseClaim {
  /** 是否由本次调用取得工作身份。false 表示该代际正由别的执行者推进。 */
  claimed: boolean;
  session: RuntimeSessionBinding;
}

/**
 * 领取「本代际 Supervisor 工作身份」（A03 / R02 §2）。
 *
 * 契约把 Session 定义为**代际唯一的工作身份**，但 `bindingState = active` 本身不是排他
 * 领取——它反而明确允许"继续进入执行"，所以两个进程各自读到同一 active Owner/Session 后
 * 都能起一个决策循环（进程内 `liveRunners` 在对方进程里是空的）。
 *
 * 这里补上真正的排他依据：行锁内的 CAS。仅当当前无持有者、持有者就是自己、或租约已过期
 * 时才成功。它与 `dispatchLease*` **分列**是必需的：派发 lane 在 `prepared`/`dispatching`
 * 持有派发票据，而 Supervisor 恰好也在 `dispatching` 入场（它要先写 `execution.started`），
 * 共用一列会让两者互相误判成"已被接管"。
 *
 * 本写入**不推进 `versionNo`**：工作身份不是生命周期状态。若续租推进版本号，
 * 会让并发的网络 ACK（`expectedVersionNo` CAS）因续租而失败——那是把两件不同的事
 * 绑在同一个乐观锁上。这里的 CAS 条件是工作身份列自身。
 */
export async function claimRuntimeSessionSupervisorInTransaction(
  tx: SessionTx,
  input: {
    tenantId: string;
    id: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
  },
): Promise<SupervisorLeaseClaim> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  if (TERMINAL_SESSION_STATES.has(current.bindingState)) {
    throw new Error(
      `RuntimeSessionMismatch: ${current.bindingState} 已收口，不接受 Supervisor 领取`,
    );
  }
  // 持有者不明（owner 非空但无到期时间）按「仍持有」处理：不能抢一个来源不清的身份。
  const heldByOther =
    current.supervisorLeaseOwner !== null &&
    current.supervisorLeaseOwner !== input.leaseOwner &&
    (current.supervisorLeaseExpiresAt === null || current.supervisorLeaseExpiresAt > input.now);
  if (heldByOther) return { claimed: false, session: current };
  const [updated] = await tx
    .update(runtimeSessionBindingTable)
    .set({
      supervisorLeaseOwner: input.leaseOwner,
      supervisorLeaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, current.tenantId),
        eq(runtimeSessionBindingTable.id, current.id),
      ),
    );
  if (!updated) throw new RuntimeSessionBindingNotFoundError(current.id);
  return { claimed: true, session: await readSessionRow(tx, current.tenantId, current.id) };
}

/**
 * 续期 Supervisor 工作身份。仅当**本执行者**仍是持有者时成功。
 *
 * 返回 false 表示身份已被接管或已被收口释放——调用方必须停止推进该代际
 * （这正是「旧 Owner 复活」在 Supervisor 侧的阻断点）。
 */
export async function renewRuntimeSessionSupervisorInTransaction(
  tx: SessionTx,
  input: { tenantId: string; id: string; leaseOwner: string; leaseExpiresAt: Date; now: Date },
): Promise<boolean> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  if (current.supervisorLeaseOwner !== input.leaseOwner) return false;
  if (TERMINAL_SESSION_STATES.has(current.bindingState)) return false;
  const [updated] = await tx
    .update(runtimeSessionBindingTable)
    .set({ supervisorLeaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now })
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, current.tenantId),
        eq(runtimeSessionBindingTable.id, current.id),
      ),
    );
  if (!updated) throw new RuntimeSessionBindingNotFoundError(current.id);
  return true;
}

/**
 * 释放 Supervisor 工作身份（Supervisor 正常退出时）。
 *
 * 只清自己的身份：代际已被接管（持有者已变）时原样返回 false，
 * 绝不误删新执行者的身份。
 */
export async function releaseRuntimeSessionSupervisorInTransaction(
  tx: SessionTx,
  input: { tenantId: string; id: string; leaseOwner: string; now: Date },
): Promise<boolean> {
  const current = await lockRuntimeSessionBindingInTransaction(tx, input.tenantId, input.id);
  if (current.supervisorLeaseOwner !== input.leaseOwner) return false;
  const [updated] = await tx
    .update(runtimeSessionBindingTable)
    .set({
      supervisorLeaseOwner: null,
      supervisorLeaseExpiresAt: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, current.tenantId),
        eq(runtimeSessionBindingTable.id, current.id),
      ),
    );
  if (!updated) throw new RuntimeSessionBindingNotFoundError(current.id);
  return true;
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
