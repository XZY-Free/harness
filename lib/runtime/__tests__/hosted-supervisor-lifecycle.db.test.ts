/**
 * A03：Hosted Supervisor 的身份、唯一 claim 与失权闭环。
 *
 * 审查报告 §4 的残留是**两件不同的事**，本文件按它们各自的真实边界验证：
 *
 * 1. **默认身份碰撞**：旧实现把进程身份写成 `pid:<pid>`。PID 不是身份——不同容器可以同时
 *    持有同一 PID，同机重启也会复用 PID。现在进程实例身份是按进程启动生成的 UUID
 *    （`workerInstanceId()`），它**只用于诊断**；真正决定"是哪一次领取"的是每次领取另生的
 *    claim nonce。因此 T01/T02 必须用**两个真实 Node 进程**、且**不注入**实例身份——
 *    注入 `proc-a`/`proc-b` 等于把被测对象（生产默认值）从测试里摘掉。
 *
 * 2. **同一 Ownership 代际换执行者**：旧语义是"claim 到期后同一个 owner 字符串可以接着跑"，
 *    于是旧进程迟到的结果仍可能被承认为推进。现在一个代际**最多分配一次实际 claim**，
 *    `claimId` 一经写入不可清零：`held`（已被别人领）与 `retired`（已主动退休）都不允许在
 *    原代际重领。换执行者必须换代际。
 *
 * 与两组不变量的分工：`Owner lease` 仍由 `ExecutionOwnership` 表达（过期就是失权），
 * `claim` 只回答"这个代际分配给谁"。两者**必须**在同一事务里续（T04/T05），否则会出现
 * "Supervisor 过期但 Owner 被另一路续活"的窗口。
 */
