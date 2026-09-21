/** Canonical Runtime resume and Hosted execution boundary. */
import { randomUUID } from "node:crypto";
import { cancelActiveAgentCalls } from "@/lib/agents/calls/application/cancel-active-agent-calls";
import { aiConfig } from "@/lib/config";
import { getItemById } from "@/lib/conversations/thread-item-queries";
import { getTurnById } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { getEnvironmentRevisionById } from "@/lib/environment/environment-definition-store";
import {
  getEnvironmentLeaseByAttempt,
  isPreparedReadinessState,
  registerEnvironmentLeaseCleanupForAttemptInTransaction,
} from "@/lib/environment/environment-lease-store";
import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import { closeInvocationTerminalInTransaction } from "@/lib/executions/application/close-invocation-terminal";
import {
  ExecutionAuthorityError,
  OWNERSHIP_LEASE_MS,
  authorityIdentity,
} from "@/lib/executions/domain/execution-authority";
import { getAttemptById, getLatestAttempt } from "@/lib/executions/persistence/attempt-store";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import {
  closeExecutionOwnershipInTransaction,
  getActiveExecutionOwnership,
  getAuthorityDatabaseTime,
  lockInvocationRootIfExists,
  renewExecutionOwnership,
  renewHostedExecutionLease,
} from "@/lib/executions/persistence/execution-ownership-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { assertJobInputDigestMatches } from "@/lib/job/job-input-digest";
import { threadItemTable } from "@/lib/persistence/schema/conversation";
import type { EnvironmentLease } from "@/lib/persistence/schema/environment";
import {
  type ExecutionBinding,
  INVOCATION_ATTEMPT_TERMINAL_STATES,
  INVOCATION_TERMINAL_STATES,
  type Invocation,
  type InvocationAttempt,
  executionOwnershipTable,
  invocationAttemptTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { JOB_TERMINAL_STATES, jobTable } from "@/lib/persistence/schema/job";
import {
  HostedHarnessLoop,
  type HostedHarnessLoopResult,
  type TransientEventBatchSink,
} from "@/lib/runtime/adapters/hosted-adapter";
import { resolveExecutionResources } from "@/lib/runtime/application/execution-resources";
import type {
  HostedRuntimeApplicationService,
  HostedRuntimeResumeResult,
} from "@/lib/runtime/application/hosted-runtime-application-service";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import {
  decideRuntimeStartSource,
  startRuntimeInvocation,
} from "@/lib/runtime/application/runtime-start";
import { resolveOutboundRuntimeAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
import {
  configuredDecisionPort,
  configuredFinalResponsePort,
} from "@/lib/runtime/harness-loop/configured-model-ports";
import type {
  HarnessActionExecutors,
  HarnessDecisionPort,
  HarnessFinalResponsePort,
} from "@/lib/runtime/harness-loop/loop";
import { createMySqlHarnessLoopRecoveryPort } from "@/lib/runtime/harness-loop/mysql-recovery-port";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  type SupervisorClaimOutcome,
  claimRuntimeSessionSupervisorInTransaction,
  getRuntimeSessionBindingById,
  getRuntimeSessionBindingByOwnership,
  markRuntimeSessionLostInTransaction,
  releaseRuntimeSessionSupervisorInTransaction,
} from "@/lib/runtime/persistence/runtime-session-store";
import type { RuntimeHttpClient, RuntimeStartTransportRequest } from "@/lib/runtime/runtime-client";
import type {
  AuthorityIdentity,
  CallbackEndpoints,
  RuntimeStartResponse,
} from "@/lib/runtime/runtime-protocol";
import { decimalStringToNumber, protocolDigest } from "@/lib/runtime/runtime-protocol";
import { ingressTransientBatch } from "@/lib/runtime/transient-events";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import { newSupervisorClaimId, workerInstanceId } from "@/lib/workers/worker-instance-identity";
import type { WorkspaceExecutionResources } from "@/lib/workspace/workspace-backend";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { and, desc, eq, sql } from "drizzle-orm";

/**
 * 正式 Resume 入口（R02 §7）。
 *
 * 前置只要求"该 Attempt 属于本 Invocation 且非终态"：
 * - 用户暂停后的受控恢复 = `suspended` Attempt（**用户暂停恢复命令**的契约，由
 *   `command-dispatcher` 在调度前显式校验）；
 * - 子调用等待后的 continuation 唤醒 = 同一代际的存活 Supervisor，Attempt 仍在
 *   queued/running，"子调用 pending 不等于人工暂停"，不得因此拒绝重放原意图。
 */
export async function resumeRuntimeInvocation(input: {
  tenantId: string;
  invocation: Invocation;
  binding: ExecutionBinding;
  attempt: InvocationAttempt;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpoint: string;
  auth: RuntimeStartTransportRequest["auth"];
  callbackEndpoints: CallbackEndpoints;
  checkpointId?: string;
  workspace?: WorkspaceExecutionResources;
  environmentProvisioner?: EnvironmentProvisioner;
  anchor: string;
  anchorDigest: string;
  /**
   * A05：本次恢复的**来源操作键**，必须来自已持久事实。
   *
   * 用户恢复取 `command:<InvocationCommand.id>`（命令网关唯一入口给出）；
   * External continuation 取已持久 continuation 的原始身份（`agent-call:<id>:<version>`）。
   * 不用当前时间、不用调用序号：否则"同一次恢复的第二次投递"会被当成新恢复，
   * 于是再跑一遍环境重准备、把上一次建好的 ready/激活抹掉 —— 那正是 A05 修的问题。
   */
  sourceOperationKey: string;
}): Promise<RuntimeStartResponse> {
  const invocation = await getInvocationById(input.tenantId, input.invocation.id);
  const attempt = await getAttemptById(input.attempt.id);
  // waiting_user = 受控暂停后的正式 Resume；running = UserAction resolve 事务已先落
  // Authority 的 post-authority Resume（凭证由 command-dispatcher 校验）。
  if (
    !invocation ||
    !["waiting_user", "running"].includes(invocation.executionState) ||
    !attempt ||
    attempt.invocationId !== input.invocation.id ||
    INVOCATION_ATTEMPT_TERMINAL_STATES.includes(attempt.attemptState)
  ) {
    throw new Error("AttemptMismatch");
  }
  // A05：MANAGED 的 Resume 必须把受管实例**交还到可执行形状**，而不是"原样复验一遍"。
  //
  // 暂停（`execution.suspended`）把这些事实写成
  // `leaseState=active` + `readinessState=preparing` + `activationOwnershipId=null`；
  // 而 Resume 会生成**新的**所有权代际与**新的**恢复锚点。因此三条路都必须一起修：
  // 1. 入口不能只接纳 `prepared/ready`，否则暂停后的 `preparing` 永远进不来；
  // 2. 只做 `revalidate` 也不够：`preparing` 不是"可恢复的受管实例"，而且它原样返回的
  //    `ready` 会把**上一代际**的 Writer 激活带进 Start 事务；
  // 3. 恢复锚点证据必须按**本次**锚点重写（`activateEnvironmentLease` 会逐字比对）。
  // 三者由 `EnvironmentProvisioner.reprepare` 一次完成：清掉旧激活 → 推进恢复水位 →
  // 真实回读实例（必要时按稳定 operationId 幂等重建）→ 重写 Prepared 证据。
  let environmentLease: EnvironmentLease | null = null;
  let environmentRevision: Awaited<ReturnType<typeof getEnvironmentRevisionById>> = null;
  if (input.binding.environmentMode === "MANAGED") {
    if (!input.binding.environmentDefinitionRevisionId || !input.environmentProvisioner) {
      throw new Error("EnvironmentRevisionMismatch");
    }
    const revision = await getEnvironmentRevisionById(
      input.tenantId,
      input.binding.environmentDefinitionRevisionId,
    );
    if (!revision) throw new Error("EnvironmentRevisionMismatch");
    environmentRevision = revision;
    const current = await getEnvironmentLeaseByAttempt(input.tenantId, invocation.id, attempt.id);
    if (
      !current ||
      current.environmentDefinitionRevisionId !== revision.id ||
      current.leaseState !== "active"
    ) {
      throw new Error("EnvironmentRevisionMismatch");
    }
    environmentLease = current;
  }
  const checkpointId = input.checkpointId ?? attempt.filesystemCheckpointId ?? undefined;
  const sourceDecision = await decideRuntimeStartSource({
    tenantId: input.tenantId,
    invocationId: invocation.id,
    attemptId: attempt.id,
    intentType: "resume",
    sourceOperationKey: input.sourceOperationKey,
    runtimeRevisionId: input.binding.runtimeRevisionId,
    workspaceBindingId: input.binding.workspaceBindingId ?? null,
    environmentDefinitionRevisionId: input.binding.environmentDefinitionRevisionId ?? null,
    anchorDigest: input.anchorDigest,
    checkpointId: checkpointId ?? null,
  });
  let preparationClaimId: string | null = null;
  if (input.binding.environmentMode === "MANAGED" && sourceDecision.disposition === "new") {
    if (!environmentLease || !environmentRevision || !input.environmentProvisioner) {
      throw new Error("EnvironmentRevisionMismatch");
    }
    // A05：把"这次恢复是哪一个意图"变成持久事实，再动环境。
    //
    // 来源意图取**已持久命令身份**，不取当前时间或调用序号：
    // 只有稳定，ACK/started 丢失后的第二次投递才会被认出来是"同一意图重投"，
    // 从而沿用已建好的 ready/激活，而不是重做准备把它们抹掉。
    // 同一 Attempt 可以发生多轮合法暂停/恢复，因此不能退化成 `Invocation + Attempt`：
    // 那会把第二轮不同命令误判为第一轮同意图的摘要冲突。
    // 语义摘要覆盖锚点/检查点/Revision/Binding —— 同来源换其中任何一项都必须被拒。
    const preparationIntentKey = input.sourceOperationKey;
    const preparationRequestDigest = protocolDigest({
      scope: "environment-reprepare",
      tenantId: input.tenantId,
      invocationId: invocation.id,
      attemptId: attempt.id,
      runtimeRevisionId: input.binding.runtimeRevisionId,
      workspaceBindingId: input.binding.workspaceBindingId,
      environmentDefinitionRevisionId: environmentRevision.id,
      anchorDigest: input.anchorDigest ?? null,
      checkpointId: checkpointId ?? null,
    });
    preparationClaimId = newSupervisorClaimId();
    environmentLease = await input.environmentProvisioner.reprepare({
      tenantId: input.tenantId,
      lease: environmentLease,
      revisionId: environmentRevision.id,
      revision: environmentRevision,
      workspaceBindingId: input.binding.workspaceBindingId,
      workspaceRoot: input.workspace?.root ?? null,
      recoveryAnchorDigest: input.anchorDigest ?? null,
      preparationIntentKey,
      preparationRequestDigest,
      preparationClaimId,
    });
    if (
      !isPreparedReadinessState(environmentLease.readinessState) ||
      environmentLease.leaseState !== "active"
    ) {
      throw new Error("EnvironmentComplianceFailed");
    }
  }
  const started = await startRuntimeInvocation({
    tenantId: input.tenantId,
    invocation,
    binding: input.binding,
    attempt,
    runtimeClient: input.runtimeClient,
    runtimeEndpoint: input.runtimeEndpoint,
    auth: input.auth,
    callbackEndpoints: input.callbackEndpoints,
    environmentLeaseId: environmentLease?.id ?? null,
    environmentProvisioner: input.environmentProvisioner ?? null,
    workspace: input.workspace,
    intentType: "resume",
    sourceOperationKey: input.sourceOperationKey,
    ...(preparationClaimId
      ? {
          preparationClaim: {
            tenantId: input.tenantId,
            invocationId: invocation.id,
            attemptId: attempt.id,
            intentKey: input.sourceOperationKey,
            requestDigest: protocolDigest({
              scope: "environment-reprepare",
              tenantId: input.tenantId,
              invocationId: invocation.id,
              attemptId: attempt.id,
              runtimeRevisionId: input.binding.runtimeRevisionId,
              workspaceBindingId: input.binding.workspaceBindingId,
              environmentDefinitionRevisionId: environmentRevision?.id ?? null,
              anchorDigest: input.anchorDigest ?? null,
              checkpointId: checkpointId ?? null,
            }),
            claimId: preparationClaimId,
          },
        }
      : {}),
    recovery: {
      kind: "resume",
      anchor: input.anchor,
      anchorDigest: input.anchorDigest,
      ...(checkpointId ? { checkpointId } : {}),
    },
  });
  return started.response;
}

export type HarnessResumeSourceType =
  | "hosted_start"
  | "user_action"
  | "user_pause"
  | "agent_call"
  | "tool_call";

interface HostedOverrides {
  decisionPort?: HarnessDecisionPort;
  finalResponsePort?: HarnessFinalResponsePort;
  actionExecutors?: HarnessActionExecutors;
  transientEventBatchSink?: TransientEventBatchSink;
  modelRef?: string;
  /**
   * A03：Supervisor 等待与排他领取的可注入参数。
   *
   * 生产使用默认值；测试用它把等待窗口压到毫秒级，从而真实地观察
   * 「pending 持续持有」「跨进程排他领取」「唤醒后继续」三条路径。
   */
  supervisor?: {
    leaseMs?: number;
    renewIntervalMs?: number;
    pendingPollIntervalMs?: number;
    pendingWaitLimitMs?: number;
    loopWindowMs?: number;
    /**
     * 执行者实例身份。**缺省值是本进程启动生成的 UUID**（`workerInstanceId()`），
     * 不是 PID：PID 在不同容器里可以相同，用它当身份正是 A03 要修的缺陷。
     * 这里只允许"覆盖成一个仍然稳定的实例身份"，不允许注入可复用的领取 nonce。
     */
    instanceId?: string;
  };
}

const hostedOverrides = new Map<string, HostedOverrides>();

/**
 * R02 §2：每个 Ownership generation 在**本进程内**的活跃 Supervisor 索引。
 *
 * 它只索引「已由持久状态授权」的活任务：键是 Ownership id，进入前会先按权威 tuple 复核
 * 该代际仍是当前 active Owner（`loadAuthorityFromTuple`）。去重的持久来源始终是
 * `RuntimeSessionBinding.bindingState` + Ownership 事实，这张表只避免同代际起第二个 Loop。
 */
type LiveRunner = {
  controller: AbortController;
  promise: Promise<HostedHarnessLoopResult> | null;
  /** A03：等待中的唤醒回调。pending 期间 Supervisor 不退场，靠它被立即叫醒。 */
  waiters: Set<() => void>;
  wake(): void;
};
const liveRunners = new Map<string, LiveRunner>();

/**
 * R02 §2：按 Start/Resume **携带的准确 authority** 复核当前状态。
 *
 * 不允许「收到旧 Start 后按 invocationId 重新加载当前 Owner 再运行」：
 * 请求里的 (attemptId, ownershipId, leaseEpoch, sessionBindingId, runtimeRevisionId)
 * 必须逐项匹配当前 Owner 与该 Ownership 的唯一 Session，否则 fail closed。
 */
async function loadAuthorityFromTuple(tenantId: string, authority: AuthorityIdentity) {
  const owner = await getActiveExecutionOwnership({
    tenantId,
    invocationId: authority.invocationId,
  });
  if (
    !owner ||
    owner.id !== authority.ownershipId ||
    owner.attemptId !== authority.attemptId ||
    owner.leaseEpoch !== decimalStringToNumber(authority.leaseEpoch)
  ) {
    throw new Error("NotCurrentExecutor");
  }
  const session = await getRuntimeSessionBindingById(tenantId, authority.sessionBindingId);
  if (
    !session ||
    session.invocationId !== authority.invocationId ||
    session.ownershipId !== owner.id ||
    session.attemptId !== authority.attemptId ||
    session.leaseEpoch !== decimalStringToNumber(authority.leaseEpoch) ||
    session.runtimeRevisionId !== authority.runtimeRevisionId
  ) {
    throw new Error("RuntimeSessionMismatch");
  }
  return { owner, session, authority };
}

/**
 * R06 §1：装载 Hosted 执行主体（Thread / Job 判别联合）。
 *
 * - Thread 主体：执行目标仍是本 Turn 的 trigger item（既有行为不变）。
 * - Job 主体：执行目标来自 Job 的**正式输入事实**，并在每次实际读取时复验 inputHash；
 *   不创建 Thread/Turn/triggerItem，也不为 Agent 伪造一个主体。
 *
 * 判别不合法（有 subjectType=job 但没有 jobId、Thread 主体缺 threadId/turnId）时
 * fail-closed，绝不退回"当作 pending"。
 */
async function loadHostedExecutionSubject(input: {
  tenantId: string;
  invocation: Invocation;
}): Promise<
  | { kind: "thread"; threadId: string; turnId: string }
  | { kind: "job"; jobId: string; objective: string }
> {
  const { invocation } = input;
  if (invocation.subjectType === "job") {
    const jobId = invocation.jobId;
    if (!jobId) throw new Error("ExecutionSubjectMismatch");
    const [job] = await db
      .select()
      .from(jobTable)
      .where(and(eq(jobTable.tenantId, input.tenantId), eq(jobTable.id, jobId)))
      .limit(1);
    if (!job) throw new Error("Job 不存在或跨租户不可见");
    // Job 的业务态由 JobCommand 消费者推进，因此执行时它可能仍是 queued（不正常之处
    // 不是"没在 running"，而是**业务终态已经落定还要再跑一次**）。
    if (JOB_TERMINAL_STATES.includes(job.jobState)) {
      throw new Error("JobStateMismatch");
    }
    // R06 §6：ContextHandle 只是访问契约，不保证输入内容永远不变。每次实际读取都必须
    // 复验摘要，且必须与 Invocation 冻结的执行目标摘要一致。复验谓词与 `createJob` 重复接纳
    // 共用同一实现（`assertJobInputDigestMatches`），因此 MySQL JSON 列回读重排键序不会
    // 把合法输入误判成篡改（A10）。
    assertJobInputDigestMatches({ job, invocationInputDigest: invocation.inputDigest });
    return { kind: "job", jobId, objective: jobObjective(job) };
  }
  const threadId = invocation.threadId;
  const turnId = invocation.turnId;
  if (!threadId || !turnId) throw new Error("ExecutionSubjectMismatch");
  return { kind: "thread", threadId, turnId };
}

/**
 * 由 Job 的正式输入事实推导执行目标。
 *
 * 输入是业务数据，不是平台 prompt：这里只做"取出可读目标"的稳定投影，
 * 不发明字段、不注入平台指令。
 */
function jobObjective(job: {
  inputKind: string;
  inputJson: unknown;
  inputRef: string | null;
  id: string;
}): string {
  if (job.inputKind !== "inline") {
    // 受管 inputRef 的内容读取路径尚未落地（无受管输入解析器）：
    // 不能拿引用字符串冒充"已读取的输入"，显式拒绝而不是伪造执行目标。
    throw new Error("JobInputReferenceUnsupported");
  }
  const json = job.inputJson;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const task = (json as Record<string, unknown>).task;
    if (typeof task === "string" && task.length > 0) return task;
  }
  return typeof json === "string" ? json : JSON.stringify(json ?? null);
}

