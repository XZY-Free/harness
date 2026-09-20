import { getThreadById } from "@/lib/conversations/thread-queries";
import { getTurnById } from "@/lib/conversations/turn-queries";
/**
 * R01 §3：**半程意图**的正式发现入口。
 *
 * 初始 API 进程可能在任意提交点死亡（接纳事务已提交、执行图只建了一半、Session 还没写、
 * Transport 还没发出）。这些状态是**正式持久事实**，不能只依赖那个 HTTP 栈继续运行。
 *
 * 本模块承载 §3 表格里的两条 lane（其余 lane 在既有模块中）：
 *
 * 1. **admission lane** —— `Turn` 已 `accepted` 而**尚无任何 Invocation**：
 *    用原接纳事实（Thread owner 主体 + 同一 thread/turn）重新进入唯一生产调度入口
 *    `dispatchEmployeeTurn`，幂等建立执行图；解析失败由该入口写明确失败事实
 *    （`failUndispatchedTurn`），不留下"永远 accepted"的 Turn。
 * 2. **preparation lane** —— `Invocation` 已 `queued` 但**没有任何 RuntimeSessionBinding**
 *    且没有活跃 Owner（进程死在 Invocation/Binding/Attempt 提交之后、Session 写入之前）：
 *    补齐缺失的 Turn 中间态后，按稳定逻辑意图领取**唯一**候选 Attempt 并派发。
 *    重跑复用既有 Attempt，不产生无限候选。
 *
 * 与既有 lane 的互斥（同一半程状态不会被两个 lane 同时推进）：
 * - session dispatch lane 要求存在 `prepared`/`dispatching` 的 Session ⇒ preparation
 *   分支要求**不存在任何** Session；
 * - admission 分支要求**不存在任何** Invocation ⇒ preparation 分支要求存在 Invocation。
 *
 * 到期条件：`next*At` 为空不能让"已持久但进程在填 retry 时间前 Crash"的工作永久不可见，
 * 因此两类对象都使用与 Session/Command 相同的安全窗口 `DISPATCH_STUCK_GRACE_MS`。
 */
import { db } from "@/lib/db/client";
import {
  createAttempt,
  createAttemptInternal,
  getAttemptById,
} from "@/lib/executions/persistence/attempt-store";
import { lockInvocationRootIfExists } from "@/lib/executions/persistence/execution-ownership-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import {
  TURN_TERMINAL_STATES,
  type Turn,
  threadTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import {
  INVOCATION_TERMINAL_STATES,
  type Invocation,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { transitionTurnToQueued } from "@/lib/runtime/dispatcher";
import { dispatchEmployeeTurn } from "@/lib/runtime/employee-turn-dispatcher";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
import {
  dispatchQueuedInvocationAttempt,
  failAttemptAndInvokeRecoveryAuthority,
} from "@/lib/runtime/retry/dispatch-queued-invocation-attempt";
import { DISPATCH_STUCK_GRACE_MS } from "@/lib/runtime/retry/dispatch-retry-queries";
import {
  requireExecutionBinding,
  resolveBoundExecutionResources,
  resolveRuntimeTransportFromBinding,
} from "@/lib/runtime/retry/runtime-transport-from-binding";
import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
  notExists,
  notInArray,
  sql,
} from "drizzle-orm";

/** accepted Turn 的调度领取候选（只回 ID + 领取所见版本，扫描不做结论）。 */
export interface UndispatchedTurnCandidate {
  tenantId: string;
  threadId: string;
  turnId: string;
  /** 领取时复核的版本：领取是乐观 CAS，未领取到的工作不会被第二个 Worker 重复推进。 */
  versionNo: number;
}

/** 未派发 Invocation 的候选（只回 ID）。 */
export interface UndispatchedInvocationCandidate {
  tenantId: string;
  invocationId: string;
}

/** Supervisor 主动退休后留下的持久交接义务。 */
export interface SupervisorHandoffCandidate {
  tenantId: string;
  invocationId: string;
  sourceOwnershipId: string;
  sourceAttemptId: string;
}