import { randomUUID } from "node:crypto";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn } from "@/lib/conversations/turn-queries";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { authorityIdentity } from "@/lib/executions/domain/execution-authority";
import type { AttemptPreparationClaim } from "@/lib/executions/persistence/attempt-store";
import {
  closeExecutionOwnershipInTransaction,
  getActiveExecutionOwnership,
  getAuthorityDatabaseTime,
  renewExecutionOwnership,
  renewHostedExecutionLease,
  renewHostedExecutionLeaseInTransaction,
} from "@/lib/executions/persistence/execution-ownership-store";
import { markAttemptPreparedForTestInTransaction } from "@/lib/executions/test-support/preparation-fixtures";
import {
  acquireTestRuntimeAuthority,
  createPreparedTakeoverAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import {
  type RuntimeSessionBinding,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
  runtimeEventIngressTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { runDueExpiredOwnerRecoveries } from "@/lib/runtime/application/authority-recovery-lane";
import { authorizeRuntimeAction } from "@/lib/runtime/application/authorize-runtime-action";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { createConfiguredHostedRuntimeApplicationService } from "@/lib/runtime/application/runtime-resume";
import { startRuntimeInvocation } from "@/lib/runtime/application/runtime-start";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import {
  claimRuntimeSessionSupervisorInTransaction,
  getRuntimeSessionBindingById,
  getRuntimeSessionBindingByOwnership,
  markRuntimeSessionLostInTransaction,
  releaseRuntimeSessionSupervisorInTransaction,
} from "@/lib/runtime/persistence/runtime-session-store";
import { dispatchQueuedInvocationAttempt } from "@/lib/runtime/retry/dispatch-queued-invocation-attempt";
import {
  runDueUndispatchedIntentRecoveries,
  scanSupervisorHandoffs,
} from "@/lib/runtime/retry/undispatched-intent-lane";
import { type AuthorityIdentity, protocolDigest } from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import {
  type SupervisorProcessHandle,
  type SupervisorProcessReport,
  spawnSupervisorProcess,
} from "@/lib/runtime/test-support/supervisor-process";
import { ingressTransientBatch } from "@/lib/runtime/transient-events";
import {
  type DispatchableTurnContext,
  seedDispatchableTurn,
} from "@/lib/test-support/seed-dispatchable-turn";
import { workerInstanceId } from "@/lib/workers/worker-instance-identity";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_VITEST_IDENTITY_FIXTURE;

/** 在途子调用的动作身份（父执行已持久化它，子调用尚未终态）。 */
const IN_FLIGHT_ACTION_ID = "action-supervisor-inflight-1";

const CALLBACK_ENDPOINTS = {
  events: "https://a03.invalid/runtime/events",
  heartbeat: "https://a03.invalid/runtime/heartbeat",
  context: "https://a03.invalid/runtime/context",
  capabilityActions: "https://a03.invalid/gateway/capability-actions",
  toolCalls: "https://a03.invalid/gateway/tool-calls",
  userActions: "https://a03.invalid/gateway/user-actions",
};

const INSTANCE_ID_SHAPE =
  /^worker-instance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markPrepared(invocationId: string, attemptId: string) {
  const { markAttemptPreparedInTransaction } = await import(
    "@/lib/executions/persistence/attempt-store"
  );
  const evidence = { kind: "supervisor-lifecycle-candidate", invocationId, attemptId };
  await db.transaction((tx) =>
    markAttemptPreparedForTestInTransaction(tx, {
      attemptId,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
}

/**
 * 建出「Hosted 执行已有代际，且 Ledger 里有一条在途 tool.call」的代际。
 *
 * - Thread/Turn/Binding/Route 走真实调度（`seedDispatchableTurn` + `dispatchInvocationForTurn`）；
 * - Ownership 阶段可选 `dispatching`（此时 Supervisor 入场会写 `execution.started`，T10 需要
 *   它来证明"重复 Start 不写第二次 started"）或 `executing`；
 * - 在途动作经**正式 Ingress** 写入（不是直接 INSERT），因此 Loop 恢复时读到的就是真实 Ledger。
 */
async function seedActiveGenerationWithInFlightChild(options?: {
  phase?: "dispatching" | "executing";
  baseContext?: DispatchableTurnContext;
}) {
  const phase = options?.phase ?? "executing";
  let ctx = options?.baseContext;
  if (ctx) {
    const { thread } = await createThread({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.ownerId,
      actorId: ctx.ownerId,
    });
    const { turn } = await acceptUserMessageTurn({
      tenantId: ctx.tenantId,
      threadId: thread.id,
      ownerUserId: ctx.ownerId,
      content: { text: `N01 candidate ${randomUUID()}` },
      actorId: ctx.ownerId,
    });
    if (!turn.triggerItemId) throw new Error("N01 复用上下文的新 Turn 缺少 triggerItemId");
    ctx = {
      ...ctx,
      threadId: thread.id,
      turnId: turn.id,
      triggerItemId: turn.triggerItemId,
    };
  } else {
    ctx = await seedDispatchableTurn();
  }
  const dispatch = await dispatchInvocationForTurn({
    tenantId: ctx.tenantId,
    turnId: ctx.turnId,
    executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
  });
  const invocation = dispatch.invocation;
  const binding = dispatch.binding;
  const attempt = dispatch.attempt;
  if (!invocation || !binding || !attempt) throw new Error("调度未产生 Invocation/Binding/Attempt");
  await markPrepared(invocation.id, attempt.id);
  // R02 生产时序（与 `runtime-resume` 的 Start 分支逐字同形）：
  //   领取执行权（此刻 phase 仍是 `dispatching`，但激活证据已在派发前固定）
  //   → 冻结 Session 启动意图并停在 `dispatching`
  //   → 接纳 `execution.started`：**唯一**把 phase 推到 `executing`、把 Session 推到 `active` 的事件
  //   → 接纳在途 `harness.action.started`
  //
  // 旧夹具在第 3 步用 `applyRuntimeSessionDispatchForTest` 直接写 `active` + 伪造 `startedEventId`，
  // 于是"这个代际已经 start 过"在库里**没有任何事件证据**：像"重复 Start 不得写第二次
  // `execution.started`"这样的计数断言会恒真假绿（分母是 0）。现在按生产时序落事件，
  // 计数断言才有真实分母。
  const activationEvidence = { fixture: "supervisor-lifecycle-activation" };
  const gen = await acquireTestRuntimeAuthority({
    tenantId: ctx.tenantId,
    invocationId: invocation.id,
    attemptId: attempt.id,
    runtimeRevisionId: binding.runtimeRevisionId,
    phase: "dispatching",
    runtimeCapabilitiesJson: ctx.runtimeRevision.runtimeCapabilitiesJson,
    activationEvidence,
    activationDigest: protocolDigest(activationEvidence),
  });
  const semanticRequestJson = { fixture: "supervisor-lifecycle" };
  const semanticRequestDigest = protocolDigest(semanticRequestJson);
  await applyRuntimeSessionDispatchForTest(ctx.tenantId, gen.session.id, {
    bindingState: "dispatching",
    semanticRequestJson,
    semanticRequestDigest,
  });
  // 停在"启动意图已冻结、`execution.started` 尚未写"的边界：这正是 A03-T10 需要的起点。
  if (phase === "dispatching") {
    return { ctx, invocation, binding, attempt, gen };
  }

  let producerSequence = invocation.lastProducerSequence;
  await ingressRuntimeEvents({
    tenantId: ctx.tenantId,
    invocationId: invocation.id,
    batch: {
      protocolVersion: 3,
      authority: gen.authority,
      events: [
        {
          eventId: randomUUID(),
          producerSequence: String(++producerSequence),
          type: "execution.started",
          schemaVersion: 1,
          payload: {
            intentKey: gen.session.startIntentKey,
            semanticRequestDigest,
            remoteSessionRef: `hosted-session:${gen.session.id}`,
            remoteExecutionRef: `hosted-execution:${invocation.id}:${gen.ownership.id}`,
            capabilitiesDigest: expectedCapabilityManifestDigest({
              runtimeRevisionId: binding.runtimeRevisionId,
              runtimeCapabilitiesJson: ctx.runtimeRevision.runtimeCapabilitiesJson,
            }),
          },
        },
      ],
    },
  });

  const toolPayload = {
    toolId: "in-flight-tool",
    operationId: "in-flight-op",
    arguments: { query: "unsettled" },
  };
  await ingressRuntimeEvents({
    tenantId: ctx.tenantId,
    invocationId: invocation.id,
    batch: {
      protocolVersion: 3,
      authority: gen.authority,
      events: [
        {
          eventId: randomUUID(),
          producerSequence: String(++producerSequence),
          type: "harness.action.started",
          schemaVersion: 1,
          payload: {
            action_id: IN_FLIGHT_ACTION_ID,
            step_no: 1,
            action_type: "tool.call",
            action_digest: computeCanonicalDigest({
              actionType: "tool.call",
              payload: toolPayload,
            }),
            purpose_code: "supervisor_lifecycle_probe",
            short_purpose: "在途子调用",
            target_ref: null,
            state: "started",
            action_payload: toolPayload,
          },
        },
      ],
    },
  });

  return { ctx, invocation, binding, attempt, gen };
}

async function countIngressEvents(tenantId: string, invocationId: string, candidateType: string) {
  const rows = await db
    .select({ id: runtimeEventIngressTable.id })
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, tenantId),
        eq(runtimeEventIngressTable.invocationId, invocationId),
        eq(runtimeEventIngressTable.candidateType, candidateType),
      ),
    );
  return rows.length;
}

/**
 * 按**动作身份**计数事件：判据必须是"同一个动作只被执行一次"，而不是"整条 Invocation 里
 * 某类事件的总数"（respond 动作自己也会写 started）。
 */
async function countActionEvents(
  tenantId: string,
  invocationId: string,
  actionId: string,
  candidateType: string,
) {
  const rows = await db
    .select({ id: runtimeEventIngressTable.id })
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, tenantId),
        eq(runtimeEventIngressTable.invocationId, invocationId),
        eq(runtimeEventIngressTable.candidateType, candidateType),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${runtimeEventIngressTable.payloadJson}, '$.action_id')) = ${actionId}`,
      ),
    );
  return rows.length;
}

async function countAllIngressEvents(tenantId: string, invocationId: string) {
  const rows = await db
    .select({ id: runtimeEventIngressTable.id })
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, tenantId),
        eq(runtimeEventIngressTable.invocationId, invocationId),
      ),
    );
  return rows.length;
}

/** 「子调用仍在持久执行」的执行器：返回 pending，不产出 observation。 */
async function pendingExecutor() {
  return {
    authorityRef: `tool-call:${IN_FLIGHT_ACTION_ID}`,
    pending: {
      kind: "tool_call" as const,
      callId: IN_FLIGHT_ACTION_ID,
      state: "running" as const,
    },
  };
}

/** 子调用终态后 Supervisor 收尾用的应答动作（与旧 SUPERVISOR-03 同一形态）。 */
function respondDecision(stepNo: number) {
  return {
    actionId: `action-supervisor-respond-${stepNo}`,
    stepNo,
    actionType: "respond" as const,
    purposeCode: "supervisor_lifecycle_done",
    shortPurpose: "子结果到位后收尾",
    payload: { evidenceRefs: [] },
  };
}

/** 统一窗口：把生产尺度压到测试尺度，但保持"心跳间隔 ≪ 租约"的比例关系。 */
function supervisorWindows(input: {
  leaseMs: number;
  pendingWaitLimitMs: number;
  loopWindowMs: number;
  renewIntervalMs?: number;
  pendingPollIntervalMs?: number;
  instanceId?: string;
}) {
  return {
    leaseMs: input.leaseMs,
    renewIntervalMs: input.renewIntervalMs ?? 60,
    pendingPollIntervalMs: input.pendingPollIntervalMs ?? 30,
    pendingWaitLimitMs: input.pendingWaitLimitMs,
    loopWindowMs: input.loopWindowMs,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
  };
}

/**
 * 一个**真实**的 Hosted 应用服务（决策端口禁止进入、工具执行器返回 pending）。
 *
 * 它既用于进程内的 Supervisor 场景，也作为 `startRuntimeInvocation` 的应用边界 ——
 * 后者正是恢复/重投消费者使用的正式入口，因此"新代际继续一次"走的是生产路径。
 */
function hostedService(input: {
  leaseMs: number;
  pendingWaitLimitMs: number;
  loopWindowMs: number;
  counters?: { decisions: number; actions: number };
  /** 诊断身份：只为验证"领取者自报身份被如实记录"，不参与排他判定。 */
  instanceId?: string;
}): HostedRuntimeApplicationService {
  return createConfiguredHostedRuntimeApplicationService({
    decisionPort: {
      async decideNextAction() {
        if (input.counters) input.counters.decisions += 1;
        throw new Error("A03 夹具：在途子调用未终态，不得进入决策");
      },
    },
    finalResponsePort: {
      async generateFinalResponse() {
        return "";
      },
    },
    actionExecutors: {
      "tool.call": async () => {
        if (input.counters) input.counters.actions += 1;
        return pendingExecutor();
      },
    },
    transientEventBatchSink: async () => undefined,
    supervisor: supervisorWindows(input),
  });
}

function startInputFor(input: {
  tenantId: string;
  ctx: { runtimeRevision: { runtimeCapabilitiesJson: unknown } };
  invocation: Parameters<typeof startRuntimeInvocation>[0]["invocation"];
  binding: Parameters<typeof startRuntimeInvocation>[0]["binding"];
  attempt: Parameters<typeof startRuntimeInvocation>[0]["attempt"];
  applicationService: HostedRuntimeApplicationService;
}) {
  const preparationClaim = (
    input.attempt as typeof input.attempt & { preparationClaim?: AttemptPreparationClaim }
  ).preparationClaim;
  const client = createInProcessHostedRuntimeClient({
    tenantId: input.tenantId,
    publishedCapabilityEvidence: {
      runtimeRevisionId: input.binding.runtimeRevisionId,
      runtimeCapabilitiesJson: input.ctx.runtimeRevision.runtimeCapabilitiesJson,
    },
    applicationService: input.applicationService,
  });
  return {
    tenantId: input.tenantId,
    // A05：夹具的来源意图取 Invocation 自身身份，与 dispatcher 的首次 Start 同源。
    sourceOperationKey: `invocation:${input.invocation.id}`,
    invocation: input.invocation,
    binding: input.binding,
    attempt: input.attempt,
    ...(preparationClaim ? { preparationClaim } : {}),
    runtimeClient: client,
    runtimeEndpoint: "in-process://hosted",
    auth: { mode: "workload_token" as const, token: "a03-supervisor-token" },
    callbackEndpoints: CALLBACK_ENDPOINTS,
  };
}

function supervisorProcessConfig(input: {
  tenantId: string;
  invocationId: string;
  authority: AuthorityIdentity;
  leaseMs: number;
  pendingWaitLimitMs: number;
  loopWindowMs: number;
  renewIntervalMs?: number;
  pendingPollIntervalMs?: number;
  fixedInstanceId?: string;
}) {
  return {
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    authority: input.authority,
    inFlightActionId: IN_FLIGHT_ACTION_ID,
    leaseMs: input.leaseMs,
    renewIntervalMs: input.renewIntervalMs ?? 80,
    pendingPollIntervalMs: input.pendingPollIntervalMs ?? 30,
    pendingWaitLimitMs: input.pendingWaitLimitMs,
    loopWindowMs: input.loopWindowMs,
    ...(input.fixedInstanceId ? { fixedInstanceId: input.fixedInstanceId } : {}),
  };
}

async function sessionOf(
  tenantId: string,
  sessionBindingId: string,
): Promise<RuntimeSessionBinding> {
  const session = await getRuntimeSessionBindingById(tenantId, sessionBindingId);
  if (!session) throw new Error("Session 不存在");
  return session;
}

async function ownerRow(tenantId: string, ownershipId: string) {
  const [row] = await db
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.id, ownershipId),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`Owner 不存在: ${ownershipId}`);
  return row;
}

async function invocationState(invocationId: string) {
  const [row] = await db
    .select({ executionState: invocationTable.executionState })
    .from(invocationTable)
    .where(eq(invocationTable.id, invocationId))
    .limit(1);
  return row?.executionState ?? null;
}

/** 当前代际的准确 authority（由持久事实推导，不手抄字段）。 */
async function currentAuthorityOf(
  tenantId: string,
  invocationId: string,
): Promise<AuthorityIdentity> {
  const owner = await getActiveExecutionOwnership({ tenantId, invocationId });
  if (!owner) throw new Error("没有 active Owner");
  const session = await getRuntimeSessionBindingByOwnership(tenantId, owner.id);
  if (!session) throw new Error("没有唯一 Session");
  return authorityIdentity({
    invocationId,
    runtimeRevisionId: session.runtimeRevisionId,
    attemptId: owner.attemptId,
    ownershipId: owner.id,
    leaseEpoch: owner.leaseEpoch,
    sessionBindingId: session.id,
  });
}

/**
 * 把某个代际"隔离到共同租约过期"。
 *
 * 这不是伪造恢复结论：T03 的 setup 就是「A 已 claim；将 A 停止/隔离到共同 lease 过期」。
 * 这里只把**租约**推到过去，Owner/Session 状态与 claim 归属一个字都不改；恢复结论仍然只能
 * 由正式消费者在根锁内做出（"禁止手写 O 伪造恢复完成"）。
 */
async function expireGenerationLease(input: {
  tenantId: string;
  ownershipId: string;
  sessionBindingId: string;
}) {
  const owner = await ownerRow(input.tenantId, input.ownershipId);
  const now = await getAuthorityDatabaseTime(db);
  // `ExecutionOwnership_lease_expiry_shape` 要求 `leaseExpiresAt > acquiredAt`。
  await db
    .update(executionOwnershipTable)
    .set({
      leaseExpiresAt: new Date(owner.acquiredAt.getTime() + 1),
      lastHeartbeatAt: owner.acquiredAt,
      updatedAt: now,
    })
    .where(eq(executionOwnershipTable.id, owner.id));
  const session = await sessionOf(input.tenantId, input.sessionBindingId);
  if (session.supervisorLeaseExpiresAt === null) throw new Error("代际还没有 claim，无法过期");
  await db
    .update(runtimeSessionBindingTable)
    .set({ supervisorLeaseExpiresAt: new Date(now.getTime() - 1_000), updatedAt: now })
    .where(eq(runtimeSessionBindingTable.id, session.id));
}

/** 直接经 Session 写入口领取（供 T04/T05 观察续租准入本身）。 */
async function claimForTest(input: {
  tenantId: string;
  sessionBindingId: string;
  claimId: string;
  instanceId: string;
  leaseMs: number;
}) {
  return db.transaction(async (tx) => {
    const now = await getAuthorityDatabaseTime(tx);
    return claimRuntimeSessionSupervisorInTransaction(tx, {
      tenantId: input.tenantId,
      id: input.sessionBindingId,
      claimId: input.claimId,
      instanceId: input.instanceId,
      leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
      now,
    });
  });
}

function renewalInputFor(input: {
  tenantId: string;
  authority: AuthorityIdentity;
  claimId: string;
  instanceId: string;
  leaseTtlMs?: number;
  absoluteDeadlineAt?: Date;
}) {
  return {
    tenantId: input.tenantId,
    authority: {
      invocationId: input.authority.invocationId,
      attemptId: input.authority.attemptId,
      ownershipId: input.authority.ownershipId,
      leaseEpoch: Number(input.authority.leaseEpoch),
      sessionBindingId: input.authority.sessionBindingId,
      runtimeRevisionId: input.authority.runtimeRevisionId,
    },
    claimId: input.claimId,
    instanceId: input.instanceId,
    leaseTtlMs: input.leaseTtlMs ?? 30_000,
    absoluteDeadlineAt: input.absoluteDeadlineAt ?? new Date(Date.now() + 600_000),
  };
}

/** 统一围栏探针：行动接纳是否被允许（不抛错即允许）。 */
async function runActionGuard(input: {
  tenantId: string;
  authority: AuthorityIdentity;
  requiredPhase?: "activating" | "dispatching" | "executing" | "suspending";
}) {
  return db.transaction(async (tx) => {
    try {
      await authorizeRuntimeAction({
        tenantId: input.tenantId,
        authority: input.authority,
        executor: tx,
        requiredPhase: input.requiredPhase ?? "executing",
      });
      return { allowed: true as const };
    } catch (error) {
      return { allowed: false as const, error };
    }
  });
}

/** 轮询等一个持久事实成立（真实进程的提交点不由父进程安排）。 */
async function waitForFact(
  read: () => Promise<boolean>,
  message: string,
  attempts = 300,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (await read()) return;
    await sleep(25);
  }
  throw new Error(`等待超时：${message}`);
}

async function reportOf(handle: SupervisorProcessHandle): Promise<SupervisorProcessReport> {
  return handle.report;
}

describe("A03：Hosted Supervisor 身份、唯一 claim 与失权闭环", () => {
  beforeEach(async () => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
    await resetDatabase(db);
  });

  afterEach(() => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = ORIGINAL_AUTH_MODE;
    vi.restoreAllMocks();
  });

  it("A03-T01: 两个真实进程使用生产默认身份，只有一个取得该代际的 claim 并跑 Loop", async () => {
    const { ctx, invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = ctx.tenantId;
    const config = supervisorProcessConfig({
      tenantId,
      invocationId: invocation.id,
      authority: gen.authority,
      leaseMs: 4_000,
      pendingWaitLimitMs: 900,
      loopWindowMs: 30_000,
    });

    // 不注入实例身份：两个进程各自调用生产默认工厂，实例 id 由进程启动时生成。
    const handles = [await spawnSupervisorProcess(config), await spawnSupervisorProcess(config)];
    const reports = await Promise.all(handles.map(reportOf));

    // 真实不同进程：PID 与默认实例身份都不同，且身份不是 PID 派生值。
    expect(reports[0]?.pid).not.toBe(reports[1]?.pid);
    expect(reports[0]?.instanceId).not.toBe(reports[1]?.instanceId);
    for (const report of reports) {
      expect(report.instanceId).toMatch(INSTANCE_ID_SHAPE);
      expect(report.instanceId).not.toContain(String(report.pid));
    }

    // "仅一个实际 Loop"：执行器只会被真正在跑的 Loop 调用，这是每个进程自己的行为事实。
    const runners = reports.filter((report) => report.actionExecutions > 0);
    expect(runners, `执行者数量不为 1：${JSON.stringify(reports)}`).toHaveLength(1);
    const loser = reports.find((report) => report.actionExecutions === 0);
    expect(loser?.decisionCalls).toBe(0);

    // "仅一份 claim"：持久事实里只有一个 claimId，且它属于获胜进程的实例身份。
    const session = await sessionOf(tenantId, gen.session.id);
    expect(session.supervisorClaimId).not.toBeNull();
    expect(session.supervisorClaimId).toMatch(UUID_SHAPE);
    expect(session.supervisorInstanceId).toBe(runners[0]?.instanceId);
    // nonce 与实例身份是两件不同的东西。
    expect(session.supervisorClaimId).not.toBe(session.supervisorInstanceId);
    // 退休墓碑已写下，但历史 claim 没有被清零 —— 该代际不可能再被领取。
    expect(session.supervisorReleasedAt).not.toBeNull();

    // 子调用没有被重做：动作身份只出现一次 started。
    expect(
      await countActionEvents(
        tenantId,
        invocation.id,
        IN_FLIGHT_ACTION_ID,
        "harness.action.started",
      ),
    ).toBe(1);
  }, 120_000);

  it("A03-T02: 身份字符串完全相同（同 PID 形态）仍只有一方执行，且默认身份与 PID 无关", async () => {
    const { ctx, invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = ctx.tenantId;

    const winner = await spawnSupervisorProcess(
      supervisorProcessConfig({
        tenantId,
        invocationId: invocation.id,
        authority: gen.authority,
        leaseMs: 6_000,
        pendingWaitLimitMs: 2_500,
        loopWindowMs: 30_000,
      }),
    );
    const winnerReady = await winner.ready;

    // 反向对照：把第二个进程的实例身份固定成与第一个**完全相同**的字符串 ——
    // 这正是"两个容器各自认为自己的 PID 是 1"时旧实现产生的形态。
    const collided = await spawnSupervisorProcess(
      supervisorProcessConfig({
        tenantId,
        invocationId: invocation.id,
        authority: gen.authority,
        leaseMs: 6_000,
        pendingWaitLimitMs: 300,
        loopWindowMs: 30_000,
        fixedInstanceId: winnerReady.instanceId,
      }),
    );
    const collidedReport = await reportOf(collided);
    const winnerReport = await reportOf(winner);

    // 身份字符串相同也不产生第二个执行者：排他依据是 claim nonce，不是实例身份字符串。
    expect(collidedReport.decisionCalls).toBe(0);
    expect(collidedReport.actionExecutions).toBe(0);
    expect(collidedReport.pid).not.toBe(winnerReport.pid);
    // 生产默认身份不是 PID 的函数。
    expect(winnerReport.instanceId).toMatch(INSTANCE_ID_SHAPE);
    expect(winnerReport.instanceId).not.toContain(String(winnerReport.pid));

    const session = await sessionOf(tenantId, gen.session.id);
    expect(session.supervisorInstanceId).toBe(winnerReport.instanceId);
    expect(session.supervisorClaimId).toMatch(UUID_SHAPE);
  }, 120_000);

  it("A03-T03: 过期 Supervisor 不能在同一 Ownership 换手，B 只能取得新代际", async () => {
    const { ctx, invocation, binding, attempt, gen } =
      await seedActiveGenerationWithInFlightChild();
    const tenantId = ctx.tenantId;

    // A：真实子进程先成为执行者，然后被强杀（不做交接，模拟进程被隔离/杀死的形态）。
    const a = await spawnSupervisorProcess(
      supervisorProcessConfig({
        tenantId,
        invocationId: invocation.id,
        authority: gen.authority,
        leaseMs: 8_000,
        pendingWaitLimitMs: 5_000,
        loopWindowMs: 30_000,
      }),
    );
    await waitForFact(async () => {
      const session = await sessionOf(tenantId, gen.session.id);
      return session.supervisorClaimId !== null;
    }, "A 取得 claim");
    const claimedByA = await sessionOf(tenantId, gen.session.id);
    const eventsBeforeTakeover = await countAllIngressEvents(tenantId, invocation.id);
    a.kill("SIGKILL");
    await a.report.catch(() => undefined);

    // 隔离到共同租约过期（只有租约事实变化，claim 归属与状态不变）。
    await expireGenerationLease({
      tenantId,
      ownershipId: gen.ownership.id,
      sessionBindingId: gen.session.id,
    });

    // B 在同一 Ownership 上重领：必须被拒。
    const b = await spawnSupervisorProcess(
      supervisorProcessConfig({
        tenantId,
        invocationId: invocation.id,
        authority: gen.authority,
        leaseMs: 4_000,
        pendingWaitLimitMs: 300,
        loopWindowMs: 30_000,
      }),
    );
    const bReport = await reportOf(b);
    expect(bReport.actionExecutions, "旧 S 不得被 B 重领并继续执行").toBe(0);
    expect(bReport.decisionCalls).toBe(0);
    const afterB = await sessionOf(tenantId, gen.session.id);
    expect(afterB.supervisorClaimId).toBe(claimedByA.supervisorClaimId);
    expect(await countAllIngressEvents(tenantId, invocation.id)).toBe(eventsBeforeTakeover);

    // 只换 Owner、沿用**同一个** Attempt 的重投也必须被拒（A03-05）。
    // 这是旧实现自相矛盾的精确形态：`prepareChecks` 在接管收口**之前**看到 `running` 而放行，
    // 同一事务随后把该行写成 `lost`（未终态 → 终态必须带 finishedAt），新 Owner 于是挂在
    // 一个已收口的 Attempt 上；下游 `execution.started` 再写 `running` 必然违反
    // `InvocationAttempt_terminal_shape`。接管会收口旧 Attempt，所以新代际必须另有 Attempt。
    const eventsBeforeAttemptFence = await countAllIngressEvents(tenantId, invocation.id);
    await expect(
      startRuntimeInvocation(
        startInputFor({
          tenantId,
          ctx,
          invocation,
          binding,
          attempt,
          applicationService: hostedService({
            leaseMs: 4_000,
            pendingWaitLimitMs: 300,
            loopWindowMs: 30_000,
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "AttemptMismatch" });
    // fail closed：没有任何归属或事件被这次被拒的重投改写。
    expect((await getActiveExecutionOwnership({ tenantId, invocationId: invocation.id }))?.id).toBe(
      gen.ownership.id,
    );
    expect((await sessionOf(tenantId, gen.session.id)).supervisorClaimId).toBe(
      claimedByA.supervisorClaimId,
    );
    expect(await countAllIngressEvents(tenantId, invocation.id)).toBe(eventsBeforeAttemptFence);

    // 正式接管自带新 Attempt —— 与生产各 Start 调用方（`dispatcher` /
    // `redispatchRuntimeInvocation` / `dispatch-queued-invocation-attempt`）同形。
    const takeoverAttempt = await createPreparedTakeoverAttempt({
      tenantId,
      invocationId: invocation.id,
      retryReasonCode: "supervisor_lifecycle_takeover",
    });
    expect(takeoverAttempt.id).not.toBe(attempt.id);
    expect(takeoverAttempt.attemptNo).toBeGreaterThan(attempt.attemptNo);

    // B 经**正式 Start 入口**（恢复/重投消费者调用的就是它）取得新代际。
    await startRuntimeInvocation(
      startInputFor({
        tenantId,
        ctx,
        invocation,
        binding,
        attempt: takeoverAttempt,
        applicationService: hostedService({
          leaseMs: 4_000,
          pendingWaitLimitMs: 400,
          loopWindowMs: 30_000,
        }),
      }),
    );
    const newOwner = await getActiveExecutionOwnership({ tenantId, invocationId: invocation.id });
    expect(newOwner).not.toBeNull();
    expect(newOwner?.id).not.toBe(gen.ownership.id);
    expect(newOwner?.leaseEpoch).toBeGreaterThan(gen.ownership.leaseEpoch);
    // 新一代际**就位**：新 Ownership / 新 epoch / 新 Session，并且已经取得本代际的
    // claim —— 即"只有换代际才能换执行者"的正向证据。
    //
    // 与 A03-T07 的分工：本场景的判据是"**不能**在原代际换手 + 旧代际被统一围栏"；
    // 新代际"继续一次在途子调用"由 T07 在稳定夹具下断言 —— 本场景刚 SIGKILL 过旧执行者，
    // 新代际的启动写入与服务器回收被杀进程的事务存在竞态，不适合作为本场景的判据。
    // 新代际的 claim 由它**自己的启动路径**异步取得（见上面的异步说明），因此这里按
    // 有界等待确认它真的取得了本代际的 claim —— 而不是留下一个没人持有的僵尸代际。
    await waitForFact(async () => {
      const owned = newOwner
        ? await getRuntimeSessionBindingByOwnership(tenantId, newOwner.id)
        : null;
      return owned?.supervisorClaimId != null;
    }, "新一代际取得本代际 claim");
    const newSession = await getRuntimeSessionBindingByOwnership(tenantId, newOwner?.id ?? "");
    expect(newSession).not.toBeNull();
    expect(newSession?.invocationId).toBe(invocation.id);
    // A03-01：claim 持有者身份是**生产默认进程身份**（`worker-instance:<uuid>`），非 PID 形态。
    expect(newSession?.supervisorInstanceId).toMatch(INSTANCE_ID_SHAPE);
    // 旧代际的在途动作没有被算成"已完成"（它的失权收口不得替新代际结账）。
    expect(
      await countActionEvents(
        tenantId,
        invocation.id,
        IN_FLIGHT_ACTION_ID,
        "harness.action.completed",
      ),
    ).toBe(0);
    expect(
      await countActionEvents(
        tenantId,
        invocation.id,
        IN_FLIGHT_ACTION_ID,
        "harness.action.started",
      ),
    ).toBe(1);

    // 旧 A 的正式推进一律被统一围栏拒绝。
    const staleAction = await runActionGuard({ tenantId, authority: gen.authority });
    expect(staleAction.allowed).toBe(false);
    await expect(
      ingressRuntimeEvents({
        tenantId,
        invocationId: invocation.id,
        batch: {
          protocolVersion: 3,
          authority: gen.authority,
          events: [
            {
              eventId: randomUUID(),
              producerSequence: String(invocation.lastProducerSequence + 2n),
              type: "harness.action.completed",
              schemaVersion: 1,
              payload: { action_id: IN_FLIGHT_ACTION_ID, state: "completed" },
            },
          ],
        },
      }),
    ).rejects.toThrow();
    expect(
      await countActionEvents(
        tenantId,
        invocation.id,
        IN_FLIGHT_ACTION_ID,
        "harness.action.completed",
      ),
    ).toBe(0);
  }, 150_000);

  it("A03-T04: 共同续租不能部分成功——两项写入同事务提交或一起回滚", async () => {
    const { ctx, invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = ctx.tenantId;
    const claimId = randomUUID();
    const instanceId = workerInstanceId();
    const claim = await claimForTest({
      tenantId,
      sessionBindingId: gen.session.id,
      claimId,
      instanceId,
      leaseMs: 60_000,
    });
    expect(claim.claimed).toBe(true);

    const authority = await currentAuthorityOf(tenantId, invocation.id);
    const before = await sessionOf(tenantId, gen.session.id);
    const ownerBefore = await ownerRow(tenantId, gen.ownership.id);

    // 反向对照（"禁止先续 O 再验 S"）：claim nonce 不符时 Owner 一个字都不能写。
    const denied = await db.transaction((tx) =>
      renewHostedExecutionLeaseInTransaction(
        tx,
        renewalInputFor({ tenantId, authority, claimId: randomUUID(), instanceId }),
      ),
    );
    expect(denied.renewed).toBe(false);
    expect(denied.reason).toBe("claim_superseded");
    const ownerAfterDenied = await ownerRow(tenantId, gen.ownership.id);
    expect(ownerAfterDenied.leaseExpiresAt.getTime()).toBe(ownerBefore.leaseExpiresAt.getTime());
    expect(ownerAfterDenied.lastHeartbeatAt.getTime()).toBe(ownerBefore.lastHeartbeatAt.getTime());
    expect(ownerAfterDenied.versionNo).toBe(ownerBefore.versionNo);

    // 回滚屏障：两项写入之后抛错，则**两个截止时间一起回滚**。
    await expect(
      db.transaction(async (tx) => {
        await renewHostedExecutionLeaseInTransaction(
          tx,
          renewalInputFor({ tenantId, authority, claimId, instanceId }),
        );
        throw new Error("A03-T04 rollback barrier");
      }),
    ).rejects.toThrow("A03-T04 rollback barrier");
    const ownerAfterRollback = await ownerRow(tenantId, gen.ownership.id);
    const sessionAfterRollback = await sessionOf(tenantId, gen.session.id);
    expect(ownerAfterRollback.leaseExpiresAt.getTime()).toBe(ownerBefore.leaseExpiresAt.getTime());
    expect(sessionAfterRollback.supervisorLeaseExpiresAt?.getTime()).toBe(
      before.supervisorLeaseExpiresAt?.getTime(),
    );

    // 正常路径：O 与 S 写的是**同一个**截止时间。
    const renewed = await renewHostedExecutionLease(
      renewalInputFor({ tenantId, authority, claimId, instanceId }),
    );
    expect(renewed.renewed).toBe(true);
    const ownerFinal = await ownerRow(tenantId, gen.ownership.id);
    const sessionFinal = await sessionOf(tenantId, gen.session.id);
    expect(sessionFinal.supervisorLeaseExpiresAt?.getTime()).toBe(
      renewed.leaseExpiresAt?.getTime(),
    );
    expect(ownerFinal.leaseExpiresAt.getTime()).toBe(renewed.leaseExpiresAt?.getTime());
    expect(ownerFinal.lastHeartbeatAt.getTime()).toBeGreaterThan(
      ownerBefore.lastHeartbeatAt.getTime(),
    );

    // "未取得 claim 的请求不能续 O"：省略 claim 的裸续租在已领取的 Hosted 代际上被拒。
    await expect(
      renewExecutionOwnership({
        tenantId,
        invocationId: invocation.id,
        ownershipId: gen.ownership.id,
        attemptId: gen.ownership.attemptId,
        leaseEpoch: gen.ownership.leaseEpoch,
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });
  }, 60_000);

  it("A03-T05: 过期或已释放的 claim 不能续活，也不影响新 Owner", async () => {
    const { ctx, invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = ctx.tenantId;
    const claimId = randomUUID();
    const instanceId = workerInstanceId();
    await claimForTest({
      tenantId,
      sessionBindingId: gen.session.id,
      claimId,
      instanceId,
      leaseMs: 60_000,
    });
    const authority = await currentAuthorityOf(tenantId, invocation.id);

    // 1) 过期不复活：两份租约都过期之后，旧进程的心跳不得延长任何一份。
    await expireGenerationLease({
      tenantId,
      ownershipId: gen.ownership.id,
      sessionBindingId: gen.session.id,
    });
    const expiredBefore = await sessionOf(tenantId, gen.session.id);
    const expiredOwnerBefore = await ownerRow(tenantId, gen.ownership.id);
    const expiredRenew = await renewHostedExecutionLease(
      renewalInputFor({ tenantId, authority, claimId, instanceId }),
    );
    expect(expiredRenew.renewed).toBe(false);
    expect(expiredRenew.reason).toBe("ownership_expired");
    const expiredAfter = await sessionOf(tenantId, gen.session.id);
    const expiredOwnerAfter = await ownerRow(tenantId, gen.ownership.id);
    expect(expiredAfter.supervisorLeaseExpiresAt?.getTime()).toBe(
      expiredBefore.supervisorLeaseExpiresAt?.getTime(),
    );
    expect(expiredOwnerAfter.leaseExpiresAt.getTime()).toBe(
      expiredOwnerBefore.leaseExpiresAt.getTime(),
    );

    // 2) 已释放不得续活（"不存在 owner 字符串一样就续期"）。
    const released = await db.transaction((tx) =>
      releaseRuntimeSessionSupervisorInTransaction(tx, {
        tenantId,
        id: gen.session.id,
        claimId,
        now: new Date(),
      }),
    );
    expect(released).toBe(true);
    const releasedRenew = await renewHostedExecutionLease(
      renewalInputFor({ tenantId, authority, claimId, instanceId }),
    );
    expect(releasedRenew.renewed).toBe(false);
    expect(["claim_released", "ownership_expired"]).toContain(releasedRenew.reason);

    // 3) 终态代际不得续活。
    await db.transaction((tx) =>
      markRuntimeSessionLostInTransaction(tx, { tenantId, id: gen.session.id }),
    );
    const terminalRenew = await renewHostedExecutionLease(
      renewalInputFor({ tenantId, authority, claimId, instanceId }),
    );
    expect(terminalRenew.renewed).toBe(false);
    expect(terminalRenew.reason).toBe("session_terminal");

    // 4) 新代际接管后，旧心跳不得触碰新 Owner 的租约。
    // 接管会收口旧 Attempt，所以新代际必须另有 Attempt（见 `createTakeoverAttempt`）。
    const replacementAttempt = await createPreparedTakeoverAttempt({
      tenantId,
      invocationId: invocation.id,
      retryReasonCode: "supervisor_lifecycle_replacement",
    });
    const replacement = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: invocation.id,
      attemptId: replacementAttempt.id,
      runtimeRevisionId: gen.authority.runtimeRevisionId,
      phase: "dispatching",
    });
    const newOwnerBefore = await ownerRow(tenantId, replacement.ownership.id);
    const staleRenew = await renewHostedExecutionLease(
      renewalInputFor({ tenantId, authority, claimId, instanceId }),
    );
    expect(staleRenew.renewed).toBe(false);
    const newOwnerAfter = await ownerRow(tenantId, replacement.ownership.id);
    expect(newOwnerAfter.leaseExpiresAt.getTime()).toBe(newOwnerBefore.leaseExpiresAt.getTime());
    expect(newOwnerAfter.versionNo).toBe(newOwnerBefore.versionNo);
  }, 60_000);

  it("A03-T06: 真实 pending 持续心跳——父 Owner 不因等待而 lost，也不重做动作", async () => {
    const { ctx, invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = ctx.tenantId;
    const counters = { decisions: 0, actions: 0 };
    const service = hostedService({
      // 租约 300ms、心跳 60ms、等待上限 2s：等待窗口远超租约，只有"持续心跳"才活得下来。
      leaseMs: 300,
      pendingWaitLimitMs: 2_000,
      loopWindowMs: 30_000,
      counters,
    });

    const running = service.start({
      tenantId,
      invocationId: invocation.id,
      idempotencyKey: `start:${gen.ownership.id}`,
      authority: gen.authority,
    });

    await sleep(1_200);
    // 等待期间 Owner 仍是 active 且未过期（否则 recovery lane 会把 Invocation 收为 lost）。
    const owner = await getActiveExecutionOwnership({ tenantId, invocationId: invocation.id });
    expect(owner?.id).toBe(gen.ownership.id);
    expect(owner?.ownershipState).toBe("active");
    expect(owner?.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
    const session = await sessionOf(tenantId, gen.session.id);
    expect(session.supervisorClaimId).not.toBeNull();
    expect(session.supervisorReleasedAt).toBeNull();
    // 在途子调用没有被重做，也没有进入决策。
    expect(counters.decisions).toBe(0);
    expect(
      await countActionEvents(
        tenantId,
        invocation.id,
        IN_FLIGHT_ACTION_ID,
        "harness.action.started",
      ),
    ).toBe(1);
    expect(await countIngressEvents(tenantId, invocation.id, "harness.action.proposed")).toBe(0);

    const result = await running;
    expect(result.status).toBe("resumed");
    expect(result.pending).toBe(true);
    expect(result.completed).toBe(false);
  }, 40_000);

  it("A03-T07 / N01-T2: 主动交接由唯一持久消费者继任并登记旧资源退役", async () => {
    const { ctx, invocation, attempt, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = ctx.tenantId;

    const closeForHandoff = async (
      fixture: Awaited<ReturnType<typeof seedActiveGenerationWithInFlightChild>>,
    ) => {
      await db.transaction((tx) =>
        closeExecutionOwnershipInTransaction(tx, {
          tenantId: fixture.ctx.tenantId,
          invocationId: fixture.invocation.id,
          ownershipId: fixture.gen.ownership.id,
          attemptId: fixture.gen.ownership.attemptId,
          leaseEpoch: fixture.gen.ownership.leaseEpoch,
          state: "released",
          reasonCode: "supervisor_handoff",
        }),
      );
    };

    // 混入三类不可领取对象与一个会在单项派发时报错的对象。扫描与领取不能把它们当成
    // 当前合法交接，更不能让错误对象阻塞本用例的真实待办。
    const activeFixture = await seedActiveGenerationWithInFlightChild({ baseContext: ctx });
    await closeForHandoff(activeFixture);
    const activeSuccessor = await createPreparedTakeoverAttempt({
      tenantId: activeFixture.ctx.tenantId,
      invocationId: activeFixture.invocation.id,
      retryReasonCode: "supervisor_handoff",
    });
    await acquireTestRuntimeAuthority({
      tenantId: activeFixture.ctx.tenantId,
      invocationId: activeFixture.invocation.id,
      attemptId: activeSuccessor.id,
      runtimeRevisionId: activeFixture.binding.runtimeRevisionId,
      phase: "dispatching",
      runtimeCapabilitiesJson: activeFixture.ctx.runtimeRevision.runtimeCapabilitiesJson,
      activationEvidence: { fixture: "n01-active-successor" },
      activationDigest: protocolDigest({ fixture: "n01-active-successor" }),
    });

    const terminalFixture = await seedActiveGenerationWithInFlightChild({ baseContext: ctx });
    await closeForHandoff(terminalFixture);
    await db
      .update(invocationTable)
      .set({ executionState: "completed", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(invocationTable.id, terminalFixture.invocation.id));

    const notDueFixture = await seedActiveGenerationWithInFlightChild({ baseContext: ctx });
    await closeForHandoff(notDueFixture);
    await createPreparedTakeoverAttempt({
      tenantId: notDueFixture.ctx.tenantId,
      invocationId: notDueFixture.invocation.id,
      retryReasonCode: "supervisor_handoff",
    });

    const failingFixture = await seedActiveGenerationWithInFlightChild({ baseContext: ctx });
    await closeForHandoff(failingFixture);

    // Supervisor 触达已定义的退出边界（等待有界），子工作尚未完成。
    const supervisor = await spawnSupervisorProcess(
      supervisorProcessConfig({
        tenantId,
        invocationId: invocation.id,
        authority: gen.authority,
        leaseMs: 2_000,
        pendingWaitLimitMs: 600,
        loopWindowMs: 30_000,
      }),
    );
    const supervisorReport = await reportOf(supervisor);
    expect(supervisorReport.actionExecutions).toBeGreaterThanOrEqual(1);

    // 交接后：Owner 不再是 active、本代际 Session 已收口、claim 已退休但历史 claim 保留。
    const handedOffOwner = await ownerRow(tenantId, gen.ownership.id);
    expect(handedOffOwner.ownershipState).toBe("released");
    const handedOffSession = await sessionOf(tenantId, gen.session.id);
    expect(handedOffSession.bindingState).toBe("lost");
    expect(handedOffSession.supervisorReleasedAt).not.toBeNull();
    expect(handedOffSession.supervisorClaimId).not.toBeNull();
    const stateAfterHandoff = await invocationState(invocation.id);
    // Invocation 保持非终态：未完成的持久子动作仍要由新代际继续，不能被交接顺手丢弃。
    expect(stateAfterHandoff).not.toBe("lost");
    expect(stateAfterHandoff).not.toBe("failed");

    const scanned = await scanSupervisorHandoffs({ limit: 20 });
    const scannedInvocations = new Set(scanned.map((candidate) => candidate.invocationId));
    expect(scannedInvocations.has(activeFixture.invocation.id)).toBe(false);
    expect(scannedInvocations.has(terminalFixture.invocation.id)).toBe(false);
    expect(scannedInvocations.has(notDueFixture.invocation.id)).toBe(true);
    expect(scannedInvocations.has(failingFixture.invocation.id)).toBe(true);
    expect(scannedInvocations.has(invocation.id)).toBe(true);

    // 正式恢复车道运行一轮：已正式退休的代际不得被当成"租约过期的活跃 Owner"再处理一遍。
    const recovery = await runDueExpiredOwnerRecoveries({ limit: 50 });
    expect(recovery.recovered).toBe(0);
    expect(await invocationState(invocation.id)).toBe(stateAfterHandoff);

    // 只运行生产 Worker 实际装配的持久消费者。测试不得手工创建 Attempt 或手工调用 Start；
    // released/supervisor_handoff 是消费者可在崩溃后回读的义务身份。
    const counters = { decisions: 0, actions: 0 };
    const handoffService = hostedService({
      leaseMs: 2_000,
      pendingWaitLimitMs: 400,
      loopWindowMs: 30_000,
      counters,
    });
    const dispatchAttempt: typeof dispatchQueuedInvocationAttempt = async (input) => {
      const [candidateAttempt] = await db
        .select({ invocationId: invocationAttemptTable.invocationId })
        .from(invocationAttemptTable)
        .where(eq(invocationAttemptTable.id, input.attemptId))
        .limit(1);
      if (candidateAttempt?.invocationId === failingFixture.invocation.id) {
        throw new Error("n01-single-candidate-failure");
      }
      return dispatchQueuedInvocationAttempt(input);
    };
    const handoffRecoveries = await Promise.all(
      ["worker-a", "worker-b"].map(() =>
        runDueUndispatchedIntentRecoveries({
          now: new Date(),
          batchSize: 20,
          dependencies: { hostedApplicationService: handoffService, dispatchAttempt },
        }),
      ),
    );
    expect(handoffRecoveries.reduce((sum, report) => sum + report.handoffs.recovered, 0)).toBe(1);

    const newOwner = await getActiveExecutionOwnership({ tenantId, invocationId: invocation.id });
    expect(newOwner?.id).not.toBe(gen.ownership.id);
    expect(newOwner?.leaseEpoch).toBeGreaterThan(gen.ownership.leaseEpoch);
    expect(newOwner?.attemptId).not.toBe(attempt.id);
    // 见 T03：`startRuntimeInvocation` 只**建立**代际，Hosted 侧推进是异步的。
    await waitForFact(async () => counters.actions >= 1, "新代际继续一次在途子调用");

    // 旧代际仍是 lost，且没有被新执行者"复活"。
    const oldSessionAfter = await sessionOf(tenantId, gen.session.id);
    expect(oldSessionAfter.bindingState).toBe("lost");
    expect(oldSessionAfter.supervisorClaimId).toBe(handedOffSession.supervisorClaimId);
    expect(
      await countActionEvents(
        tenantId,
        invocation.id,
        IN_FLIGHT_ACTION_ID,
        "harness.action.started",
      ),
    ).toBe(1);
  }, 120_000);

  it("N01-T1: 超过扫描批次的已消费 handoff 历史不会遮住当前真实待办", async () => {
    const { ctx, invocation, binding, gen } = await seedActiveGenerationWithInFlightChild();
    let current = gen;
    for (let index = 0; index < 10; index += 1) {
      await db.transaction(async (tx) => {
        await closeExecutionOwnershipInTransaction(tx, {
          tenantId: ctx.tenantId,
          invocationId: invocation.id,
          ownershipId: current.ownership.id,
          attemptId: current.ownership.attemptId,
          leaseEpoch: current.ownership.leaseEpoch,
          state: "released",
          reasonCode: "supervisor_handoff",
        });
      });
      if (index < 9) {
        const nextAttempt = await createPreparedTakeoverAttempt({
          tenantId: ctx.tenantId,
          invocationId: invocation.id,
          retryReasonCode: "supervisor_handoff",
        });
        current = await acquireTestRuntimeAuthority({
          tenantId: ctx.tenantId,
          invocationId: invocation.id,
          attemptId: nextAttempt.id,
          runtimeRevisionId: binding.runtimeRevisionId,
          phase: "dispatching",
          runtimeCapabilitiesJson: ctx.runtimeRevision.runtimeCapabilitiesJson,
          activationEvidence: { fixture: `handoff-history-${index}` },
          activationDigest: protocolDigest({ fixture: `handoff-history-${index}` }),
        });
      }
    }
    const candidates = await scanSupervisorHandoffs({ limit: 1 });
    expect(candidates).toEqual([
      expect.objectContaining({
        invocationId: invocation.id,
        sourceOwnershipId: current.ownership.id,
      }),
    ]);
    const historical = await db
      .select({ reasonCode: executionOwnershipTable.reasonCode })
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.invocationId, invocation.id));
    expect(historical.filter((row) => row.reasonCode === "supervisor_handoff")).toHaveLength(10);
  }, 120_000);

  it("A03-T08: 执行期限由领取时冻结，不随重新进入 Loop 重置", async () => {
    const { invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = (await invocationOwnerTenant(invocation.id)) ?? "";
    const service = hostedService({
      leaseMs: 5_000,
      // 等待上限远大于执行期限：唯一能让这次执行结束的就是**冻结的绝对期限**。
      pendingWaitLimitMs: 60_000,
      loopWindowMs: 400,
    });

    const startedAt = Date.now();
    const result = await service.start({
      tenantId,
      invocationId: invocation.id,
      idempotencyKey: `start:${gen.ownership.id}`,
      authority: gen.authority,
    });
    const elapsed = Date.now() - startedAt;
    expect(result.status).toBe("resumed");
    // 期满即收口：旧实现每轮 `Date.now() + 窗口`，这里会一直转满等待上限（60s）。
    expect(elapsed, `执行期限未被冻结（耗时 ${elapsed}ms）`).toBeLessThan(10_000);
    expect(elapsed).toBeGreaterThanOrEqual(300);

    // 期满后不再写合法结果：代际已交接，Owner 释放、claim 退休。
    const session = await sessionOf(tenantId, gen.session.id);
    expect(session.supervisorReleasedAt).not.toBeNull();
    const owner = await ownerRow(tenantId, gen.ownership.id);
    expect(owner.ownershipState).toBe("released");
  }, 30_000);

  it("A03-T09: 旧代际迟到的模型结果与动作不得进入新代际", async () => {
    const { ctx, invocation, binding, attempt, gen } =
      await seedActiveGenerationWithInFlightChild();
    const tenantId = ctx.tenantId;

    // A 计算等待网络：真实子进程先取得 claim 并停在 pending。
    const a = await spawnSupervisorProcess(
      supervisorProcessConfig({
        tenantId,
        invocationId: invocation.id,
        authority: gen.authority,
        leaseMs: 8_000,
        pendingWaitLimitMs: 6_000,
        loopWindowMs: 30_000,
      }),
    );
    await waitForFact(async () => {
      const session = await sessionOf(tenantId, gen.session.id);
      return session.supervisorClaimId !== null;
    }, "A 取得 claim");
    a.kill("SIGKILL");
    await a.report.catch(() => undefined);
    await expireGenerationLease({
      tenantId,
      ownershipId: gen.ownership.id,
      sessionBindingId: gen.session.id,
    });

    // B 正式接管：新代际 + 新 Attempt（基础设施替换规则，见 `createTakeoverAttempt`）。
    const counters = { decisions: 0, actions: 0 };
    const takeoverAttempt = await createPreparedTakeoverAttempt({
      tenantId,
      invocationId: invocation.id,
      retryReasonCode: "supervisor_lifecycle_takeover",
    });
    await startRuntimeInvocation(
      startInputFor({
        tenantId,
        ctx,
        invocation,
        binding,
        attempt: takeoverAttempt,
        applicationService: hostedService({
          leaseMs: 4_000,
          pendingWaitLimitMs: 500,
          loopWindowMs: 30_000,
          // 计数必须真的接进来：否则下面"B 的计数不受影响"是分母为 0 的恒真断言。
          counters,
        }),
      }),
    );
    const newOwner = await getActiveExecutionOwnership({ tenantId, invocationId: invocation.id });
    if (!newOwner) throw new Error("新代际未建立 active Owner");
    expect(newOwner.id).not.toBe(gen.ownership.id);
    const newOwnerId = newOwner.id;
    // 新代际的推进是异步的（`startRuntimeInvocation` 只**建立**代际）。必须先等它真的接管了
    // 在途子调用再取样：否则取样点落在启动写入中间，B 自己的启动写入会被误读成
    // "A 的迟到结果被接纳"。
    await waitForFact(async () => counters.actions >= 1, "新代际继续一次在途子调用");

    // A 的结果这时才到达：行动接纳、持久事件、transient 三条路都必须被拒。
    const lateGuard = await runActionGuard({ tenantId, authority: gen.authority });
    expect(lateGuard.allowed).toBe(false);
    const lateEventId = randomUUID();
    await expect(
      ingressRuntimeEvents({
        tenantId,
        invocationId: invocation.id,
        batch: {
          protocolVersion: 3,
          authority: gen.authority,
          events: [
            {
              eventId: lateEventId,
              producerSequence: String(invocation.lastProducerSequence + 3n),
              type: "harness.action.proposed",
              schemaVersion: 1,
              payload: { action_id: "late-a-action", step_no: 9 },
            },
          ],
        },
      }),
    ).rejects.toThrow();
    await expect(
      ingressTransientBatch({
        tenantId,
        invocationId: invocation.id,
        authority: gen.authority,
        transientSequenceStart: 1,
        events: [
          {
            transient_id: "late-a-delta",
            type: "response.delta",
            transient_sequence: 1,
            payload: { text: "迟到代际的正文" },
          },
        ],
      }),
    ).rejects.toThrow();

    // 只观察 A 的精确事件/动作身份；B 的异步 pending Loop 可以在此期间合法继续轮询，
    // 不能用 Invocation 全局事件总数或动作计数把 B 的正常进展误判为 A 越权。
    const lateEvents = await db
      .select({ id: runtimeEventIngressTable.id })
      .from(runtimeEventIngressTable)
      .where(
        and(
          eq(runtimeEventIngressTable.tenantId, tenantId),
          eq(runtimeEventIngressTable.invocationId, invocation.id),
          eq(runtimeEventIngressTable.producerEventId, lateEventId),
        ),
      );
    expect(lateEvents).toHaveLength(0);
    expect(
      await countActionEvents(tenantId, invocation.id, "late-a-action", "harness.action.proposed"),
    ).toBe(0);
    expect(counters.actions).toBeGreaterThanOrEqual(1);
    expect(counters.decisions).toBe(0);
    // 代际身份按 `leaseEpoch` 判：它是代际的不变量；而租约到期时间与 versionNo 会被 B
    // **自己**的合法心跳推进（默认间隔 60ms），拿它们当判据等于把 B 的正常心跳误判成
    // "A 的迟到影响"—— 旧断言只有在那次启动崩溃（即本包要修的那个缺陷）时才成立。
    const newOwnerAfter = await ownerRow(tenantId, newOwnerId);
    expect(newOwnerAfter.leaseEpoch).toBe(newOwner.leaseEpoch);
    // A 的原代际仍是失权态：旧 heartbeat 不得把旧代际重新激活。
    expect((await ownerRow(tenantId, gen.ownership.id)).ownershipState).toBe("lost");
  }, 150_000);

  it("A03-T10: 活跃代际的重复 Start 只是唤醒——不写第二次 started，也不覆盖 claim", async () => {
    // 起点是"A 已合法 Start、正在合法 pending"：夹具按生产时序落下唯一一条
    // `execution.started` 与在途子调用，因此"不得写第二次 started"有真实的分母。
    const { ctx, invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = ctx.tenantId;
    expect(await countIngressEvents(tenantId, invocation.id, "execution.started")).toBe(1);

    const holder = await spawnSupervisorProcess(
      supervisorProcessConfig({
        tenantId,
        invocationId: invocation.id,
        authority: gen.authority,
        leaseMs: 6_000,
        pendingWaitLimitMs: 8_000,
        loopWindowMs: 30_000,
      }),
    );
    // 等到持有者**真的取得 claim**（而不是"进程起来了"）：这才是重复 Start 的对照点。
    await waitForFact(
      async () => (await sessionOf(tenantId, gen.session.id)).supervisorClaimId !== null,
      "持有者取得 Supervisor claim",
    );
    const claimed = await sessionOf(tenantId, gen.session.id);
    const eventsWhileHeld = await countAllIngressEvents(tenantId, invocation.id);

    // 另一个真实进程重投同一启动意图：只能唤醒/回答"仍在执行"。
    const duplicate = await spawnSupervisorProcess(
      supervisorProcessConfig({
        tenantId,
        invocationId: invocation.id,
        authority: gen.authority,
        leaseMs: 6_000,
        pendingWaitLimitMs: 200,
        loopWindowMs: 30_000,
      }),
    );
    const duplicateReport = await reportOf(duplicate);
    expect(duplicateReport.actionExecutions).toBe(0);
    expect(duplicateReport.decisionCalls).toBe(0);
    expect(duplicateReport.instanceId).not.toBe(claimed.supervisorInstanceId);

    // 不第二次 started、不新增任何事件、claim 未被覆盖。
    expect(await countIngressEvents(tenantId, invocation.id, "execution.started")).toBe(1);
    const afterDuplicate = await sessionOf(tenantId, gen.session.id);
    expect(afterDuplicate.supervisorClaimId).toBe(claimed.supervisorClaimId);
    expect(afterDuplicate.supervisorInstanceId).toBe(claimed.supervisorInstanceId);
    expect(afterDuplicate.supervisorReleasedAt).toBeNull();
    expect(await countAllIngressEvents(tenantId, invocation.id)).toBe(eventsWhileHeld);

    await reportOf(holder);
    // 持有者退出后交接，也不得出现第二名执行者的动作序列。
    expect(await countIngressEvents(tenantId, invocation.id, "harness.action.proposed")).toBe(0);
  }, 120_000);

  it("A03-T10b: 终态收口后 claim 不可复活，且交接事务幂等", async () => {
    const { invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = (await invocationOwnerTenant(invocation.id)) ?? "";
    const claimId = randomUUID();
    const instanceId = workerInstanceId();
    await claimForTest({
      tenantId,
      sessionBindingId: gen.session.id,
      claimId,
      instanceId,
      leaseMs: 30_000,
    });
    // 终态收口路径：先关 Owner 再收 Session（与 Cancel/终态 Ingress 同序）。
    await db.transaction(async (tx) => {
      await closeExecutionOwnershipInTransaction(tx, {
        tenantId,
        invocationId: invocation.id,
        ownershipId: gen.ownership.id,
        attemptId: gen.ownership.attemptId,
        leaseEpoch: gen.ownership.leaseEpoch,
        state: "released",
        reasonCode: "test_terminal_close",
      });
      await markRuntimeSessionLostInTransaction(tx, { tenantId, id: gen.session.id });
    });
    const session = await sessionOf(tenantId, gen.session.id);
    expect(session.supervisorReleasedAt).not.toBeNull();
    expect(session.supervisorClaimId).toBe(claimId);
    // 已收口的代际不能再被领取（终态直接拒绝）。
    await expect(
      claimForTest({
        tenantId,
        sessionBindingId: gen.session.id,
        claimId: randomUUID(),
        instanceId,
        leaseMs: 1_000,
      }),
    ).rejects.toThrow(/已收口/);
  }, 40_000);

  // ───────────────────────────────────────────────────────────────────────────
  // 既有 pending 正向用例：A03 只收紧了"谁有权推进"，没有改变"等待是正向路径"。
  // 两者必须原样保留（spec：既有 pending 正向用例保留），只是判据从旧的
  // `supervisorLeaseOwner`（可被清空的租约字符串）换成 claim 生命周期。
  // ───────────────────────────────────────────────────────────────────────────

  it("SUPERVISOR-01: pending 期间 Supervisor 不退场（Heartbeat 与工作身份持续推进），等待有界", async () => {
    const { invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = (await invocationOwnerTenant(invocation.id)) ?? "";
    const counters = { decisions: 0, actions: 0 };
    const service = hostedService({
      leaseMs: 400,
      pendingWaitLimitMs: 400,
      loopWindowMs: 5_000,
      counters,
      instanceId: "proc-01",
    });

    const running = service.start({
      tenantId,
      invocationId: invocation.id,
      idempotencyKey: `start:${gen.ownership.id}`,
      authority: gen.authority,
    });

    // 等待期间：Supervisor 仍在场内（promise 未 settle），Heartbeat 持续推进工作身份，
    // Owner 仍是 active 且未过期 —— 这正是"子调用还在跑时租约被持续持有"的判据。
    await sleep(200);
    const midSession = await sessionOf(tenantId, gen.session.id);
    // A03：诊断身份如实记录领取者（PID 形态已废除）；决定"是哪一次领取"的是 claim nonce。
    expect(midSession.supervisorInstanceId).toBe("proc-01");
    expect(midSession.supervisorClaimId).not.toBeNull();
    expect(midSession.supervisorReleasedAt).toBeNull();
    const firstExpiry = midSession.supervisorLeaseExpiresAt?.getTime() ?? 0;
    expect(firstExpiry).toBeGreaterThan(0);

    await sleep(140);
    const laterSession = await sessionOf(tenantId, gen.session.id);
    const laterExpiry = laterSession.supervisorLeaseExpiresAt?.getTime() ?? 0;
    // 心跳至少推进过一次租约到期时间（不是"挂着一个到期即失效的身份"）。
    expect(laterExpiry).toBeGreaterThan(firstExpiry);

    const owner = await getActiveExecutionOwnership({ tenantId, invocationId: invocation.id });
    expect(owner?.id).toBe(gen.ownership.id);
    expect(owner?.ownershipState).toBe("active");

    // 等待有界：超过 pendingWaitLimitMs 后返回 pending 并**交还**工作身份，
    // 不留下"进程内没人跑、数据库却声称健康执行"的窗口。
    const result = await running;
    expect(result.status).toBe("resumed");
    expect(result.pending).toBe(true);
    expect(result.completed).toBe(false);

    const handedOff = await sessionOf(tenantId, gen.session.id);
    expect(handedOff.bindingState).toBe("lost");
    // A03：交还只退休 claim，**不清零** —— 该代际仍保留"已分配给谁"的历史。
    expect(handedOff.supervisorReleasedAt).not.toBeNull();
    expect(handedOff.supervisorClaimId).toBe(midSession.supervisorClaimId);
    // 整个等待期间没有产生任何新动作（Supervisor 从未进入决策）。
    expect(counters.decisions).toBe(0);
    expect(await countIngressEvents(tenantId, invocation.id, "harness.action.proposed")).toBe(0);
  }, 30_000);

  it("SUPERVISOR-03: 子调用进入终态后 Supervisor 继续同代际推进直至完成", async () => {
    const { invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = (await invocationOwnerTenant(invocation.id)) ?? "";

    // 子调用先 pending，随后（模拟外部持久执行完成）变为终态。
    let childSettled = false;
    let decisions = 0;
    const service = createConfiguredHostedRuntimeApplicationService({
      decisionPort: {
        async decideNextAction() {
          decisions += 1;
          return respondDecision(2);
        },
      },
      finalResponsePort: {
        async generateFinalResponse() {
          return "子调用结束后完成的答复";
        },
      },
      actionExecutors: {
        "tool.call": async () =>
          childSettled
            ? {
                authorityRef: `tool-call:${IN_FLIGHT_ACTION_ID}`,
                observation: {
                  observationType: "tool" as const,
                  summary: "子调用已完成",
                  sourceRefs: [`tool-call:${IN_FLIGHT_ACTION_ID}`],
                  data: { state: "succeeded" },
                },
              }
            : pendingExecutor(),
      },
      transientEventBatchSink: async () => undefined,
      supervisor: supervisorWindows({
        leaseMs: 3_000,
        pendingWaitLimitMs: 6_000,
        loopWindowMs: 8_000,
        instanceId: "proc-03",
      }),
    });

    const running = service.start({
      tenantId,
      invocationId: invocation.id,
      idempotencyKey: `start:${gen.ownership.id}`,
      authority: gen.authority,
    });

    // 让等待循环先转几圈（此时子调用仍是 pending，Supervisor 仍在场且不决策）。
    await sleep(150);
    expect(decisions).toBe(0);
    expect(await countIngressEvents(tenantId, invocation.id, "harness.action.completed")).toBe(0);

    // 子调用进入终态：Supervisor 靠轮询读回结果并继续同代际推进（完成 respond）。
    childSettled = true;
    const result = await running;

    expect(result.completed).toBe(true);
    expect(decisions).toBe(1);
    // 在途动作只被执行一次：没有因为"重新进入 Loop"而重复写 started，也没有重复收口。
    // （按 action_id 计数是必需的：respond 动作自己也会写一条 started。）
    expect(
      await countActionEvents(
        tenantId,
        invocation.id,
        IN_FLIGHT_ACTION_ID,
        "harness.action.started",
      ),
    ).toBe(1);
    expect(
      await countActionEvents(
        tenantId,
        invocation.id,
        IN_FLIGHT_ACTION_ID,
        "harness.action.completed",
      ),
    ).toBe(1);
    // 整个代际只出现一个 respond 动作：不存在第二名执行者的决策序列。
    expect(await countIngressEvents(tenantId, invocation.id, "harness.action.proposed")).toBe(1);

    // A03：完成即交还。claim 只退休、不清零，同代际不可能再被第二个执行者领取。
    const handedOff = await sessionOf(tenantId, gen.session.id);
    expect(handedOff.supervisorClaimId).not.toBeNull();
    expect(handedOff.supervisorReleasedAt).not.toBeNull();
    expect(handedOff.bindingState).not.toBe("active");
    const owner = await getActiveExecutionOwnership({ tenantId, invocationId: invocation.id });
    expect(owner?.ownershipState ?? "released").not.toBe("active");
    // 已收口的旧代际拒绝任何重新领取（"换执行者必须换代际"的持久侧证据）。
    await expect(
      claimForTest({
        tenantId,
        sessionBindingId: gen.session.id,
        claimId: randomUUID(),
        instanceId: "proc-late",
        leaseMs: 1_000,
      }),
    ).rejects.toThrow();
  }, 40_000);
});

/** 夹具里的 tenant 由 `seedDispatchableTurn` 生成；这里只做一次定位，不参与断言。 */
async function invocationOwnerTenant(invocationId: string): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: invocationTable.tenantId })
    .from(invocationTable)
    .where(eq(invocationTable.id, invocationId))
    .limit(1);
  return row?.tenantId ?? null;
}