/**
 * A03 · Supervisor 等待参数。
 *
 * pending（子调用仍在持久执行）**不等于**人工暂停：契约（02-runtime-lifecycle §7）要求
 * 「Hosted Supervisor 可以等待持久子结果并持续有效任务 Heartbeat；Continuation 只唤醒该
 * Supervisor，不再次 Start 同 generation」。旧实现在 Loop 返回 pending 的瞬间就清掉 Heartbeat
 * 并摘除槽位——数据库里 Owner 仍是 active，进程内却已经没有任何执行者：子调用一旦超过剩余
 * Lease，Owner 过期，recovery lane 把 Invocation 收为 lost，之后的 continuation 再也无法继续它。
 *
 * 现在的模型是「持续持有 + 等待唤醒」：
 * - 等待期间 Heartbeat 不停（续租 Ownership 与 Session 工作身份），Owner 不会因等待而过期；
 * - 唤醒来源有两个且都跨进程有效：本进程的显式唤醒（重复 Start/Resume/Continuation），
 *   以及周期性重跑 Loop（每次重跑都经 `recoveryPort` 重新读回子调用终态，因此不会重复决策）；
 * - 等待有上限（`pendingWaitLimitMs`），超时即退出并把代际交给正式恢复流程，
 *   绝不停留在「进程内没人跑、数据库却声称健康执行」的状态。
 */