export interface UndispatchedIntentSummary {
  turns: { scanned: number; recovered: number; skipped: number };
  invocations: { scanned: number; recovered: number; skipped: number };
  handoffs: { scanned: number; recovered: number; skipped: number };
}

export interface UndispatchedIntentDependencies {
  /** 默认即唯一生产调度入口；测试可注入以隔离线程内 Loop。 */
  dispatchTurn?: typeof dispatchEmployeeTurn;
  /** 默认即 canonical persisted Attempt 派发；测试可注入。 */
  dispatchAttempt?: typeof dispatchQueuedInvocationAttempt;
  /** Hosted 交接恢复使用正式 Transport，仅允许测试替换末端应用服务。 */
  hostedApplicationService?: HostedRuntimeApplicationService;
}

/**
 * 扫描 Supervisor 主动交接事实。`released + supervisor_handoff` 本身就是稳定义务身份；
 * 是否仍待消费在领取事务中以最新 Owner、活跃 Owner 与继任 Attempt 重新判定。
 */
export async function scanSupervisorHandoffs(params: {
  limit: number;
}): Promise<SupervisorHandoffCandidate[]> {
  return db
    .select({
      tenantId: invocationTable.tenantId,
      invocationId: invocationTable.id,
      sourceOwnershipId: executionOwnershipTable.id,
      sourceAttemptId: executionOwnershipTable.attemptId,
    })
    .from(executionOwnershipTable)
    .innerJoin(
      invocationTable,
      and(
        eq(invocationTable.id, executionOwnershipTable.invocationId),
        eq(invocationTable.tenantId, executionOwnershipTable.tenantId),
      ),
    )
    .where(
      and(
        eq(executionOwnershipTable.ownershipState, "released"),
        eq(executionOwnershipTable.reasonCode, "supervisor_handoff"),
        notInArray(invocationTable.executionState, [...INVOCATION_TERMINAL_STATES]),
        notExists(
          db
            .select({ one: sql`1` })
            .from(executionOwnershipTable)
            .where(
              and(
                eq(executionOwnershipTable.invocationId, invocationTable.id),
                eq(executionOwnershipTable.tenantId, invocationTable.tenantId),
                eq(executionOwnershipTable.ownershipState, "active"),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(executionOwnershipTable.releasedAt))
    .limit(params.limit);
}

/**
 * 扫描"Turn 已接纳而无 Invocation"的半程意图。
 *
 * 谓词是廉价过滤（`accepted` + 无 Invocation + 超过安全窗口）；结论在领取事务里按行
 * 重新验证。安全窗口保证不与请求内联调度竞争：内联调度在接纳后的同一请求内完成，
 * 且它创建 Invocation 远早于环境实例化。
 */
export async function scanUndispatchedAcceptedTurns(params: {
  now: Date;
  limit: number;
}): Promise<UndispatchedTurnCandidate[]> {
  const rows = await db
    .select({
      tenantId: threadTable.tenantId,
      threadId: turnTable.threadId,
      turnId: turnTable.id,
      versionNo: turnTable.versionNo,
    })
    .from(turnTable)
    .innerJoin(threadTable, eq(threadTable.id, turnTable.threadId))
    .where(
      and(
        eq(turnTable.turnState, "accepted"),
        isNull(turnTable.latestInvocationId),
        isNull(turnTable.activeInvocationId),
        lte(turnTable.acceptedAt, new Date(params.now.getTime() - DISPATCH_STUCK_GRACE_MS)),
      ),
    )
    .orderBy(asc(turnTable.acceptedAt))
    .limit(params.limit);
  return rows;
}

/**
 * 扫描"Invocation 已 queued 但没有任何可派发进展"的半程意图。
 *
 * 不含任何 Session（否则由既有 session dispatch lane 负责）且没有活跃 Owner（否则由
 * authority recovery lane 负责），并且 Turn 仍未终态（Turn 已被明确收口时不再重投）。
 */
export async function scanUndispatchedInvocations(params: {
  now: Date;
  limit: number;
}): Promise<UndispatchedInvocationCandidate[]> {
  return db
    .select({ tenantId: invocationTable.tenantId, invocationId: invocationTable.id })
    .from(invocationTable)
    .innerJoin(turnTable, eq(turnTable.id, invocationTable.turnId))
    .where(
      and(
        eq(invocationTable.executionState, "queued"),
        isNotNull(invocationTable.turnId),
        lte(invocationTable.updatedAt, new Date(params.now.getTime() - DISPATCH_STUCK_GRACE_MS)),
        notInArray(turnTable.turnState, [...TURN_TERMINAL_STATES]),
        notExists(
          db
            .select({ one: sql`1` })
            .from(runtimeSessionBindingTable)
            .where(eq(runtimeSessionBindingTable.invocationId, invocationTable.id)),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(executionOwnershipTable)
            .where(
              and(
                eq(executionOwnershipTable.invocationId, invocationTable.id),
                eq(executionOwnershipTable.ownershipState, "active"),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(invocationTable.updatedAt))
    .limit(params.limit);
}

/** 执行两条 lane 的一轮（维护 lane 语义：只处理有限批次，不做无限重试）。 */
export async function runDueUndispatchedIntentRecoveries(
  params: {
    now?: Date;
    batchSize?: number;
    dependencies?: UndispatchedIntentDependencies;
  } = {},
): Promise<UndispatchedIntentSummary> {
  const now = params.now ?? new Date();
  const batchSize = params.batchSize ?? 8;
  const summary: UndispatchedIntentSummary = {
    turns: { scanned: 0, recovered: 0, skipped: 0 },
    invocations: { scanned: 0, recovered: 0, skipped: 0 },
    handoffs: { scanned: 0, recovered: 0, skipped: 0 },
  };

  const turns = await scanUndispatchedAcceptedTurns({ now, limit: batchSize });
  summary.turns.scanned = turns.length;
  for (const candidate of turns) {
    const claimed = await claimAcceptedTurnForAdmission(candidate);
    if (!claimed) {
      summary.turns.skipped += 1;
      continue;
    }
    const thread = await getThreadById(candidate.tenantId, candidate.threadId);
    if (!thread) {
      summary.turns.skipped += 1;
      continue;
    }
    // 只补齐"接纳后未进入调度"这一件事：执行图仍由唯一生产入口创建。
    const dispatch = await (params.dependencies?.dispatchTurn ?? dispatchEmployeeTurn)({
      tenantId: candidate.tenantId,
      threadId: candidate.threadId,
      turnId: candidate.turnId,
      correlationId: `admission-lane:${candidate.turnId}`,
      executionSubject: {
        tenantId: candidate.tenantId,
        subjectType: "user",
        subjectId: thread.ownerUserId,
      },
    });
    // Hosted 的完成由接管进程内的 Loop 推进；本 lane 不等待它，避免维护 tick 被长执行占住。
    void dispatch.completion.catch(() => undefined);
    summary.turns.recovered += 1;
  }

  const handoffs = await scanSupervisorHandoffs({ limit: batchSize });
  summary.handoffs.scanned = handoffs.length;
  for (const candidate of handoffs) {
    const recovered = await recoverSupervisorHandoff(candidate, now, params.dependencies);
    if (recovered) summary.handoffs.recovered += 1;
    else summary.handoffs.skipped += 1;
  }

  const invocations = await scanUndispatchedInvocations({ now, limit: batchSize });
  summary.invocations.scanned = invocations.length;
  for (const candidate of invocations) {
    const recovered = await recoverUndispatchedInvocation(candidate, now, params.dependencies);
    if (recovered) summary.invocations.recovered += 1;
    else summary.invocations.skipped += 1;
  }
  return summary;
}

interface SupervisorHandoffClaim {
  invocation: Invocation;
  attemptId: string;
}

/**
 * 领取并物化一个交接继任 Attempt。
 *
 * Invocation 根锁让“最新交接事实 / 无活跃 Owner / 唯一继任 Attempt”成为一个原子判定。
 * 新建后以 Attempt.updatedAt 作为可恢复领取窗口：Worker 在派发前崩溃，安全窗口后会复用
 * 同一 queued Attempt；并发 Worker 看见新鲜 Attempt 则跳过，绝不再造第二候选。
 */
export async function claimSupervisorHandoff(
  candidate: SupervisorHandoffCandidate,
  now: Date,
): Promise<SupervisorHandoffClaim | null> {
  return db.transaction(async (tx) => {
    const invocation = await lockInvocationRootIfExists(
      tx,
      candidate.tenantId,
      candidate.invocationId,
    );
    if (!invocation || INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) return null;

    // 固定锁图 I → A → O：先锁定本 Invocation 的 Attempt 集，再复核 Owner。
    const attempts = await tx
      .select()
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, candidate.tenantId),
          eq(invocationAttemptTable.invocationId, candidate.invocationId),
        ),
      )
      .orderBy(desc(invocationAttemptTable.attemptNo))
      .for("update");
    const sourceAttempt = attempts.find((attempt) => attempt.id === candidate.sourceAttemptId);
    if (!sourceAttempt) return null;

    const owners = await tx
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, candidate.tenantId),
          eq(executionOwnershipTable.invocationId, candidate.invocationId),
        ),
      )
      .orderBy(desc(executionOwnershipTable.leaseEpoch))
      .for("update");
    if (owners.some((owner) => owner.ownershipState === "active")) return null;
    const latest = owners[0];
    if (
      !latest ||
      latest.id !== candidate.sourceOwnershipId ||
      latest.attemptId !== candidate.sourceAttemptId ||
      latest.ownershipState !== "released" ||
      latest.reasonCode !== "supervisor_handoff"
    ) {
      return null;
    }

    let successor = attempts.find(
      (attempt) =>
        attempt.attemptNo > sourceAttempt.attemptNo &&
        attempt.attemptState === "queued" &&
        attempt.retryReasonCode === "supervisor_handoff",
    );
    if (successor) {
      if (successor.updatedAt > new Date(now.getTime() - DISPATCH_STUCK_GRACE_MS)) return null;
      await tx
        .update(invocationAttemptTable)
        .set({ updatedAt: now, versionNo: successor.versionNo + 1 })
        .where(eq(invocationAttemptTable.id, successor.id));
      successor = { ...successor, updatedAt: now, versionNo: successor.versionNo + 1 };
    } else {
      successor = await createAttemptInternal(tx, {
        tenantId: candidate.tenantId,
        invocationId: candidate.invocationId,
        retryReasonCode: "supervisor_handoff",
      });
    }
    await tx
      .update(invocationTable)
      .set({ updatedAt: now, versionNo: invocation.versionNo + 1 })
      .where(eq(invocationTable.id, invocation.id));
    return { invocation: { ...invocation, updatedAt: now }, attemptId: successor.id };
  });
}

async function recoverSupervisorHandoff(
  candidate: SupervisorHandoffCandidate,
  now: Date,
  dependencies: UndispatchedIntentDependencies | undefined,
): Promise<boolean> {
  const claim = await claimSupervisorHandoff(candidate, now);
  if (!claim) return false;
  const attempt = await getAttemptById(claim.attemptId);
  if (!attempt) return false;
  let transport: Awaited<ReturnType<typeof resolveRuntimeTransportFromBinding>>;
  let resources: Awaited<ReturnType<typeof resolveBoundExecutionResources>>;
  try {
    const binding = await requireExecutionBinding(candidate.tenantId, candidate.invocationId);
    transport = await resolveRuntimeTransportFromBinding({
      tenantId: candidate.tenantId,
      binding,
      hostedApplicationService: dependencies?.hostedApplicationService,
    });
    resources = await resolveBoundExecutionResources({
      tenantId: candidate.tenantId,
      binding,
      purpose: "thread",
    });
  } catch (error) {
    await failAttemptAndInvokeRecoveryAuthority({
      tenantId: candidate.tenantId,
      attempt,
      invocation: claim.invocation,
      errorCode: error instanceof Error ? error.name : "RuntimeDispatchFailed",
      errorSummary: error instanceof Error ? error.message : String(error),
      now,
      claim: null,
    });
    return true;
  }
  await (dependencies?.dispatchAttempt ?? dispatchQueuedInvocationAttempt)({
    tenantId: candidate.tenantId,
    attemptId: attempt.id,
    claim: null,
    runtimeClient: transport.runtimeClient,
    runtimeEndpointResolver: async () => ({
      runtimeEndpoint: transport.runtimeEndpoint,
      auth: transport.auth,
      callbackEndpoints: buildGatewayEndpoints({
        external: !transport.hosted,
        invocationId: candidate.invocationId,
      }),
      ...resources,
    }),
    correlationId: `supervisor-handoff:${candidate.sourceOwnershipId}`,
  });
  return true;
}

/**
 * 乐观领取一个 accepted Turn。
 *
 * Turn 没有 lease 列，因此领取用**版本 CAS** 表达：未领取到（已被内联调度推进 / 已被其它
 * Worker 领取 / 版本已前移）即放弃候选，不改任何行。领取后若本进程死亡，对象仍是
 * "accepted 且无 Invocation"，安全窗口之后重新可见（自愈）。
 */
export async function claimAcceptedTurnForAdmission(
  candidate: UndispatchedTurnCandidate,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(turnTable)
      .where(and(eq(turnTable.threadId, candidate.threadId), eq(turnTable.id, candidate.turnId)))
      .for("update")
      .limit(1);
    if (!row) return false;
    if (row.versionNo !== candidate.versionNo) return false;
    if (row.turnState !== "accepted") return false;
    if (row.latestInvocationId || row.activeInvocationId) return false;
    const updated = await tx
      .update(turnTable)
      .set({ versionNo: row.versionNo + 1 })
      .where(and(eq(turnTable.id, row.id), eq(turnTable.versionNo, row.versionNo)));
    return updated[0].affectedRows === 1;
  });
}

