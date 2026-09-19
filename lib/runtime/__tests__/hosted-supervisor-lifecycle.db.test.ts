/**
 * A03：Hosted Supervisor 的等待生命周期与跨进程唯一性。
 *
 * 审查报告指出两个缺口：
 *
 * 1. **真实 pending 子调用会结束 Supervisor 和 Heartbeat。** 默认 Tool executor 在 ToolCall
 *    处于 queued/running 时返回 `pending`，Loop 收到 pending 立即返回，`runHostedInvocation`
 *    的 `finally` 随即清掉 Heartbeat 并摘除进程内槽位。于是「子调用还在持久执行时 Supervisor
 *    始终持有租约」并不成立：只要子调用超过父执行剩余 Lease，Owner 会过期，recovery lane 把
 *    Invocation 收为 lost，之后的子结果 continuation 无法继续它。
 *
 * 2. **同代际唯一性只有进程内 Map。** `liveRunners` 在另一个进程里是空的，Session=active
 *    不是排他领取（它反而允许继续进入执行），因此两个进程读到同一 active Owner/Session
 *    后可以各跑一个决策循环。
 *
 * 契约（02-runtime-lifecycle §7）给的边界是：
 * 「子调用 pending 不等于人工暂停。Hosted Supervisor 可以等待持久子结果并持续有效任务
 *  Heartbeat；Continuation 只唤醒该 Supervisor，不再次 Start 同 generation。」
 *
 * 本文件在**真实 MySQL** 上验证修复后的三条真实路径。pending 的来源是**真实持久事实**：
 * 该 Invocation 的 Ledger 里已有一条 `harness.action.started` 的 tool.call（子调用正在
 * 持久执行），Loop 启动时经 `recoveryPort` 读回它并重试执行器 —— 这正是生产里
 * 「子调用 pending，父执行必须持租约等待」的形态，而不是伪造一个不在冻结目录里的工具。
 *
 * - SUPERVISOR-01：pending 期间 Supervisor 不退场——Heartbeat 持续推进、Session 级工作身份
 *   被持有；等待有界，超时退出并释放身份（不存在"进程内没人跑却声称健康"的窗口）。
 * - SUPERVISOR-02：**两个独立模块实例**（各自一份 `liveRunners`，等价于两个不共享内存、
 *   只共享数据库的进程）接收同一代际的启动身份时，只有一个成为执行者，另一个零事件写入。
 * - SUPERVISOR-03：子调用进入终态后被唤醒，Supervisor **继续**同代际推进直至完成。
 */