const SUPERVISOR_DEFAULT_LEASE_MS = 60_000;
const SUPERVISOR_DEFAULT_RENEW_INTERVAL_MS = 20_000;
const SUPERVISOR_DEFAULT_PENDING_POLL_MS = 2_000;
const SUPERVISOR_DEFAULT_WAIT_LIMIT_MS = 600_000;
const SUPERVISOR_DEFAULT_LOOP_WINDOW_MS = 600_000;

interface SupervisorSettings {
  leaseMs: number;
  renewIntervalMs: number;
  pendingPollIntervalMs: number;
  pendingWaitLimitMs: number;
  loopWindowMs: number;
  instanceId: string;
}

function supervisorSettings(overrides: HostedOverrides | undefined): SupervisorSettings {
  const o = overrides?.supervisor;
  // A03-01：缺省实例身份 = **进程启动 UUID**。PID/hostname/时间戳都不是身份：
  // 不同容器可以持有同一 PID，同机重启也会复用 PID。实例 id 只用于诊断归属，
  // 真正决定"是哪一次领取"的是每次领取另生的 claimId（见 `claimSupervisorLease`）。
  const instanceId = o?.instanceId ?? workerInstanceId();
  return {
    leaseMs: o?.leaseMs ?? SUPERVISOR_DEFAULT_LEASE_MS,
    renewIntervalMs: o?.renewIntervalMs ?? SUPERVISOR_DEFAULT_RENEW_INTERVAL_MS,
    pendingPollIntervalMs: o?.pendingPollIntervalMs ?? SUPERVISOR_DEFAULT_PENDING_POLL_MS,
    pendingWaitLimitMs: o?.pendingWaitLimitMs ?? SUPERVISOR_DEFAULT_WAIT_LIMIT_MS,
    loopWindowMs: o?.loopWindowMs ?? SUPERVISOR_DEFAULT_LOOP_WINDOW_MS,
    instanceId,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type WakeReason = "wake" | "poll" | "aborted";

/**
 * 等待唤醒，或按轮询间隔自动醒来重跑一次 Loop。
 *
 * 轮询不是可选的：跨进程的 Continuation 无法调用本进程的 `wake()`，
 * 它只能（在排他领取失败后）什么都不做。因此本进程必须自己去读回子结果。
 */
function waitForWakeOrPoll(
  slot: LiveRunner,
  pollIntervalMs: number,
  abortSignal: AbortSignal,
): Promise<WakeReason> {
  if (abortSignal.aborted) return Promise.resolve("aborted");
  return new Promise<WakeReason>((resolve) => {
    let settled = false;
    const wakeHandler = () => finish("wake");
    const finish = (reason: WakeReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", onAbort);
      slot.waiters.delete(wakeHandler);
      resolve(reason);
    };
    const onAbort = () => finish("aborted");
    const timer = setTimeout(() => finish("poll"), pollIntervalMs);
    slot.waiters.add(wakeHandler);
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 单次领取尝试（A03）。不做等待重试：领取失败意味着**本代际已经分配过实际推进者**
 * （`held`）或它的 claim 已退休（`retired`）。两种情况下本进程再等也不会成为执行者，
 * 只会白白占用一次请求。
 *
 * 注意与旧语义的区别：**过期不再等于可以领取**。按 A03 选定语义，一个 Ownership 代际
 * 最多分配一次实际 claim；持有者崩溃后由正式恢复器建立**新的** Ownership 代际，
 * 不在原代际上换执行者。这正是"旧进程迟到结果会被统一围栏拒绝"的前提。
 *
 * 期限用**数据库时间**计算：初始 claim 只租到本代际的 Supervisor 窗口
 * （`settings.leaseMs`），之后的延长一律走联合续租。这里**不**施加"绝对执行期限"上限 ——
 * 物理模型没有该事实，理由见 `HostedLeaseRenewalInput.absoluteDeadlineAt`。
 */
async function claimSupervisorLease(input: {
  tenantId: string;
  sessionBindingId: string;
  claimId: string;
  instanceId: string;
  settings: SupervisorSettings;
  absoluteDeadlineAt: Date | null;
}): Promise<SupervisorClaimOutcome> {
  return db.transaction(async (tx) => {
    const now = await getAuthorityDatabaseTime(tx);
    const requested = new Date(now.getTime() + input.settings.leaseMs);
    return claimRuntimeSessionSupervisorInTransaction(tx, {
      tenantId: input.tenantId,
      id: input.sessionBindingId,
      claimId: input.claimId,
      instanceId: input.instanceId,
      leaseExpiresAt:
        input.absoluteDeadlineAt !== null &&
        input.absoluteDeadlineAt.getTime() < requested.getTime()
          ? input.absoluteDeadlineAt
          : requested,
      now,
    });
  });
}

/**
 * Supervisor 退出时的**交接事务**（A03-04 / A03-05）。
 *
 * 顺序（一条收口边界，不是三段各自为政的写入；锁序仍是 `I → O → S`）：
 * 1. 退休本代际的 claim —— 只写墓碑，保留历史 claimId：该代际此后不可能再被领取；
 * 2. 释放本 Owner（`released`），把本代际 Session 收为 `lost`。
 *
 * 为什么要**同时**释放 Owner：只退休 claim 而留着 active Owner，会让下一个推进者
 * 既不能成为执行者（claim 不可复活），又不能通过正式恢复取得新代际（旧 Owner 仍然健康）
 * ——那正是"无人推进、数据库却声称健康执行"。
 *
 * 为什么**不**把 Invocation 收为终态：未完成的持久子动作仍在执行，它的结果是正式的
 * 持久义务（continuation 事件）。Invocation 保持非终态，下一个推进者经正式 Start /
 * Redispatch 取得**新代际**（新 Ownership / epoch / Session）继续一次；旧代际迟到的
 * 结果与动作由既有 Ownership fencing 统一拒绝。
 *
 * 幂等：代际已被终态收口（正常完成 / 暂停 / 取消）时两个关闭函数都原样返回。
 */
export async function handOffSupervisorGeneration(input: {
  tenantId: string;
  invocationId: string;
  ownershipId: string;
  attemptId: string;
  leaseEpoch: number;
  sessionBindingId: string;
  claimId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const invocation = await lockInvocationRootIfExists(tx, input.tenantId, input.invocationId);
    if (!invocation) return;
    const now = await getAuthorityDatabaseTime(tx);
    // 固定锁图 I → A → O → S：交接会结束本执行代际，因此先把旧 Attempt 据实收口。
    const [attempt] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, input.tenantId),
          eq(invocationAttemptTable.id, input.attemptId),
          eq(invocationAttemptTable.invocationId, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    const closedOwner = await closeExecutionOwnershipInTransaction(tx, {
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      ownershipId: input.ownershipId,
      attemptId: input.attemptId,
      leaseEpoch: input.leaseEpoch,
      state: "released",
      reasonCode: "supervisor_handoff",
    });
    // 正常完成/暂停可能已先收口 Owner 与 Attempt；这种情况下 close 是幂等回读，不能把
    // suspended/completed Attempt 改写成 lost。只有本事务确实留下 handoff 墓碑才结束旧代际。
    if (
      closedOwner.reasonCode === "supervisor_handoff" &&
      attempt &&
      !INVOCATION_ATTEMPT_TERMINAL_STATES.includes(attempt.attemptState)
    ) {
      await tx
        .update(invocationAttemptTable)
        .set({
          attemptState: "lost",
          finishedAt: now,
          errorCode: "supervisor_handoff",
          errorSummary: "Hosted Supervisor reached its durable handoff boundary",
          updatedAt: now,
          versionNo: attempt.versionNo + 1,
        })
        .where(eq(invocationAttemptTable.id, attempt.id));
      // 主动交接与正常用户暂停不同：旧 Attempt 已永久结束，其受管实例必须在同一事务
      // 登记退役义务。物理释放仍由现有 cleanup Worker 领取并确认，不能在这里假 released。
      await registerEnvironmentLeaseCleanupForAttemptInTransaction(tx, {
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        attemptId: input.attemptId,
        errorCode: "supervisor_handoff",
        now,
      });
    }
    await markRuntimeSessionLostInTransaction(tx, {
      tenantId: input.tenantId,
      id: input.sessionBindingId,
    });
    await releaseRuntimeSessionSupervisorInTransaction(tx, {
      tenantId: input.tenantId,
      id: input.sessionBindingId,
      claimId: input.claimId,
      now,
    });
  });
}

async function runHostedInvocation(input: {
  tenantId: string;
  invocation: Invocation;
  binding: ExecutionBinding;
  /** R02 §2：Hosted 启动必须携带 Start/Resume 的准确 authority 与 Session 启动身份。 */
  authority: AuthorityIdentity;
  overrides?: HostedOverrides;
}): Promise<HostedHarnessLoopResult> {
  const current = await loadAuthorityFromTuple(input.tenantId, input.authority);
  const runnerKey = current.owner.id;
  const settings = supervisorSettings(input.overrides);
  // A03：本次**实际领取**的 nonce。实例 id 只回答"是哪个进程"，claimId 才回答
  // "是哪一次领取"；后者决定该代际已经分配给了谁，且一经写入不可清零。
  const claimId = newSupervisorClaimId();
  // A03-T08：本次 Loop 的有界窗口在**进入前冻结一次**。旧实现每次重入 Loop 都
  // `Date.now() + 窗口`，于是"重新进入 Loop"会把同一次执行的期限无限右移 —— 那不是等待
  // 有界，而是永不结束。它只决定 Loop 何时退出（循环判据与交给 Loop 的 deadline），
  // **不再**充当租约上限：拿它夹住续租会让心跳每轮算出同一个截止时间。
  const loopDeadlineAt = new Date(Date.now() + settings.loopWindowMs);
  const renewalAuthority = {
    invocationId: input.authority.invocationId,
    attemptId: input.authority.attemptId,
    ownershipId: input.authority.ownershipId,
    leaseEpoch: current.owner.leaseEpoch,
    sessionBindingId: current.session.id,
    runtimeRevisionId: input.authority.runtimeRevisionId,
  };

  // R02 §2：相同 generation 最多一个 Supervisor 运行用户任务。重复交付的 Start（丢 ACK
  // 重发）或重复唤醒不得再起第二个 Loop —— 直接唤醒在跑的那个并回答"该代际仍在跑"。
  const existing = liveRunners.get(runnerKey);
  if (existing) {
    existing.wake();
    return { completed: false, pending: true, responseText: "", sentEvents: [] };
  }
  // 同步占位：检查与写入之间不能有 await，否则并发交付会各自越过检查各起一个 Loop。
  const slot: LiveRunner = {
    controller: new AbortController(),
    promise: null,
    waiters: new Set(),
    wake() {
      for (const waiter of [...this.waiters]) waiter();
    },
  };
  liveRunners.set(runnerKey, slot);

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let claimed = false;
  try {
    // A03：Heartbeat 必须先于领取启动。领取可能要等一个仍在派发 lane 手上的租约，
    // 若这段时间不续租 Ownership，等待本身就会把 Owner 拖到过期。
    heartbeat = setInterval(() => {
      void (async () => {
        try {
          if (!claimed) {
            // 尚未取得 claim：这仍是"派发阶段"的合法续租（契约允许首次 dispatch 未有
            // Supervisor 时按既有规则续）。此时不能走联合续租——claim 还不存在，
            // 联合续租会按"claim 已被别人拿走"拒绝，从而误杀正在等待领取的本进程。
            await renewExecutionOwnership({
              tenantId: input.tenantId,
              invocationId: input.invocation.id,
              ownershipId: current.owner.id,
              attemptId: current.owner.attemptId,
              leaseEpoch: current.owner.leaseEpoch,
            });
            return;
          }
          // A03-03：一旦取得 claim，Owner 与 claim **只能**在同一条事务里一起续。
          // 任何"先续 Owner、再看 claim"的顺序都会留下 Owner 被续活而 claim 已失效的窗口。
          //
          // TTL 用 **Owner 租约自己的契约长度**（`OWNERSHIP_LEASE_MS`），不是本次运行时会话的
          // `settings.leaseMs`：契约要求两项写"同一个截止时间"（`contracts/shared-contracts.md`
          // §3），而 Owner 行是由平台执行权契约（同一常量）建立的。若拿较短的会话 TTL 当基准，
          // 首次续租会把 Owner 租约从 90s **缩短**到 60s —— 续租只应延长，不能倒退
          // （`runtime-control-recovery` 的 CONTROL-04 正是守这一条）。
          const renewal = await renewHostedExecutionLease({
            tenantId: input.tenantId,
            authority: renewalAuthority,
            claimId,
            instanceId: settings.instanceId,
            leaseTtlMs: OWNERSHIP_LEASE_MS,
            absoluteDeadlineAt: null,
          });
          // 续租失败 = 本代际已被接管 / claim 已退休 / 租约已过期 / 绝对期限已到：
          // 立刻停止推进，绝不与新执行者并发。
          if (!renewal.renewed)
            slot.controller.abort(new Error(`SupervisorClaimLost:${renewal.reason}`));
        } catch {
          slot.controller.abort(new Error("OwnershipExpired"));
        }
      })();
    }, settings.renewIntervalMs);

    // A03：跨进程排他。进程内 `liveRunners` 在别的进程里是空的，Session=active 也不是排他
    // 领取（它反而允许继续进入执行）。这里以 Session 级工作身份做行锁 CAS：拿不到就说明
    // 该代际正由别的执行者推进，本次请求不再产生第二个决策循环。
    const claimOutcome = await claimSupervisorLease({
      tenantId: input.tenantId,
      sessionBindingId: current.session.id,
      claimId,
      instanceId: settings.instanceId,
      settings,
      absoluteDeadlineAt: null,
    });
    claimed = claimOutcome.claimed;
    if (!claimed) {
      // 该代际已由别的执行者（可能是另一个进程）持有执行权：只回答"仍在执行"，
      // 不写任何事件、不建第二个决策循环，也不把它当成一次失败启动。
      return { completed: false, pending: true, responseText: "", sentEvents: [] };
    }

    if (current.session.bindingState === "dispatching") {
      if (!current.session.semanticRequestDigest) throw new Error("RuntimeSessionMismatch");
      // R02 §3：capability 摘要的唯一比对源是发布证据（Session 冻结了 RuntimeRevision
      // 引用与其能力 JSON，故摘要恒可重算）。**不再**回落到零摘要。
      const capabilitiesDigest = expectedCapabilityManifestDigest({
        runtimeRevisionId: current.session.runtimeRevisionId,
        runtimeCapabilitiesJson: current.session.runtimeCapabilitiesJson,
      });
      await ingressRuntimeEvents({
        tenantId: input.tenantId,
        invocationId: input.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: current.authority,
          events: [
            {
              eventId: randomUUID(),
              producerSequence: String(input.invocation.lastProducerSequence + 1),
              type: "execution.started",
              schemaVersion: 1,
              payload: {
                intentKey: current.session.startIntentKey,
                semanticRequestDigest: current.session.semanticRequestDigest,
                remoteSessionRef:
                  current.session.remoteSessionRef ?? `hosted-session:${current.session.id}`,
                remoteExecutionRef:
                  current.session.remoteExecutionRef ??
                  `hosted-execution:${input.invocation.id}:${current.owner.id}`,
                capabilitiesDigest,
              },
            },
          ],
        },
      });
    } else if (current.session.bindingState !== "active") {
      throw new Error("RuntimeSessionMismatch");
    }

    // R06 §1：执行主体是判别联合。旧实现用「没有 threadId/turnId ⇒ pending」表达
    // "这不是 Thread 任务"，其实际效果是**无 Thread 的 Job 永远不执行**（既不完成也不
    // 失败），并且绕过了 Job 的真实输入校验。这里改为按主体分别装载执行输入。
    const subject = await loadHostedExecutionSubject({
      tenantId: input.tenantId,
      invocation: input.invocation,
    });
    // Thread 分支要求 Turn 与 trigger item 真实存在；Job 分支不创建也不读取
    // Thread/Turn/triggerItem（R06 §1 禁止为通用 Job 执行补一个假 Thread）。
    const turn =
      subject.kind === "thread" ? await getTurnById(input.tenantId, subject.turnId) : null;
    if (subject.kind === "thread" && !turn) throw new Error("Turn 不存在");
    const trigger =
      subject.kind === "thread" && input.invocation.triggerItemId
        ? await getItemById(input.tenantId, input.invocation.triggerItemId)
        : null;
    const workspaceBinding = await getWorkspaceBindingById(
      input.tenantId,
      input.binding.workspaceBindingId,
    );
    if (!workspaceBinding) throw new Error("WorkspaceBinding 不存在");
    // R01 §5：Hosted 的默认 Action Executors **与模型可见的能力目录**必须由同一份
    // Binding 冻结目录装配。只装配执行器而不传目录会让模型视图 `capabilityCatalog: null`
    // ——执行器具备能力但模型看不到任何工具，要求 Tool/Agent 的任务会退化成纯文本直答。
    const resources = await resolveExecutionResources({
      tenantId: input.tenantId,
      binding: input.binding,
      purpose: "resume",
    });
    const actionExecutors = input.overrides?.actionExecutors ?? resources.actionExecutors;
    const workspace =
      workspaceBinding.continuityMode === "NO_PLATFORM_WORKSPACE"
        ? { mode: "NONE" as const }
        : {
            mode: "BOUND" as const,
            bindingId: workspaceBinding.id,
            contractDigest: workspaceBinding.contractDigest,
            continuityMode: workspaceBinding.continuityMode,
            activationEvidenceRef: `ownership:${current.owner.id}`,
          };
    const tokenFacts = {
      contractVersion: 3 as const,
      type: "execution" as const,
      tenantId: input.tenantId,
      ...current.authority,
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    };
    const runtimeToken = issueWorkloadToken({ ...tokenFacts, audience: "runtime" });
    const controller = slot.controller;
    const buildLoop = () =>
      new HostedHarnessLoop({
        invocationId: input.invocation.id,
        authority: current.authority,
        tenantId: input.tenantId,
        // R06 §1：主体字段按判别联合给出，Job 不再借用空的 threadId/turnId。
        threadId: subject.kind === "thread" ? subject.threadId : null,
        turnId: subject.kind === "thread" ? subject.turnId : null,
        jobId: subject.kind === "job" ? subject.jobId : null,
        inputItems: trigger ? [{ type: "user_message", content: trigger.contentJson }] : [],
        // Job 的执行目标来自 Job 的正式输入事实（已复验 inputHash），
        // 不从"空 inputItems"推导，也不伪造一个 user_message。
        ...(subject.kind === "job" ? { objective: subject.objective } : {}),
        gatewayEndpoints: buildGatewayEndpoints({
          external: false,
          invocationId: input.invocation.id,
        }),
        runtimeEndpoint: "in-process://hosted",
        authToken: runtimeToken,
        workspace,
        executionLimits: {
          maxEventBytes: 262_144,
          maxBatchEvents: 100,
          maxBatchBytes: 1_048_576,
          dispatchDeadlineMs: 120_000,
          executionTimeoutMs: settings.loopWindowMs,
        },
        traceContext: { traceId: input.invocation.id, spanId: input.invocation.id },
        decisionPort:
          input.overrides?.decisionPort ??
          configuredDecisionPort(input.binding.modelId ?? aiConfig.chatModel),
        finalResponsePort:
          input.overrides?.finalResponsePort ??
          configuredFinalResponsePort(input.binding.modelId ?? aiConfig.chatModel),
        actionExecutors,
        // R01 §5：能力目录是 Binding 冻结事实，运行期只投影给模型视图（不得由调用方另拼）。
        capabilityCatalog: resources.capabilityCatalog,
        recoveryPort: createMySqlHarnessLoopRecoveryPort(input.tenantId),
        ingressClient: {
          postEventBatch: async (invocationId, authority, events) => {
            await ingressRuntimeEvents({
              tenantId: input.tenantId,
              invocationId,
              batch: { protocolVersion: 3, authority, events },
            });
          },
        },
        transientEventBatchSink:
          input.overrides?.transientEventBatchSink ??
          (async ({ invocationId, transientSequenceStart, events }) => {
            // 默认 transient 通道：response.delta 等不持久化事件经正式 ingress 投影到
            // Thread transient 总线（SSE 订阅者），绝不黑洞。
            // A11：必须携带本代际的准确 authority —— transient 通道同样要按执行代际隔离。
            // 否则被接管后旧执行者迟到的 delta 会混进新代际的流式展示。
            await ingressTransientBatch({
              tenantId: input.tenantId,
              invocationId,
              authority: input.authority,
              transientSequenceStart,
              events,
            });
          }),
        modelRef: input.overrides?.modelRef ?? input.binding.modelId,
        abortSignal: controller.signal,
        // A03-T08：每次重入 Loop 都传**同一个**冻结期限，不重新计算。
        deadlineAt: loopDeadlineAt,
      });

    // A03：pending 不结束 Supervisor。每次"新一轮"都新建 Loop 实例，让它带着**新的**
    // 执行窗口从持久事实（`recoveryPort`）重新装载：未完成动作仍会先被重试，只有它真的
    // 进入终态才会继续决策，因此轮询不会重复调用模型、也不会重复写 started。
    const waitStartedAt = Date.now();
    for (;;) {
      const loop = buildLoop();
      const running = loop.run();
      slot.promise = running;
      const result = await running;
      if (!result.pending) return result;
      if (controller.signal.aborted) return result;
      if (Date.now() - waitStartedAt >= settings.pendingWaitLimitMs) {
        // 等待有界：超时后退出并按下面的交接事务把代际交还正式流程（claim 退休 +
        // Owner 释放 + Session 收口），绝不留下"没人跑却声称健康"的窗口。
        return result;
      }
      if (Date.now() >= loopDeadlineAt.getTime()) {
        // A03-T08：冻结的绝对期限已到就不再重入 Loop。期满正式收口，不继续写合法结果；
        // 交接事务会把本代际的 claim 一起退休掉。
        return result;
      }
      const reason = await waitForWakeOrPoll(
        slot,
        settings.pendingPollIntervalMs,
        controller.signal,
      );
      if (reason === "aborted") return result;
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    const heldClaim = claimed;
    // 先落标志再做事：心跳回调在 finally 期间不得再按"已持有 claim"去续租。
    claimed = false;
    if (heldClaim) {
      // A03：退出即交接，不再"释放 claim 让下一个进程在原代际接着跑"。
      await handOffSupervisorGeneration({
        tenantId: input.tenantId,
        invocationId: input.invocation.id,
        ownershipId: current.owner.id,
        attemptId: current.owner.attemptId,
        leaseEpoch: current.owner.leaseEpoch,
        sessionBindingId: current.session.id,
        claimId,
      }).catch(() => undefined);
    }
    slot.wake();
    // 只清理自己占的槽位：代际被替换后新 Supervisor 已占位时不得误删。
    if (liveRunners.get(runnerKey) === slot) liveRunners.delete(runnerKey);
  }
}

/**
 * R02 §2：Hosted 分支的 authority 是**必需**输入。缺失或与 Invocation/Binding 不符即 fail closed。
 */
function requireHostedAuthority(
  authority: AuthorityIdentity | undefined,
  invocationId: string,
  runtimeRevisionId: string,
): AuthorityIdentity {
  if (!authority) throw new Error("RuntimeSessionMismatch");
  if (
    authority.invocationId !== invocationId ||
    authority.runtimeRevisionId !== runtimeRevisionId
  ) {
    throw new Error("RuntimeSessionMismatch");
  }
  return authority;
}

export async function resumeHarnessInvocation(input: {
  tenantId: string;
  invocationId: string;
  sourceType?: HarnessResumeSourceType;
  agentCallId: string;
  sourceVersion: number;
  /**
   * R02 §2：Hosted 分支必须由调用方（Hosted Adapter）给出 Start/Resume 携带的准确
   * authority 与 Session 启动身份，运行期只复核该代际，不按 invocationId 跟随 current。
   */
  authority?: AuthorityIdentity;
}): Promise<HostedRuntimeResumeResult> {
  const invocation = await getInvocationById(input.tenantId, input.invocationId);
  if (!invocation) throw new Error("Invocation 不存在");
  if (INVOCATION_TERMINAL_STATES.includes(invocation.executionState))
    return { status: "handled_noop", invocationId: invocation.id };
  const binding = await getExecutionBindingByInvocation(input.tenantId, invocation.id);
  if (!binding) throw new Error("ExecutionBinding 不存在");
  const revision = await getRuntimeRevisionById(binding.runtimeRevisionId);
  if (!revision) throw new Error(`RuntimeRevision 不存在: ${binding.runtimeRevisionId}`);
  // External Runtime 的 Parent resume 同样必须经正式 Start 服务（`runtime-resume`）进入，
  // 由 Session 冻结稳定启动意图；in-process Hosted Loop 只服务 hosted_artifact Binding。
  if (revision.runtimeEvidenceKind === "external_endpoint") {
    const attempt = await getLatestAttempt(invocation.id);
    if (!attempt || INVOCATION_ATTEMPT_TERMINAL_STATES.includes(attempt.attemptState)) {
      throw new Error("AttemptMismatch");
    }
    const endpoint = revision.endpointRef;
    const auth = await resolveOutboundRuntimeAuth({
      tenantId: input.tenantId,
      identityMode: revision.identityMode,
      credentialRefId: revision.credentialRefId,
    });
    const anchor = attempt.filesystemCheckpointId
      ? `checkpoint:${attempt.filesystemCheckpointId}`
      : `invocation:${invocation.id}:recovery:${invocation.recoveryVersion}`;
    // A05：External continuation 与请求内联调度必须携带**同一份**受管执行资源。
    // 只换 Runtime Transport 而不给 Workspace 执行资源与 Environment Provisioner，
    // 会让 MANAGED 的 continuation 在默认路径上直接终态失败 —— 缺陷与命令网关同源。
    const resources = await resolveExecutionResources({
      tenantId: input.tenantId,
      binding,
      purpose: "resume",
    });
    await resumeRuntimeInvocation({
      tenantId: input.tenantId,
      invocation,
      binding,
      attempt,
      runtimeClient: createHttpHarnessRuntimeTransport({ endpoint, auth }),
      runtimeEndpoint: endpoint,
      auth,
      callbackEndpoints: buildGatewayEndpoints({
        external: true,
        invocationId: invocation.id,
      }),
      ...(resources.workspace ? { workspace: resources.workspace } : {}),
      ...(resources.environmentProvisioner
        ? { environmentProvisioner: resources.environmentProvisioner }
        : {}),
      anchor,
      anchorDigest: attempt.resumeAnchorDigest ?? protocolDigest(anchor),
      // A05：子调用续接的来源意图 = 已持久 continuation 的**原始身份**
      // （`agentCallId` + 该次结果的 `sourceVersion`），不是当前时间或本次调用序号。
      // 同一次续接因 ACK/started 丢失而重投时会拿到同一个键，从而命中原 O/S。
      sourceOperationKey: `agent-call:${input.agentCallId}:${input.sourceVersion}`,
    });
    return {
      status: "resumed",
      invocationId: invocation.id,
      runtime: "external",
      completed: false,
      pending: true,
      waitingForUser: false,
    };
  }
  const result = await runHostedInvocation({
    tenantId: input.tenantId,
    invocation,
    binding,
    // R02 §2：没有准确 authority 就不能启动 Hosted 执行——绝不回落到「按 invocationId
    // 加载当前 Owner」，那会让旧 Start 驱动新代际运行。
    authority: requireHostedAuthority(input.authority, invocation.id, binding.runtimeRevisionId),
    overrides: hostedOverrides.get(invocation.id),
  });
  return {
    status: "resumed",
    invocationId: invocation.id,
    runtime: "hosted",
    completed: result.completed,
    pending: result.pending,
    waitingForUser: result.waitingForUser,
  };
}

/**
 * R02 §2 + R03 §5：为**持久化的事实续接**重建当前执行代际的准确 Authority。
 *
 * 与 `loadAuthorityFromTuple` 的分工：Start/Resume **命令**携带调用方认定的 tuple，只做
 * 逐项复核；continuation 事件（ToolCall/AgentCall 终态）只表达"继续这个 Invocation"，
 * 不携带任何 tuple，因此必须从正式事实重建 —— 当前 active Owner + 该 Ownership 的唯一
 * Session，二者仍逐项自洽。
 *
 * 没有 active Owner（已释权 / 已被换代 / 已被收口）时 fail closed：continuation **绝不**
 * 复活一个不再持有执行权的旧代际。
 */
async function resolveCurrentExecutionAuthority(input: {
  tenantId: string;
  invocationId: string;
  runtimeRevisionId: string;
}): Promise<AuthorityIdentity> {
  const owner = await getActiveExecutionOwnership({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
  });
  if (!owner) {
    throw new ExecutionAuthorityError(
      "NotCurrentExecutor",
      `Invocation ${input.invocationId} 没有 active Owner，continuation 不得复活旧代际`,
    );
  }
  const session = await getRuntimeSessionBindingByOwnership(input.tenantId, owner.id);
  if (
    !session ||
    session.invocationId !== input.invocationId ||
    session.attemptId !== owner.attemptId ||
    session.leaseEpoch !== owner.leaseEpoch
  ) {
    throw new ExecutionAuthorityError(
      "RuntimeSessionMismatch",
      `Ownership ${owner.id} 没有自洽的唯一 Session，continuation 拒绝恢复`,
    );
  }
  return authorityIdentity({
    invocationId: input.invocationId,
    runtimeRevisionId: input.runtimeRevisionId,
    attemptId: owner.attemptId,
    ownershipId: owner.id,
    leaseEpoch: owner.leaseEpoch,
    sessionBindingId: session.id,
  });
}

/**
 * R02 §2：**持久化续接**恢复父 Invocation 的唯一正式入口。
 *
 * 与 `resumeHarnessInvocation` 的唯一差别是 authority 的来源：continuation 事件不携带
 * tuple，这里按当前代际重建（见 `resolveCurrentExecutionAuthority`）。已终态或不存在的
 * Invocation 不做任何代际推断，直接交给正式入口保持既有 `handled_noop` 语义。
 */
export async function resumeHarnessContinuation(input: {
  tenantId: string;
  invocationId: string;
  sourceType?: HarnessResumeSourceType;
  agentCallId: string;
  sourceVersion: number;
}): Promise<HostedRuntimeResumeResult> {
  const invocation = await getInvocationById(input.tenantId, input.invocationId);
  if (!invocation || INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) {
    return resumeHarnessInvocation(input);
  }
  const binding = await getExecutionBindingByInvocation(input.tenantId, invocation.id);
  if (!binding) throw new Error("ExecutionBinding 不存在");
  return resumeHarnessInvocation({
    ...input,
    authority: await resolveCurrentExecutionAuthority({
      tenantId: input.tenantId,
      invocationId: invocation.id,
      runtimeRevisionId: binding.runtimeRevisionId,
    }),
  });
}

export const hostedRuntimeApplicationService: HostedRuntimeApplicationService = {
  start: (input) =>
    resumeHarnessInvocation({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      sourceType: "hosted_start",
      agentCallId: input.idempotencyKey,
      sourceVersion: 1,
      authority: input.authority,
    }),
  resume: (input) =>
    resumeHarnessInvocation({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      sourceType: "user_action",
      agentCallId: input.idempotencyKey,
      sourceVersion: 1,
      authority: input.authority,
    }),
  async cancel(input) {
    // R03 §6 + A02：Cancel 只针对**请求携带的目标代际**关门，且「代际复核」与「终态事实写入」
    // 必须落在同一条收口边界上。
    //
    // 旧实现的顺序是：事务外比对 tuple → 事务外 abort/取消子调用 → 独立事务关旧 Owner →
    // 回读 Invocation → 再开**另一个事务**把整个 Invocation 无条件置为 cancelled。
    // 两个后果都是真实的，不是理论担忧：
    //  1) **竞态**：初检通过后发生 epoch2 接管，最后一步仍会把新代际取消；
    //  2) **状态分裂**：`transitionInvocation` 只改 Invocation 行并桥 Job，不关闭
    //     Attempt / Session / Turn，也不写 canonical Thread 终态事件。
    //     旧 Owner 已非 active 时 `closeExecutionOwnership` 直接返回，更不构成代际护栏。
    // 现在改为：单事务内「锁执行根 → 逐项复核请求 tuple → 走与 Ingress **完全相同**的
    // 终态收口（`closeInvocationTerminalInTransaction`）」。
    const target = await db.transaction(async (tx) => {
      // R04 §2：执行根先锁（Invocation → Ownership → Session），与 acquire/renew/close 同序。
      const invocation = await lockInvocationRootIfExists(tx, input.tenantId, input.invocationId);
      if (!invocation) return null;
      const [owner] = await tx
        .select()
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, input.tenantId),
            eq(executionOwnershipTable.invocationId, input.invocationId),
            eq(executionOwnershipTable.ownershipState, "active"),
          ),
        )
        .orderBy(sql`${executionOwnershipTable.leaseEpoch} DESC`)
        .for("update")
        .limit(1);
      if (
        !owner ||
        owner.id !== input.authority.ownershipId ||
        owner.attemptId !== input.authority.attemptId ||
        owner.leaseEpoch !== decimalStringToNumber(input.authority.leaseEpoch)
      ) {
        // 目标代际已失效：无副作用，且**不**重定向到当前 Owner。新代际要么已接管并
        // 自行收口，要么自己就是被取消的目标——无论如何都不该由这次旧 Cancel 决定。
        return null;
      }
      const [session] = await tx
        .select()
        .from(runtimeSessionBindingTable)
        .where(
          and(
            eq(runtimeSessionBindingTable.tenantId, input.tenantId),
            eq(runtimeSessionBindingTable.id, input.authority.sessionBindingId),
            eq(runtimeSessionBindingTable.invocationId, input.invocationId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !session ||
        session.ownershipId !== owner.id ||
        session.attemptId !== owner.attemptId ||
        session.leaseEpoch !== owner.leaseEpoch ||
        session.runtimeRevisionId !== input.authority.runtimeRevisionId
      ) {
        return null;
      }
      if (INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) {
        // 本次请求的目标代际是当前代际，但 Invocation 已经收口（例如并发断言的终态事件先到）。
        // 终态是幂等的：不再重复收口，也不产生"二次取消"。
        return null;
      }
      await closeInvocationTerminalInTransaction(tx, {
        invocation,
        attemptId: owner.attemptId,
        ownershipId: owner.id,
        sessionBindingId: session.id,
        state: "cancelled",
        now: new Date(),
        errorCode: "InvocationCancelled",
        errorSummary: input.reason ?? "cancel_requested",
        sessionVersionNo: session.versionNo,
      });
      return { ownershipId: owner.id };
    });
    if (!target) return;
    // 到这里持久事实已经收口。以下两项是**物理/远端**动作，它们的成败不再参与
    // "这次取消是否成立"的判定，也不需要与上面的写入放在同一事务里——但顺序上必须在
    // 授权复核之后：先确立权威事实，再停止本进程 Runner 与远端子调用。
    const live = liveRunners.get(target.ownershipId);
    if (live) live.controller.abort(new Error(input.reason ?? "Invocation cancelled"));
    await cancelActiveAgentCalls({
      tenantId: input.tenantId,
      parentInvocationId: input.invocationId,
    });
  },
  async steer(input) {
    // R03 §6：Steer 只对目标代际的 pending guidance 生效；代际已失效即空操作，
    // 不把旧命令的引导投递给新 Owner。
    const current = await loadAuthorityFromTuple(input.tenantId, input.authority).catch(() => null);
    if (!current) return;
    const payload =
      input.steerPayload && typeof input.steerPayload === "object"
        ? (input.steerPayload as Record<string, unknown>)
        : {};
    const guidanceItemId = payload.guidanceItemId ?? payload.inputRef;
    if (typeof guidanceItemId !== "string") throw new Error("Steer 缺少 guidanceItemId");
    await db
      .update(threadItemTable)
      .set({ itemState: "completed", updatedAt: new Date() })
      .where(
        and(
          eq(threadItemTable.id, guidanceItemId),
          eq(threadItemTable.invocationId, input.invocationId),
          eq(threadItemTable.itemType, "user_guidance"),
          eq(threadItemTable.itemState, "pending"),
        ),
      );
  },
};

export function createConfiguredHostedRuntimeApplicationService(
  overrides: HostedOverrides,
): HostedRuntimeApplicationService {
  const wrap = async <T>(invocationId: string, work: () => Promise<T>): Promise<T> => {
    hostedOverrides.set(invocationId, overrides);
    try {
      return await work();
    } finally {
      hostedOverrides.delete(invocationId);
    }
  };
  return {
    start: (input) => wrap(input.invocationId, () => hostedRuntimeApplicationService.start(input)),
    resume: (input) =>
      wrap(input.invocationId, () => hostedRuntimeApplicationService.resume(input)),
    cancel: (input) => hostedRuntimeApplicationService.cancel(input),
    steer: (input) => hostedRuntimeApplicationService.steer(input),
  };
}