interface UndispatchedInvocationClaim {
  invocation: Invocation;
  /** 领取时看到的唯一候选 Attempt（null = 尚无 Attempt，需要创建恰好一个）。 */
  attemptId: string | null;
}

/**
 * 领取一个"无任何派发进展"的 Invocation。
 *
 * 领取即把 `updatedAt` 推到当前时间：到期条件因此重新计时，其它 Worker 在同一安全窗口内
 * 不会重复领取；若本进程在派发前后死亡，对象在窗口后重新可见（自愈）。
 */
export async function claimUndispatchedInvocation(
  candidate: UndispatchedInvocationCandidate,
  now: Date,
): Promise<UndispatchedInvocationClaim | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, candidate.tenantId),
          eq(invocationTable.id, candidate.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) return null;
    if (row.executionState !== "queued") return null;
    if (row.updatedAt > new Date(now.getTime() - DISPATCH_STUCK_GRACE_MS)) return null;
    const [session] = await tx
      .select({ id: runtimeSessionBindingTable.id })
      .from(runtimeSessionBindingTable)
      .where(eq(runtimeSessionBindingTable.invocationId, row.id))
      .limit(1);
    if (session) return null;
    const [owner] = await tx
      .select({ id: executionOwnershipTable.id })
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.invocationId, row.id),
          eq(executionOwnershipTable.ownershipState, "active"),
        ),
      )
      .limit(1);
    if (owner) return null;
    if (row.turnId) {
      const [turn] = await tx
        .select({ turnState: turnTable.turnState })
        .from(turnTable)
        .where(eq(turnTable.id, row.turnId))
        .for("update")
        .limit(1);
      if (turn && TURN_TERMINAL_STATES.includes(turn.turnState)) return null;
    }
    // 唯一候选 Attempt：已存在的 queued Attempt 一律复用（重跑不产生新候选）。
    const attempts = await tx
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.invocationId, row.id))
      .orderBy(asc(invocationAttemptTable.attemptNo));
    const queued = attempts.find((attempt) => attempt.attemptState === "queued");
    if (!queued && attempts.length > 0) return null;
    await tx
      .update(invocationTable)
      .set({ updatedAt: now, versionNo: row.versionNo + 1 })
      .where(eq(invocationTable.id, row.id));
    return { invocation: { ...row, updatedAt: now }, attemptId: queued?.id ?? null };
  });
}