import { randomUUID } from "node:crypto";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { getActiveExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { acquireTestRuntimeAuthority } from "@/lib/executions/test-support/seed-runtime-authority";
import { runtimeEventIngressTable } from "@/lib/persistence/schema/executions";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { createConfiguredHostedRuntimeApplicationService } from "@/lib/runtime/application/runtime-resume";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { getRuntimeSessionBindingById } from "@/lib/runtime/persistence/runtime-session-store";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_VITEST_IDENTITY_FIXTURE;

/** 在途子调用的动作身份（父执行已持久化它，子调用尚未终态）。 */
const IN_FLIGHT_ACTION_ID = "action-supervisor-inflight-1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markPrepared(invocationId: string, attemptId: string) {
  const { markAttemptPreparedInTransaction } = await import(
    "@/lib/executions/persistence/attempt-store"
  );
  const evidence = { kind: "supervisor-lifecycle-candidate", invocationId, attemptId };
  await db.transaction((tx) =>
    markAttemptPreparedInTransaction(tx, {
      attemptId,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
}

/**
 * 建出「Hosted 执行已 active，且 Ledger 里有一条在途 tool.call」的代际。
 *
 * - Thread/Turn/Binding/Route 走真实调度（`seedDispatchableTurn` + `dispatchInvocationForTurn`）；
 * - Ownership=executing、Invocation=running、Session=active，代表"Start 已被承认、执行进行中"；
 * - 在途动作经**正式 Ingress** 写入（不是直接 INSERT），因此 Loop 恢复时读到的就是真实 Ledger。
 */
async function seedActiveGenerationWithInFlightChild() {
  const ctx = await seedDispatchableTurn();
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
  const gen = await acquireTestRuntimeAuthority({
    tenantId: ctx.tenantId,
    invocationId: invocation.id,
    attemptId: attempt.id,
    runtimeRevisionId: binding.runtimeRevisionId,
    phase: "executing",
  });
  // Session 从 prepared 推到 active（active shape 要求语义请求已冻结且远端引用已固定）。
  await applyRuntimeSessionDispatchForTest(ctx.tenantId, gen.session.id, {
    bindingState: "active",
    startedEventId: randomUUID(),
    remoteSessionRef: `hosted-session:${gen.session.id}`,
    remoteExecutionRef: `hosted-execution:${invocation.id}:${gen.ownership.id}`,
    semanticRequestJson: { fixture: "supervisor-lifecycle" },
    semanticRequestDigest: protocolDigest({ fixture: "supervisor-lifecycle" }),
  });

  // 在途子调用：父执行已持久化「该动作已开始」，子调用仍在持久执行中。
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
          producerSequence: String(invocation.lastProducerSequence + 1),
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
 * 按**动作身份**计数事件（A03：判据必须是"同一个动作只被执行一次"，
 * 而不是"整条 Invocation 里某类事件的总数" —— respond 动作本身也会写 started）。
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
function pendingExecutor() {
  return async () => ({
    authorityRef: `tool-call:${IN_FLIGHT_ACTION_ID}`,
    pending: {
      kind: "tool_call" as const,
      callId: IN_FLIGHT_ACTION_ID,
      state: "running" as const,
    },
  });
}

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

describe("A03：Hosted Supervisor 的等待与跨进程唯一性", () => {
  beforeEach(async () => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
    await resetDatabase(db);
  });

  afterEach(() => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = ORIGINAL_AUTH_MODE;
    vi.restoreAllMocks();
  });

  it("SUPERVISOR-01: pending 期间 Supervisor 不退场（Heartbeat 与工作身份持续推进），等待有界", async () => {
    const { ctx, invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = ctx.tenantId;

    const service = createConfiguredHostedRuntimeApplicationService({
      decisionPort: {
        async decideNextAction() {
          throw new Error("子调用 pending 期间不得进入决策");
        },
      },
      finalResponsePort: {
        async generateFinalResponse() {
          throw new Error("子调用 pending 期间不得生成最终回答");
        },
      },
      actionExecutors: { "tool.call": pendingExecutor() },
      transientEventBatchSink: async () => undefined,
      supervisor: {
        instanceId: "proc-01",
        leaseMs: 400,
        renewIntervalMs: 40,
        pendingPollIntervalMs: 30,
        pendingWaitLimitMs: 400,
        loopWindowMs: 5_000,
      },
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
    const midSession = await getRuntimeSessionBindingById(tenantId, gen.session.id);
    expect(midSession?.supervisorLeaseOwner).toContain("proc-01");
    expect(midSession?.supervisorLeaseExpiresAt).not.toBeNull();
    const firstExpiry = midSession?.supervisorLeaseExpiresAt?.getTime() ?? 0;

    await sleep(140);
    const laterSession = await getRuntimeSessionBindingById(tenantId, gen.session.id);
    const laterExpiry = laterSession?.supervisorLeaseExpiresAt?.getTime() ?? 0;
    // 心跳至少推进过一次租约到期时间（不是"挂着一个到期即失效的身份"）。
    expect(laterExpiry).toBeGreaterThan(firstExpiry);

    const owner = await getActiveExecutionOwnership({ tenantId, invocationId: invocation.id });
    expect(owner?.id).toBe(gen.ownership.id);
    expect(owner?.ownershipState).toBe("active");

    // 等待有界：超过 pendingWaitLimitMs 后返回 pending 并**释放**工作身份，
    // 不留下"进程内没人跑、数据库却声称健康执行"的窗口。
    const result = await running;
    expect(result.status).toBe("resumed");
    expect(result.pending).toBe(true);
    expect(result.completed).toBe(false);

    const released = await getRuntimeSessionBindingById(tenantId, gen.session.id);
    expect(released?.supervisorLeaseOwner).toBeNull();
    expect(released?.supervisorLeaseExpiresAt).toBeNull();
    // 整个等待期间没有产生任何新动作（Supervisor 从未进入决策）。
    expect(await countIngressEvents(tenantId, invocation.id, "harness.action.proposed")).toBe(0);
  }, 30_000);

  it("SUPERVISOR-02: 两个独立模块实例（等价两个进程）不能对同一代际产生两个执行者", async () => {
    const { ctx, invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = ctx.tenantId;

    // 报告指出的正是"另一个进程的 Map 为空"：这里用两份**独立模块实例**复现同一情形 ——
    // 它们不共享 liveRunners，只共享同一个真实数据库。
    const moduleA = await import("@/lib/runtime/application/runtime-resume");
    vi.resetModules();
    const moduleB = await import("@/lib/runtime/application/runtime-resume");
    expect(moduleA.resumeHarnessInvocation).not.toBe(moduleB.resumeHarnessInvocation);

    const supervisorSettings = (instanceId: string) => ({
      instanceId,
      leaseMs: 3_000,
      renewIntervalMs: 60,
      pendingPollIntervalMs: 40,
      pendingWaitLimitMs: 700,
      loopWindowMs: 5_000,
    });
    const serviceA = moduleA.createConfiguredHostedRuntimeApplicationService({
      decisionPort: {
        async decideNextAction() {
          throw new Error("A 不应决策");
        },
      },
      finalResponsePort: {
        async generateFinalResponse() {
          return "A";
        },
      },
      actionExecutors: { "tool.call": pendingExecutor() },
      transientEventBatchSink: async () => undefined,
      supervisor: supervisorSettings("proc-a"),
    });
    const serviceB = moduleB.createConfiguredHostedRuntimeApplicationService({
      decisionPort: {
        async decideNextAction() {
          throw new Error("B 不应在 A 持有期间决策");
        },
      },
      finalResponsePort: {
        async generateFinalResponse() {
          return "B";
        },
      },
      actionExecutors: { "tool.call": pendingExecutor() },
      transientEventBatchSink: async () => undefined,
      supervisor: supervisorSettings("proc-b"),
    });

    // 进程 A 先成为该代际的执行者。
    const runningA = serviceA.start({
      tenantId,
      invocationId: invocation.id,
      idempotencyKey: `start:${gen.ownership.id}`,
      authority: gen.authority,
    });
    let heldByA = false;
    for (let i = 0; i < 100 && !heldByA; i += 1) {
      await sleep(20);
      const s = await getRuntimeSessionBindingById(tenantId, gen.session.id);
      heldByA = (s?.supervisorLeaseOwner ?? "").includes("proc-a");
    }
    expect(heldByA).toBe(true);

    const eventsBeforeB = await countAllIngressEvents(tenantId, invocation.id);

    // 进程 B 收到同一启动/续接身份：必须被排他领取挡住，不产生第二个决策循环。
    const resultB = await serviceB.start({
      tenantId,
      invocationId: invocation.id,
      idempotencyKey: `start:${gen.ownership.id}`,
      authority: gen.authority,
    });
    expect(resultB.pending).toBe(true);
    // B 没有写任何事件（既不重复执行在途动作，也不产生第二名生产者的动作序列）。
    expect(await countAllIngressEvents(tenantId, invocation.id)).toBe(eventsBeforeB);
    const sessionWhileA = await getRuntimeSessionBindingById(tenantId, gen.session.id);
    expect(sessionWhileA?.supervisorLeaseOwner).toContain("proc-a");

    // A 的等待上限到点后正常退出并交还工作身份；B 之后可以合法接管同一代际。
    const resultA = await runningA;
    expect(resultA.pending).toBe(true);
    const released = await getRuntimeSessionBindingById(tenantId, gen.session.id);
    expect(released?.supervisorLeaseOwner).toBeNull();

    const runningB = serviceB.start({
      tenantId,
      invocationId: invocation.id,
      idempotencyKey: `start:${gen.ownership.id}`,
      authority: gen.authority,
    });
    let heldByB = false;
    for (let i = 0; i < 100 && !heldByB; i += 1) {
      await sleep(20);
      const s = await getRuntimeSessionBindingById(tenantId, gen.session.id);
      heldByB = (s?.supervisorLeaseOwner ?? "").includes("proc-b");
    }
    // 反向对照：B 之前"零事件写入"是排他领取的结果，而不是这条启动路径根本跑不起来。
    expect(heldByB).toBe(true);
    const resultBTakeover = await runningB;
    expect(resultBTakeover.pending).toBe(true);
  }, 40_000);

  it("SUPERVISOR-03: 子调用进入终态后 Supervisor 继续同代际推进直至完成", async () => {
    const { ctx, invocation, gen } = await seedActiveGenerationWithInFlightChild();
    const tenantId = ctx.tenantId;

    // 子调用先 pending，随后（模拟外部持久执行完成）变为终态。
    let childSettled = false;
    const executor = async () =>
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
        : {
            authorityRef: `tool-call:${IN_FLIGHT_ACTION_ID}`,
            pending: {
              kind: "tool_call" as const,
              callId: IN_FLIGHT_ACTION_ID,
              state: "running" as const,
            },
          };

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
      actionExecutors: { "tool.call": executor },
      transientEventBatchSink: async () => undefined,
      supervisor: {
        instanceId: "proc-03",
        leaseMs: 3_000,
        renewIntervalMs: 60,
        pendingPollIntervalMs: 30,
        pendingWaitLimitMs: 6_000,
        loopWindowMs: 8_000,
      },
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

    const released = await getRuntimeSessionBindingById(tenantId, gen.session.id);
    expect(released?.supervisorLeaseOwner).toBeNull();
  }, 40_000);
});