async function recoverUndispatchedInvocation(
  candidate: UndispatchedInvocationCandidate,
  now: Date,
  dependencies: UndispatchedIntentDependencies | undefined,
): Promise<boolean> {
  const claim = await claimUndispatchedInvocation(candidate, now);
  if (!claim) return false;
  const { invocation } = claim;
  // 进程死在 transitionTurnToQueued 之前时补齐该中间态：Turn 的历史事件与
  // activeInvocationId 必须与未崩溃路径一致，否则投影与客户端会看到两条不同轨迹。
  if (invocation.turnId) {
    const turn = await getTurnById(candidate.tenantId, invocation.turnId);
    if (turn && turn.turnState === "accepted") {
      await advanceTurnToQueued(turn, invocation.id);
    }
  }
  const attemptId =
    claim.attemptId ??
    (await createAttempt({ tenantId: candidate.tenantId, invocationId: invocation.id })).id;
  const attempt = await getAttemptById(attemptId);
  if (!attempt) return false;
  const fresh = await getInvocationById(candidate.tenantId, invocation.id);
  if (!fresh) return false;
  let transport: Awaited<ReturnType<typeof resolveRuntimeTransportFromBinding>>;
  let resources: Awaited<ReturnType<typeof resolveBoundExecutionResources>>;
  try {
    const binding = await requireExecutionBinding(candidate.tenantId, invocation.id);
    transport = await resolveRuntimeTransportFromBinding({
      tenantId: candidate.tenantId,
      binding,
    });
    // 运行资源只从冻结 Binding 解析（唯一生产组合层），不在这里另拼一份。
    resources = await resolveBoundExecutionResources({
      tenantId: candidate.tenantId,
      binding,
      purpose: "thread",
    });
  } catch (error) {
    await failAttemptAndInvokeRecoveryAuthority({
      tenantId: candidate.tenantId,
      attempt,
      invocation: fresh,
      errorCode: error instanceof Error ? error.name : "RuntimeDispatchFailed",
      errorSummary: error instanceof Error ? error.message : String(error),
      now,
      claim: null,
    });
    return true;
  }
  await (dependencies?.dispatchAttempt ?? dispatchQueuedInvocationAttempt)({
    tenantId: candidate.tenantId,
    attemptId: attempt.id,
    // 请求内联语义（无 lease）：本 lane 从"不存在任何 Session"出发，Session 由
    // startRuntimeInvocation 在本次派发内一次建立，完成确认按 Session 自身 tuple 复核。
    claim: null,
    runtimeClient: transport.runtimeClient,
    runtimeEndpointResolver: async () => ({
      runtimeEndpoint: transport.runtimeEndpoint,
      auth: transport.auth,
      callbackEndpoints: buildGatewayEndpoints({
        external: !transport.hosted,
        invocationId: invocation.id,
      }),
      ...resources,
    }),
    correlationId: `preparation-lane:${invocation.id}`,
  });
  return true;
}

/**
 * 补齐 `transitionTurnToQueued` 这一步。
 *
 * 唯一实现就在 dispatcher（`turn.queued` 事件 + activeInvocationId + 版本 CAS）；本 lane
 * 只是它的第二个调用者，不允许另写一份"看起来一样"的推进。
 */
async function advanceTurnToQueued(turn: Turn, invocationId: string): Promise<void> {
  await transitionTurnToQueued({
    threadId: turn.threadId,
    turn,
    invocationId,
    actorType: "system",
    actorId: null,
    correlationId: `preparation-lane:${invocationId}`,
  });
}
