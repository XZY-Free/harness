/**
 * A05：MANAGED 的**正式暂停恢复**必须真的能走通。
 *
 * 覆盖审查报告 A05 指出的三条真实缺陷（不是"给 if 多加一个字符串"）：
 *
 * 1. **默认接线缺参**：命令网关的 `resolveTransport` 不解析 `workspace` /
 *    `environmentProvisioner`，而 `command-dispatcher` 会把这两个值传给 Resume
 *    —— 默认生产路径上它们恒为 `undefined`，MANAGED 直接在
 *    `EnvironmentRevisionMismatch` 上失败。
 * 2. **状态机自相矛盾**：暂停（`execution.suspended`）会把 EnvironmentLease 打回
 *    `leaseState=active, readinessState=preparing, activationOwnershipId=null`，
 *    而 Resume 入口只接纳 `prepared/ready`，中间没有"重新准备"的正式过程。
 * 3. **恢复锚点证据**：Resume 使用**本次**的恢复锚点（`recovery.anchorDigest`），
 *    而 Start 事务内的 `activateEnvironmentLease` 要求 Prepared 证据的
 *    `candidate.recoveryAnchorDigest` 与之逐字相等 —— 沿用旧证据必然被
 *    "恢复 Anchor 已变化，Prepared 证据失效"拒绝。
 *
 * 层：real MySQL（testcontainers）+ real docker（受管容器）+ 真实员工路由
 * + 真实命令网关 + 真实 Ingress + 真实受管 Workspace 绑定解析。
 * 唯一允许的测试替身是**最末端的模型决策/正文边界**（R01 §5 允许的替身）：
 * 不注入自定义 WorkspaceBackend、不注入自定义 EnvironmentProvisioner、
 * 不注入 `runtimeEndpointResolver`（那正是 A05 的缺陷形态）。
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { POST as resolveUserActionPOST } from "@/app/api/threads/[threadId]/user-actions/[requestId]/resolve/route";
import { createAgentActionExecutor } from "@/lib/agents/calls/application/agent-action-executor";
import {
  EXECUTION_FIXTURE_CONTRACT,
  seedAgentCallExecutionScenario,
} from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createEnvironmentDefinition,
  getEnvironmentRevisionById,
} from "@/lib/environment/environment-definition-store";
import { managedContainerName } from "@/lib/environment/environment-instance-backend";
import {
  beginEnvironmentLeaseReprepare,
  getEnvironmentLeaseByAttempt,
  getEnvironmentLeaseById,
} from "@/lib/environment/environment-lease-store";
import type { EnvironmentRevisionInput } from "@/lib/environment/environment-revision";
import {
  activateSeededEnvironmentLease,
  seedPreparedEnvironmentLease,
} from "@/lib/environment/test-support/seed-prepared-environment-lease";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
import { authorityIdentity } from "@/lib/executions/domain/execution-authority";
import {
  claimAttemptPreparation,
  claimAttemptPreparationInTransaction,
  getAttemptById,
  getLatestAttempt,
  markAttemptPreparedInTransaction,
  updateAttemptState,
} from "@/lib/executions/persistence/attempt-store";
import { getActiveExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import {
  attemptPreparationClaimForTest,
  executionSourceForTest,
  markAttemptPreparedForTestInTransaction,
} from "@/lib/executions/test-support/preparation-fixtures";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { registerDevice } from "@/lib/identity/device-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import {
  executionBindingTable,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationCommandTable,
  invocationTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { createResolveRoute } from "@/lib/routes/application/resolve-route";
import { mysqlRouteEligibilityResolutionStore } from "@/lib/routes/persistence/mysql-route-eligibility-resolution-store";
import { acceptExecutionPreparation } from "@/lib/runtime/application/execution-preparation";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import {
  createConfiguredHostedRuntimeApplicationService,
  resumeHarnessInvocation,
  resumeRuntimeInvocation as resumeRuntimeInvocationProduction,
} from "@/lib/runtime/application/runtime-resume";
import {
  RuntimeStartTransportError,
  executionSourceRequestForStart,
  startRuntimeInvocation,
} from "@/lib/runtime/application/runtime-start";
import {
  dispatchResumeCommandToRuntime,
  setCommandGatewayHostedApplicationServiceForTest,
} from "@/lib/runtime/command-dispatch-gateway";
import {
  dockerInfo,
  inspectContainer,
  inspectImage,
  listContainersByLabel,
  removeContainer,
} from "@/lib/runtime/container/docker-cli";
import { createProductionInvocationContinuationWorker } from "@/lib/runtime/continuation/production-invocation-continuation-worker";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  getRuntimeSessionBindingById,
  getRuntimeSessionBindingByOwnership,
  getRuntimeSessionBindingBySourceIntent,
  getRuntimeSessionBindingsByInvocation,
} from "@/lib/runtime/persistence/runtime-session-store";
import { failAttemptAndInvokeRecoveryAuthority } from "@/lib/runtime/retry/dispatch-queued-invocation-attempt";
import { createHttpRuntimeClient, defaultRuntimeCapabilities } from "@/lib/runtime/runtime-client";
import {
  PROTOCOL_VERSION,
  type RuntimeStartRequest,
  RuntimeStartRequestSchema,
  protocolDigest,
} from "@/lib/runtime/runtime-protocol";
import { executionSubjectFromUserIdentity } from "@/lib/runtime/transport/execution-subject";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import { ensureDesktopWorkspace } from "@/lib/workspace/desktop-workspace-queries";
import { cleanupWorkspaceCandidate } from "@/lib/workspace/workspace-cleanup";
import { createWorkspaceHostBroker } from "@/lib/workspace/workspace-host-server";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { runEnvironmentCleanupOnce } from "@/scripts/workers/environment-lease-cleanup";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TENANT_LABEL = "snow-harness.environment.tenantId";

/** 本地优先镜像候选（与 R07 合规验收同一口径，不允许静默跳过）。 */
const IMAGE_CANDIDATES = [
  "debian:bookworm-slim",
  "node:24-alpine",
  "alpine/socat:latest",
  "mysql:8.0",
] as const;

const MEMORY_BYTES = 128 * 1024 * 1024;
const NANO_CPUS = 500_000_000;
const PIDS_LIMIT = 64;
const OPEN_FILES_LIMIT = 128;

const ORIGINAL_AUTH_MODE = process.env.SNOW_VITEST_IDENTITY_FIXTURE;
const ORIGINAL_ENV_CONTROL_ROOT = process.env.SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT;
const ORIGINAL_RUNTIME_DEFAULT = process.env.RUNTIME_DEFAULT;

let dockerReady = false;
let resolvedImage: string | null = null;
let resolvedImageDigest = "";
let environmentControlRoot = "";
const temporaryRoots: string[] = [];
/** 外部 Runtime 对端（真实 HTTP server）；每个用例结束必须关闭，否则会泄漏端口。 */
const externalRuntimeStubs: Array<{ dispose(): Promise<void> }> = [];
const agentCallScenarios: Array<Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>> = [];
let seededTenantId = "";

async function seedTestResumeCommand(input: {
  tenantId: string;
  invocationId: string;
  sourceOperationKey: string;
}): Promise<void> {
  if (!input.sourceOperationKey.startsWith("command:")) return;
  const id = input.sourceOperationKey.slice("command:".length);
  const invocation = await getInvocationById(input.tenantId, input.invocationId);
  const attempt = await getLatestAttempt(input.invocationId);
  if (!invocation || !attempt) throw new Error("测试恢复来源缺少 Invocation/Attempt");
  const payloadJson = {
    resume_source: "user_pause",
    resume_payload: { source: "user_pause" },
    pause_source_digest: protocolDigest({
      attemptId: attempt.id,
      recoveryVersion: invocation.recoveryVersion,
      resumeAnchor: attempt.resumeAnchor,
      resumeAnchorDigest: attempt.resumeAnchorDigest,
    }),
  };
  await db
    .insert(invocationCommandTable)
    .values({
      id,
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      commandType: "resume",
      commandState: "queued",
      idempotencyKey: `test-resume:${id}`,
      payloadJson,
      payloadDigest: protocolDigest(payloadJson),
      requestedByType: "user",
      requestedById: "test-user",
    })
    .onDuplicateKeyUpdate({ set: { id } });
}

async function resumeRuntimeInvocation(
  input: Parameters<typeof resumeRuntimeInvocationProduction>[0],
): ReturnType<typeof resumeRuntimeInvocationProduction> {
  await seedTestResumeCommand({
    tenantId: input.tenantId,
    invocationId: input.invocation.id,
    sourceOperationKey: input.sourceOperationKey,
  });
  return resumeRuntimeInvocationProduction(input);
}

beforeAll(async () => {
  dockerReady = await dockerInfo();
  if (dockerReady) {
    for (const candidate of IMAGE_CANDIDATES) {
      const inspected = await inspectImage(candidate);
      if (inspected) {
        resolvedImage = candidate;
        resolvedImageDigest = inspected.Id;
        break;
      }
    }
  }
  // 平台部署事实（不是测试替身）：受管 Environment 的真实实例化只在 container Runtime 上成立。
  process.env.RUNTIME_DEFAULT = "container";
});

afterAll(async () => {
  if (dockerReady && seededTenantId) {
    for (const name of await listContainersByLabel(TENANT_LABEL, seededTenantId)) {
      await removeContainer(name);
    }
  }
  if (ORIGINAL_ENV_CONTROL_ROOT === undefined) {
    Reflect.deleteProperty(process.env, "SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT");
  } else {
    process.env.SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT = ORIGINAL_ENV_CONTROL_ROOT;
  }
  if (ORIGINAL_RUNTIME_DEFAULT === undefined) {
    Reflect.deleteProperty(process.env, "RUNTIME_DEFAULT");
  } else {
    process.env.RUNTIME_DEFAULT = ORIGINAL_RUNTIME_DEFAULT;
  }
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  setCommandGatewayHostedApplicationServiceForTest(null);
  for (const stub of externalRuntimeStubs.splice(0)) await stub.dispose();
  for (const scenario of agentCallScenarios.splice(0)) {
    delete process.env[scenario.credentialEnvVar];
    await scenario.provider.close();
  }
  if (ORIGINAL_AUTH_MODE === undefined) {
    Reflect.deleteProperty(process.env, "SNOW_VITEST_IDENTITY_FIXTURE");
  } else {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = ORIGINAL_AUTH_MODE;
  }
});

// ─── 夹具 ───────────────────────────────────────────────────

interface ManagedResumeContext {
  tenantId: string;
  ownerId: string;
  threadId: string;
  turnId: string;
  desktopBindingId: string;
  desktopWorkspaceId: string;
  environmentDefinitionId: string;
  environmentRevisionId: string;
  runtimeRevisionId: string;
}

function managedRevisionInput(): EnvironmentRevisionInput {
  if (!resolvedImage) {
    throw new Error(
      `A05 验收需要真实 docker 与本地候选镜像之一：${IMAGE_CANDIDATES.join(", ")}（不允许静默跳过）`,
    );
  }
  return {
    environmentType: "sandbox",
    filesystemPolicyJson: {
      readOnlyRootfs: true,
      workspaceMountPath: null,
      isolatedFromHost: true,
      extraMounts: [],
    },
    networkPolicyJson: { mode: "disabled" },
    resourceLimitsJson: {
      memoryBytes: MEMORY_BYTES,
      cpus: 0.5,
      pidsLimit: PIDS_LIMIT,
      openFilesLimit: OPEN_FILES_LIMIT,
    },
    secretPolicyJson: { injection: "none", envNames: [] },
    executionTarget: {
      kind: "container",
      image: resolvedImage,
      imageDigest: resolvedImageDigest,
      entrypoint: ["/bin/sh"],
      args: ["-c", "sleep 900"],
    },
    requiredCapabilities: {
      containerized: true,
      processIsolation: true,
      networkIsolation: true,
      readOnlyRootfs: true,
      resourceLimits: true,
      memoryLimit: true,
      cpuLimit: true,
      pidsLimit: true,
      openFilesLimit: true,
      pinnedImage: true,
      secretInjection: "none",
      filesystemIsolation: true,
    },
    createdByType: "user",
    createdById: "test-admin",
  };
}

/**
 * 真实「员工 Turn + MANAGED Environment + HOST_AFFINE Workspace」上下文。
 *
 * 与 ENTRY 夹具同源：Thread 的默认 Workspace/Environment 由真实解析器解析，
 * 不注入任何自定义 Resolver。
 */
async function seedManagedResumeContext(suffix: string): Promise<ManagedResumeContext> {
  if (!dockerReady) {
    throw new Error("A05 验收需要真实 docker（`docker info` 退出 0）：本用例不允许静默跳过。");
  }
  if (!resolvedImage) {
    throw new Error(`A05 验收需要本地具备候选镜像之一：${IMAGE_CANDIDATES.join(", ")}。`);
  }
  const { seedDispatchableTurn } = await import("@/lib/test-support/seed-dispatchable-turn");
  const context = await seedDispatchableTurn({ contentSuffix: suffix });
  seededTenantId = context.tenantId;

  const deviceKey = `device-${suffix}`;
  await registerDevice({
    tenantId: context.tenantId,
    userId: context.ownerId,
    deviceKey,
    publicKey: "vitest-public-key",
    deviceName: "Vitest Desktop",
    appVersion: "1.0.0",
  });
  const desktop = await ensureDesktopWorkspace({
    tenantId: context.tenantId,
    userId: context.ownerId,
    deviceKey,
    displayName: "snow_harness",
    storageScopeDigest: `sha256:${suffix
      .padEnd(64, "0")
      .slice(0, 64)
      .replace(/[^0-9a-f]/g, "a")}`,
  });
  const definition = await createEnvironmentDefinition({
    tenantId: context.tenantId,
    environmentKey: `a05-env-${suffix}`,
    displayName: "A05 受管环境",
    revision: managedRevisionInput(),
  });
  const revision = await getEnvironmentRevisionById(
    context.tenantId,
    definition.currentRevisionId as string,
  );
  if (!revision) throw new Error("EnvironmentRevision 创建后回查失败");
  await db
    .update(threadTable)
    .set({
      defaultWorkspaceId: desktop.workspaceId,
      defaultEnvironmentDefinitionId: definition.id,
    })
    .where(and(eq(threadTable.tenantId, context.tenantId), eq(threadTable.id, context.threadId)));

  return {
    tenantId: context.tenantId,
    ownerId: context.ownerId,
    threadId: context.threadId,
    turnId: context.turnId,
    desktopBindingId: desktop.bindingId,
    desktopWorkspaceId: desktop.workspaceId,
    environmentDefinitionId: definition.id,
    environmentRevisionId: revision.id,
    runtimeRevisionId: context.runtimeRevision.id,
  };
}

/** 决策端口：连续两轮要求用户补充输入，第三轮正常回答。 */
function pauseThenRespondService() {
  const decisionViews: Array<{ observations: unknown[] }> = [];
  const service = createConfiguredHostedRuntimeApplicationService({
    decisionPort: {
      async decideNextAction(view) {
        decisionViews.push(view);
        if (view.actionHistory.length < 2) {
          const round = view.actionHistory.length + 1;
          return {
            actionId: `a05-ask-input-${round}`,
            stepNo: round,
            actionType: "request_user_input",
            purposeCode: "missing_scope",
            shortPurpose: `第 ${round} 轮缺少范围`,
            payload: {
              purpose: "missing_scope",
              prompt: "请补充处理范围",
              inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["text"],
                properties: { text: { type: "string", minLength: 1, maxLength: 20_000 } },
              },
            },
          };
        }
        return {
          actionId: "a05-respond",
          stepNo: 3,
          actionType: "respond",
          purposeCode: "answer_ready",
          shortPurpose: "回答",
          payload: { evidenceRefs: [] },
        };
      },
    },
    finalResponsePort: {
      async generateFinalResponse() {
        return "已按补充范围完成";
      },
    },
    actionExecutors: {
      request_user_input: async (action) => ({
        authorityRef: `user-action:${action.actionId}`,
        observation: {
          observationType: "user_input",
          summary: "等待用户补充",
          sourceRefs: [],
          data: {},
        },
        waitingForUser: {
          requestType: "input" as const,
          purpose: action.payload.purpose,
          prompt: action.payload.prompt,
          inputSchema: action.payload.inputSchema,
        },
      }),
    },
    modelRef: "a05-managed-resume-model",
  });
  return { service, decisionViews };
}

async function waitForInvocationState(
  tenantId: string,
  invocationId: string,
  state: string,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const invocation = await getInvocationById(tenantId, invocationId);
    if (invocation?.executionState === state) return invocation;
    if (Date.now() > deadline) {
      throw new Error(
        `Invocation 未在 ${timeoutMs}ms 内进入 ${state}（当前 ${invocation?.executionState ?? "缺失"}）`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * 等到暂停的**全部**持久事实落定：Attempt=suspended、无 active Owner、
 * EnvironmentLease 回到可重新准备的 `preparing`。
 */
async function waitForPausedFacts(
  tenantId: string,
  invocationId: string,
  attemptId: string,
  leaseId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pausedAttempt = await getLatestAttempt(invocationId);
    const owner = await getActiveExecutionOwnership({ tenantId, invocationId });
    const lease = await getEnvironmentLeaseById(tenantId, leaseId);
    if (
      pausedAttempt?.attemptState === "suspended" &&
      !owner &&
      lease?.readinessState === "preparing" &&
      lease.activationOwnershipId === null
    ) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `暂停事实未在 ${timeoutMs}ms 内落定（attempt=${pausedAttempt?.attemptState ?? "缺失"}, ` +
          `owner=${owner ? owner.ownershipState : "null"}, ` +
          `lease=${lease?.readinessState ?? "缺失"}/${String(lease?.activationOwnershipId)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForPendingUserAction(
  invocationId: string,
  excludedId: string,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db
      .select()
      .from(userActionRequestTable)
      .where(
        and(
          eq(userActionRequestTable.invocationId, invocationId),
          eq(userActionRequestTable.requestState, "pending"),
        ),
      );
    const pending = rows.find((row) => row.id !== excludedId);
    if (pending) return pending;
    if (Date.now() > deadline) throw new Error("第二轮 UserActionRequest 未在时限内进入 pending");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Resume 命令的**已持久结论**。
 *
 * 失败时必须把这个结论带进断言消息：命令尾部的 `errorCode/errorMessage` 是判断
 * "到底卡在环境、运输还是权威"的唯一持久证据，否则只会看到一个 422。
 */
async function readResumeCommandOutcome(invocationId: string) {
  const rows = await db
    .select()
    .from(invocationCommandTable)
    .where(
      and(
        eq(invocationCommandTable.invocationId, invocationId),
        eq(invocationCommandTable.commandType, "resume"),
      ),
    );
  const row = rows.at(-1);
  return row ? `${row.commandState}/${row.lastErrorCode ?? "-"}` : "缺失";
}

/** 统计某个代际事件被真实 Ingress 接纳的次数。 */
async function countIngressEvents(invocationId: string, candidateType: string): Promise<number> {
  const rows = await db
    .select({ id: runtimeEventIngressTable.id })
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.invocationId, invocationId),
        eq(runtimeEventIngressTable.candidateType, candidateType),
      ),
    );
  return rows.length;
}

// ─── External continuation 夹具 ──────────────────────────────

/**
 * 真实外部 Runtime 对端（黑盒 HTTP，与 `DurableReferenceRuntime` 同一口径）。
 *
 * A05-02 需要一条**真的走网络**的 External continuation：远端必须收到
 * `POST /runtime/invocations/{id}/resume`，且回执摘要必须等于 Binding 所指向的
 * RuntimeRevision 发布证据 —— 否则 `startRuntimeInvocation` 会以
 * `RUNTIME_CAPABILITY_MISMATCH` fail closed（这正是"发布事实是唯一真值源"）。
 *
 * 回执之前先投递 `execution.started`（真实 Ingress）：这样 Resume 返回时"远程真的
 * 开始执行这一代"已经是持久事实，测试不必靠 sleep 猜时序。
 */
interface ExternalRuntimeStub {
  endpoint: string;
  readonly startRequests: RuntimeStartRequest[];
  readonly resumeRequests: RuntimeStartRequest[];
  setCapabilitiesDigest(value: string): void;
  dispose(): Promise<void>;
}

async function startExternalRuntimeStub(input: {
  tenantId: string;
  invocationId: string;
}): Promise<ExternalRuntimeStub> {
  const startRequests: RuntimeStartRequest[] = [];
  const resumeRequests: RuntimeStartRequest[] = [];
  let capabilitiesDigest = "";
  const server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "";
      const resumeMatch = `/runtime/invocations/${input.invocationId}/resume`;
      const isResume = request.method === "POST" && url === resumeMatch;
      const isStart = request.method === "POST" && url === "/runtime/invocations";
      if (!isResume && !isStart) {
        respondJson(response, 404, {
          error: { code: "RUNTIME_ROUTE_NOT_FOUND", message: url },
        });
        return;
      }
      const body = RuntimeStartRequestSchema.parse(await readJsonBody(request));
      if ((isResume && body.intentType !== "resume") || (isStart && body.intentType !== "start")) {
        respondJson(response, 400, {
          error: { code: "REQUEST_SCHEMA_INVALID", message: "intent/path mismatch" },
        });
        return;
      }
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey) {
        respondJson(response, 400, {
          error: { code: "REQUEST_SCHEMA_INVALID", message: "idempotency key missing" },
        });
        return;
      }
      const remoteSessionRef = `stub-session:${body.authority.sessionBindingId}`;
      const remoteExecutionRef = `stub-execution:${body.authority.ownershipId}`;
      if (isResume) resumeRequests.push(body);
      else startRequests.push(body);
      // 真实 Ingress：远端自报开始执行（先落执行事实，再回 ACK）。
      await ingressRuntimeEvents({
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        batch: {
          protocolVersion: PROTOCOL_VERSION,
          authority: body.authority,
          events: [
            {
              eventId: randomUUID(),
              producerSequence: body.producerSequenceStart,
              type: "execution.started",
              schemaVersion: 1,
              payload: {
                intentKey: idempotencyKey,
                semanticRequestDigest: body.semanticRequestDigest,
                remoteSessionRef,
                remoteExecutionRef,
                capabilitiesDigest,
              },
            },
          ],
        },
      });
      respondJson(response, 202, {
        protocolVersion: PROTOCOL_VERSION,
        authority: body.authority,
        semanticRequestDigest: body.semanticRequestDigest,
        accepted: true,
        remoteSessionRef,
        remoteExecutionRef,
        capabilitiesDigest,
        acceptedAt: Date.now(),
      });
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        respondJson(response, 500, {
          error: { code: "STUB_FAILURE", message: String(error) },
        });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    startRequests,
    resumeRequests,
    setCapabilitiesDigest(value: string) {
      capabilitiesDigest = value;
    },
    async dispose() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

// ─── 用例 ───────────────────────────────────────────────────

describe("A05：MANAGED 的正式暂停恢复（真实容器 + 真实 Workspace + 默认命令网关）", () => {
  beforeEach(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "a05-managed-resume-"));
    temporaryRoots.push(root);
    environmentControlRoot = path.join(root, "environment-control");
    process.env.SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT = environmentControlRoot;
    // 真实员工路由的身份夹具（与 R03 CONTROL 用例同一口径）。
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  it("A05-01/A05-T09 / N04-T2/N07-T2: 两轮正式暂停恢复来源独立，正常暂停保留同一受管 Lease", async () => {
    const ctx = await seedManagedResumeContext("a05one");
    const { service, decisionViews } = pauseThenRespondService();
    setCommandGatewayHostedApplicationServiceForTest(service);

    const revision = await getRuntimeRevisionById(ctx.runtimeRevisionId);
    if (!revision) throw new Error("RuntimeRevision 缺失");

    const client = createInProcessHostedRuntimeClient({
      tenantId: ctx.tenantId,
      applicationService: service,
      publishedCapabilityEvidence: {
        runtimeRevisionId: revision.id,
        runtimeCapabilitiesJson: revision.runtimeCapabilitiesJson,
      },
    });

    // ── 1. 真实调度：MANAGED Environment + HOST_AFFINE Workspace，真实容器被实例化 ──
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
      runtimeClient: client,
      runtimeEndpointResolver: async (binding) => ({
        runtimeEndpoint: "in-process://hosted",
        auth: { mode: "workload_token" as const, token: "in-process-runtime" },
        callbackEndpoints: buildGatewayEndpoints({
          external: false,
          invocationId: binding.invocationId,
        }),
      }),
    });
    const invocation = dispatch.invocation;
    const binding = dispatch.binding;
    const attempt = dispatch.attempt;
    if (!invocation || !binding || !attempt) {
      throw new Error("调度失败：未创建 Invocation/Binding/Attempt");
    }
    expect(binding.environmentMode).toBe("MANAGED");
    expect(binding.workspaceBindingId).toBe(ctx.desktopBindingId);
    const workspaceBinding = await getWorkspaceBindingById(
      ctx.tenantId,
      binding.workspaceBindingId,
    );
    expect(workspaceBinding?.continuityMode).toBe("HOST_AFFINE");

    // ── 2. 真实持久暂停（Loop 自报 user-action + execution.suspended）──
    // `user-action` 与 `execution.suspended` 是两个独立事务，逐条推进水位；因此必须
    // 等到**全部**暂停事实落定（Attempt=suspended / Owner 释放 / Lease 回到 preparing），
    // 而不是"Invocation 一翻成 waiting_user 就断言"。
    await waitForInvocationState(ctx.tenantId, invocation.id, "waiting_user");
    const leaseBefore = await getEnvironmentLeaseByAttempt(ctx.tenantId, invocation.id, attempt.id);
    if (!leaseBefore) throw new Error("MANAGED 必须真实准备 EnvironmentLease");
    await waitForPausedFacts(ctx.tenantId, invocation.id, attempt.id, leaseBefore.id);
    const pausedAttempt = await getLatestAttempt(invocation.id);
    expect(pausedAttempt?.attemptState).toBe("suspended");
    expect(
      await getActiveExecutionOwnership({ tenantId: ctx.tenantId, invocationId: invocation.id }),
    ).toBeNull();

    // 暂停把 Lease 打回"待重新准备"：这正是 Resume 必须接住的形状。
    const pausedLease = await getEnvironmentLeaseById(ctx.tenantId, leaseBefore.id);
    expect(pausedLease?.leaseState).toBe("active");
    expect(pausedLease?.readinessState).toBe("preparing");
    expect(pausedLease?.activationOwnershipId).toBeNull();

    // 正常用户暂停期间运行生产环境回收 Worker：可复用 Lease 不应成为交接清理任务。
    const pausedSweep = await runEnvironmentCleanupOnce();
    expect(pausedSweep.scanned).toBe(0);
    expect((await getEnvironmentLeaseById(ctx.tenantId, leaseBefore.id))?.leaseState).toBe(
      "active",
    );

    // 真实容器实例身份（resume 之后必须复用同一份实例，而不是"重新建一个"）。
    const operationId = (leaseBefore.resourceManifest as Record<string, unknown>)
      .operationId as string;
    const containerName = managedContainerName(operationId);
    const containerBefore = await inspectContainer(containerName);
    expect(containerBefore?.Id).toBeTruthy();

    const [uar] = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.invocationId, invocation.id))
      .limit(1);
    if (!uar) throw new Error("暂停未持久化 UserActionRequest");
    expect(uar.requestState).toBe("pending");
    expect(await countIngressEvents(invocation.id, "execution.started")).toBe(1);
    // 暂停时那一代 Session（Resume 必须换成本 Invocation 的**新**代际）。
    const sessionsWhenPaused = await getRuntimeSessionBindingsByInvocation(
      ctx.tenantId,
      invocation.id,
    );
    expect(sessionsWhenPaused).toHaveLength(1);
    const pausedOwnershipId = sessionsWhenPaused[0]?.ownershipId;
    const pausedSessionId = sessionsWhenPaused[0]?.id;

    // ── 3. 用户确认 → 真实员工路由 → **默认命令网关**（不注入 Resolver）──
    const resumeResponse = await resolveUserActionPOST(
      buildApiRequest({
        audience: "employee",
        method: "POST",
        path: `/threads/${ctx.threadId}/user-actions/${uar.id}/resolve`,
        idempotencyKey: `resolve:${randomUUID()}`,
        body: { resolution: "submit", response_redacted: { text: "范围=近 30 天" } },
      }),
      { params: Promise.resolve({ threadId: ctx.threadId, requestId: uar.id }) },
    );
    const responseText = await resumeResponse.text();
    const resumeOutcome = await readResumeCommandOutcome(invocation.id);
    expect(
      resumeResponse.status,
      `resolve 返回 ${resumeResponse.status}（Resume 命令结论 ${resumeOutcome}）: ${responseText}`,
    ).toBe(200);

    // ── 4. 第一轮恢复后再次真实暂停；同 Attempt 上形成第二条持久 Resume 命令 ──
    const secondUar = await waitForPendingUserAction(invocation.id, uar.id);
    await waitForPausedFacts(ctx.tenantId, invocation.id, attempt.id, leaseBefore.id);
    const secondPausedAttempt = await getLatestAttempt(invocation.id);
    expect(secondPausedAttempt?.attemptState).toBe("suspended");
    const firstRoundSessions = await getRuntimeSessionBindingsByInvocation(
      ctx.tenantId,
      invocation.id,
    );
    expect(firstRoundSessions).toHaveLength(2);
    const firstResumedSession = firstRoundSessions.find((row) => row.id !== pausedSessionId);
    expect(firstResumedSession?.intentType).toBe("resume");
    const firstPreparationSlot = await readPreparationSlot(ctx.tenantId, attempt.id);
    expect(firstPreparationSlot.preparationIntentKey).toBe(firstResumedSession?.sourceOperationKey);

    const secondResumeResponse = await resolveUserActionPOST(
      buildApiRequest({
        audience: "employee",
        method: "POST",
        path: `/threads/${ctx.threadId}/user-actions/${secondUar.id}/resolve`,
        idempotencyKey: `resolve:${randomUUID()}`,
        body: { resolution: "submit", response_redacted: { text: "范围=最近 7 天" } },
      }),
      { params: Promise.resolve({ threadId: ctx.threadId, requestId: secondUar.id }) },
    );
    const secondResponseText = await secondResumeResponse.text();
    expect(
      secondResumeResponse.status,
      `第二轮 resolve 返回 ${secondResumeResponse.status}: ${secondResponseText}`,
    ).toBe(200);

    // ── 5. 同 Invocation/Attempt 的第二轮恢复拥有独立来源键与新 O/S，最终正常完成 ──
    await waitForInvocationState(ctx.tenantId, invocation.id, "completed");
    const sessions = await getRuntimeSessionBindingsByInvocation(ctx.tenantId, invocation.id);
    expect(sessions).toHaveLength(3);
    const resumeSessions = sessions.filter((row) => row.intentType === "resume");
    expect(resumeSessions).toHaveLength(2);
    const resumedSession = resumeSessions.find((row) => row.id !== firstResumedSession?.id);
    expect(resumedSession).toBeTruthy();
    expect(resumedSession?.sourceOperationKey).not.toBe(firstResumedSession?.sourceOperationKey);
    const secondPreparationSlot = await readPreparationSlot(ctx.tenantId, attempt.id);
    expect(secondPreparationSlot.preparationIntentKey).toBe(resumedSession?.sourceOperationKey);
    // 同 Attempt、**新**所有权代际（暂停时那一代已 released）。
    expect(resumedSession?.attemptId).toBe(attempt.id);
    expect(resumedSession?.ownershipId).not.toBe(pausedOwnershipId);
    // 三次 execution.started 是两轮恢复都真的执行了新代际的持久证据。
    expect(await countIngressEvents(invocation.id, "execution.started")).toBe(3);

    // ── 6. 环境：Lease 被 Resume 重新准备并绑定**新**代际 ──
    // 恢复代际与受管资源的绑定用 `ExecutionOwnership.environmentLeaseId` 取证：它是持久事实，
    // 不像 `EnvironmentLease.activationOwnershipId` 那样会按 A08 在终态收口时被清空。
    const [resumedOwner] = resumedSession
      ? await db
          .select()
          .from(executionOwnershipTable)
          .where(eq(executionOwnershipTable.id, resumedSession.ownershipId))
          .limit(1)
      : [];
    expect(resumedOwner?.attemptId).toBe(attempt.id);
    // "另一个 Owner 复用了一个恰好 ready 的旧 Lease" 不成立：恢复代际自己绑的就是这份
    // Lease（激活时 `activateEnvironmentLease` 写回互指针，DB CHECK 保证 ready 必有激活者）。
    expect(resumedOwner?.environmentLeaseId).toBe(leaseBefore.id);
    // 执行已正常收口（Invocation=completed）→ 代际走的是统一终态收口边界（A02）。
    expect(resumedOwner?.ownershipState).toBe("released");
    expect(resumedOwner?.reasonCode).toBe("execution_terminal");

    // A08 8.1：**正常完成**同样是本 Attempt 的正式生命周期出口，必须登记真实清理工作。
    // 出口只把 Lease 推进到非终态 `releasing` 并清空激活指针——它**不**声明容器已经消失。
    const leaseAfter = await getEnvironmentLeaseById(ctx.tenantId, leaseBefore.id);
    expect(leaseAfter?.leaseState).toBe("releasing");
    expect(leaseAfter?.releasedAt).toBeNull();
    expect(leaseAfter?.readinessState).toBe("blocked");
    expect(leaseAfter?.activationOwnershipId).toBeNull();
    // 逻辑收口 ≠ 物理释放：还没跑回收 Worker，真实实例必须原样还在。
    expect((await inspectContainer(containerName))?.Id).toBe(containerBefore?.Id);

    const anchorDigest =
      secondPausedAttempt?.resumeAnchorDigest ??
      protocolDigest(
        secondPausedAttempt?.resumeAnchor ??
          `invocation:${invocation.id}:recovery:${invocation.recoveryVersion}`,
      );
    const preparedEvidence = leaseAfter?.preparedEvidence as {
      candidate?: { recoveryAnchorDigest?: string | null };
      verifier?: { kind?: string };
    };
    // A05 第 3 条：以**本次** Resume 的恢复锚点重写证据，旧证据必然被拒。
    expect(preparedEvidence?.candidate?.recoveryAnchorDigest).toBe(anchorDigest);
    // 仍是真实 docker 回读产生的证据，不是自报通过。
    expect(preparedEvidence?.verifier?.kind).toBe("docker_inspect");

    // ── 7. 真实实例被复用（不是重建）──
    const containerAfter = await inspectContainer(containerName);
    expect(containerAfter?.Id).toBe(containerBefore?.Id);

    // ── 8. 正确继续：每轮恢复后的 Loop 都读到已解决输入 ──
    expect(decisionViews).toHaveLength(3);
    expect(decisionViews[1]?.observations).toContainEqual(
      expect.objectContaining({
        observationType: "user_input",
        data: expect.objectContaining({
          harnessActionId: "a05-ask-input-1",
          response: { text: "范围=近 30 天" },
        }),
      }),
    );
    expect(decisionViews[2]?.observations).toContainEqual(
      expect.objectContaining({
        observationType: "user_input",
        data: expect.objectContaining({
          harnessActionId: "a05-ask-input-2",
          response: { text: "范围=最近 7 天" },
        }),
      }),
    );

    // 第一轮命令的 ACK 丢失后，原 Session 已成为历史且 Invocation 已终态。
    // 只从真实原回执收口交付，不再解析已释放的资源或重启旧执行。
    const firstCommandId = firstResumedSession?.sourceOperationKey?.replace(/^command:/, "");
    if (!firstCommandId || !firstResumedSession?.transportAcknowledgement) {
      throw new Error("第一轮 Resume 缺少持久命令或原 Transport 回执");
    }
    await db
      .update(invocationCommandTable)
      .set({
        commandState: "queued",
        receiptJson: null,
        completedAt: null,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
      })
      .where(eq(invocationCommandTable.id, firstCommandId));
    const historical = await dispatchResumeCommandToRuntime({
      tenantId: ctx.tenantId,
      commandId: firstCommandId,
    });
    expect(historical.dispatched).toBe(true);
    expect((await getRuntimeSessionBindingsByInvocation(ctx.tenantId, invocation.id)).length).toBe(
      3,
    );
    const [redelivered] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, firstCommandId))
      .limit(1);
    expect(redelivered?.commandState).toBe("acknowledged");
    expect(redelivered?.receiptJson).toEqual(firstResumedSession.transportAcknowledgement);
    expect(decisionViews).toHaveLength(3);

    const [turn] = await db.select().from(turnTable).where(eq(turnTable.id, ctx.turnId)).limit(1);
    expect(turn?.turnState).toBe("completed");

    // ── 9. 后台回收闭环（A08 8.1）：走**生产 Worker 入口**，拿到真实释放回执才写 `released` ──
    const sweep = await runEnvironmentCleanupOnce();
    expect(sweep.released).toBeGreaterThanOrEqual(1);
    const releasedLease = await getEnvironmentLeaseById(ctx.tenantId, leaseBefore.id);
    expect(releasedLease?.leaseState).toBe("released");
    expect(releasedLease?.releasedAt).toBeTruthy();
    // `released` 必须对应真实资源消失，而不是只改了一个状态字段。
    expect(await inspectContainer(containerName)).toBeNull();
  });

  it("A05-02: External continuation 必须携带同一份受管执行资源（缺参必然 EnvironmentRevisionMismatch）", async () => {
    const ctx = await seedManagedResumeContext("a05two");
    const { service } = pauseThenRespondService();
    setCommandGatewayHostedApplicationServiceForTest(service);

    const hostedRevision = await getRuntimeRevisionById(ctx.runtimeRevisionId);
    if (!hostedRevision) throw new Error("RuntimeRevision 缺失");

    // ── 1. 真实调度 + 真实容器 + 真实持久暂停（与 A05-01 同一条生产路径）──
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
      executionSubject: { tenantId: ctx.tenantId, subjectType: "user", subjectId: ctx.ownerId },
      runtimeClient: createInProcessHostedRuntimeClient({
        tenantId: ctx.tenantId,
        applicationService: service,
        publishedCapabilityEvidence: {
          runtimeRevisionId: hostedRevision.id,
          runtimeCapabilitiesJson: hostedRevision.runtimeCapabilitiesJson,
        },
      }),
      runtimeEndpointResolver: async (binding) => ({
        runtimeEndpoint: "in-process://hosted",
        auth: { mode: "workload_token" as const, token: "in-process-runtime" },
        callbackEndpoints: buildGatewayEndpoints({
          external: false,
          invocationId: binding.invocationId,
        }),
      }),
    });
    const invocation = dispatch.invocation;
    const attempt = dispatch.attempt;
    if (!invocation || !attempt) throw new Error("调度失败：未创建 Invocation/Attempt");
    expect(dispatch.binding?.environmentMode).toBe("MANAGED");
    expect(dispatch.binding?.workspaceBindingId).toBe(ctx.desktopBindingId);

    await waitForInvocationState(ctx.tenantId, invocation.id, "waiting_user");
    const leaseBefore = await getEnvironmentLeaseByAttempt(ctx.tenantId, invocation.id, attempt.id);
    if (!leaseBefore) throw new Error("MANAGED 必须真实准备 EnvironmentLease");
    await waitForPausedFacts(ctx.tenantId, invocation.id, attempt.id, leaseBefore.id);

    const pausedAttempt = await getLatestAttempt(invocation.id);
    const anchorDigest = pausedAttempt?.resumeAnchorDigest;
    if (!anchorDigest) throw new Error("暂停必须留下恢复锚点摘要（Resume 的恢复水位）");

    const operationId = (leaseBefore.resourceManifest as Record<string, unknown>)
      .operationId as string;
    const containerName = managedContainerName(operationId);
    const containerBefore = await inspectContainer(containerName);
    expect(containerBefore?.Id).toBeTruthy();
    expect(await countIngressEvents(invocation.id, "execution.started")).toBe(1);

    // ── 2. 部署事实：Binding 指向**真实 external_endpoint** RuntimeRevision ──
    // 外部 Runtime 提供方是部署事实，不是测试替身；对端是真实 HTTP server。
    const stub = await startExternalRuntimeStub({
      tenantId: ctx.tenantId,
      invocationId: invocation.id,
    });
    externalRuntimeStubs.push(stub);
    const externalRevisionId = randomUUID();
    await db.insert(runtimeRevisionTable).values({
      ...hostedRevision,
      id: externalRevisionId,
      revisionNo: hostedRevision.revisionNo + 1,
      runtimeEvidenceKind: "external_endpoint",
      endpointRef: stub.endpoint,
      runtimeArtifactRef: null,
      artifactId: null,
      artifactDigest: null,
      identityMode: "none",
      credentialRefId: null,
      networkZone: "external",
      revisionState: "published",
    });
    stub.setCapabilitiesDigest(
      expectedCapabilityManifestDigest({
        runtimeRevisionId: externalRevisionId,
        runtimeCapabilitiesJson: hostedRevision.runtimeCapabilitiesJson,
      }),
    );
    await db
      .update(runtimeTable)
      .set({ currentRevisionId: externalRevisionId })
      .where(eq(runtimeTable.id, hostedRevision.runtimeId));
    await db
      .update(executionBindingTable)
      .set({
        runtimeRevisionId: externalRevisionId,
        runtimeEvidenceKind: "external_endpoint",
        runtimeArtifactId: null,
        runtimeArtifactDigest: null,
      })
      .where(eq(executionBindingTable.invocationId, invocation.id));

    // ── 3. External continuation：走**生产入口**，不自拼 runtimeClient ──
    // 缺 `environmentProvisioner` 时这里必然抛 EnvironmentRevisionMismatch；
    // 正因如此，下面的"环境被重新准备"断言就是该缺陷的直接反证。
    const firstSource = `a05-external:${randomUUID()}`;
    const result = await resumeHarnessInvocation({
      tenantId: ctx.tenantId,
      invocationId: invocation.id,
      sourceType: "user_action",
      agentCallId: firstSource,
      sourceVersion: 1,
    });
    expect(result).toMatchObject({ status: "resumed", runtime: "external", pending: true });

    // 远端**真的**收到了这一次 resume（不是只写了回执）。
    expect(stub.startRequests).toHaveLength(0);
    expect(stub.resumeRequests).toHaveLength(1);
    const remoteResume = stub.resumeRequests[0];
    expect(remoteResume?.intentType).toBe("resume");
    // 恢复水位必须是暂停留下的**同一个**锚点（不是重新计算的另一个）。
    expect(remoteResume?.recovery).toMatchObject({ kind: "resume", anchorDigest });
    expect(remoteResume?.environment).toMatchObject({ mode: "MANAGED" });

    // ── 4. 受管环境被**重新准备**并绑定新代际 ──
    const leaseAfter = await getEnvironmentLeaseById(ctx.tenantId, leaseBefore.id);
    expect(leaseAfter?.leaseState).toBe("active");
    expect(leaseAfter?.readinessState).toBe("ready");
    expect(leaseAfter?.activationOwnershipId).toBeTruthy();
    const preparedEvidence = leaseAfter?.preparedEvidence as {
      candidate?: { recoveryAnchorDigest?: string | null };
      verifier?: { kind?: string };
    };
    // A05 第 3 条：证据按**本次** Resume 的锚点重写；沿用旧证据会被 activate 逐字比对拒绝。
    expect(preparedEvidence?.candidate?.recoveryAnchorDigest).toBe(anchorDigest);
    // 证据仍来自真实 docker 回读，不是自报通过。
    expect(preparedEvidence?.verifier?.kind).toBe("docker_inspect");

    // 同 Attempt、**新**代际：新 Session（intentType=resume）持有新 Ownership，且它就是
    // Lease 的激活者。
    const sessions = await getRuntimeSessionBindingsByInvocation(ctx.tenantId, invocation.id);
    expect(sessions).toHaveLength(2);
    const resumedSession = sessions.find((row) => row.intentType === "resume");
    expect(resumedSession?.attemptId).toBe(attempt.id);
    expect(leaseAfter?.activationOwnershipId).toBe(resumedSession?.ownershipId);
    expect(
      (await getActiveExecutionOwnership({ tenantId: ctx.tenantId, invocationId: invocation.id }))
        ?.id,
    ).toBe(resumedSession?.ownershipId);

    // ── 5. 真实实例被**复用**：重新准备是"回读既有实例"，不是"另起一个" ──
    const containerAfter = await inspectContainer(containerName);
    expect(containerAfter?.Id).toBe(containerBefore?.Id);

    // ── 6. 远端真实自报开始执行 → Invocation 才进入 running ──
    // 回执本身不是运行事实：这里之所以能读到 running，是因为对端经真实 Ingress
    // 投递了执行事实。
    expect(await countIngressEvents(invocation.id, "execution.started")).toBe(2);
    expect((await getInvocationById(ctx.tenantId, invocation.id))?.executionState).toBe("running");

    // 两次正式 AgentCall：从父 Runtime 的当前 Authority 创建，经 UserAction API
    // 与持久 Outbox Delivery 由生产 Worker 恢复；不能用测试直接调用 Resume 冒充消费者。
    const scenario = await seedAgentCallExecutionScenario({
      tenantId: ctx.tenantId,
      threadOwnerUserId: ctx.ownerId,
      providerScenario: "confirmation_resolution",
      contract: {
        ...EXECUTION_FIXTURE_CONTRACT,
        interaction: {
          ...EXECUTION_FIXTURE_CONTRACT.interaction,
          input_required: true,
          resume: true,
        },
      },
      agentInterfaceRequirements: {
        host_controls: { confirmation_action_keys: ["hr.leave.submit"] },
      },
    });
    agentCallScenarios.push(scenario);
    await db
      .update(turnTable)
      .set({ preferredAgentId: scenario.agentId, agentUseMode: "preferred" })
      .where(eq(turnTable.id, ctx.turnId));
    const execute = createAgentActionExecutor({
      tenantId: ctx.tenantId,
      executionSubject: executionSubjectFromUserIdentity(ctx.tenantId, ctx.ownerId),
      resolveRoute: createResolveRoute({ store: mysqlRouteEligibilityResolutionStore }),
      transportChannel: "hosted",
    });
    const worker = createProductionInvocationContinuationWorker("a05-managed-agent-call");
    const callIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const currentOwner = await getActiveExecutionOwnership({
        tenantId: ctx.tenantId,
        invocationId: invocation.id,
      });
      if (!currentOwner) throw new Error("AgentCall 前缺少当前 Owner");
      const currentSession = await getRuntimeSessionBindingByOwnership(
        ctx.tenantId,
        currentOwner.id,
      );
      if (!currentSession) throw new Error("AgentCall 前缺少当前 Session");
      const started = await execute(
        {
          actionId: `a05-managed-agent-call-${index}`,
          stepNo: index + 1,
          actionType: "agent.call",
          purposeCode: "submit_leave",
          shortPurpose: "提交请假",
          payload: { agentId: scenario.agentId, task: "提交我的年假申请" },
        },
        {
          invocationId: invocation.id,
          tenantId: ctx.tenantId,
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          actionDigest: protocolDigest({ managedAgentCall: index }),
          authority: authorityIdentity({
            invocationId: invocation.id,
            runtimeRevisionId: externalRevisionId,
            attemptId: currentOwner.attemptId,
            ownershipId: currentOwner.id,
            leaseEpoch: currentOwner.leaseEpoch,
            sessionBindingId: currentSession.id,
          }),
        },
      );
      if (started.pending?.kind !== "agent_call") throw new Error("未创建正式 AgentCall");
      const callId = started.pending.callId;
      callIds.push(callId);
      await worker.pollOnce();
      const requests = await db
        .select()
        .from(userActionRequestTable)
        .where(eq(userActionRequestTable.invocationId, invocation.id));
      const request = requests.find(
        (row) => (row.promptJson as Record<string, unknown>).agent_call_id === callId,
      );
      if (!request) throw new Error("AgentCall 没有产生正式 UserActionRequest");
      const response = await resolveUserActionPOST(
        new Request(
          `http://snow.test/api/threads/${ctx.threadId}/user-actions/${request.id}/resolve`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": `a05-resolve-${request.id}`,
            },
            body: JSON.stringify({ resolution: "approve" }),
          },
        ),
        { params: Promise.resolve({ threadId: ctx.threadId, requestId: request.id }) },
      );
      expect(response.status).toBe(200);
      await worker.pollOnce(); // resume_agent_after_user_response
      await worker.pollOnce(); // resume_parent → MANAGED Environment + External Runtime
      expect(stub.resumeRequests).toHaveLength(index + 2);
      const currentLease = await getEnvironmentLeaseById(ctx.tenantId, leaseBefore.id);
      const sessionsNow = await getRuntimeSessionBindingsByInvocation(ctx.tenantId, invocation.id);
      const callSession = sessionsNow.find((row) =>
        row.sourceOperationKey.startsWith(`agent-call:${callId}:`),
      );
      expect(callSession?.ownershipId).toBeTruthy();
      expect(callSession?.ownershipId).not.toBe(currentOwner.id);
      expect(callSession?.attemptId).toBe(attempt.id);
      expect(currentLease?.readinessState).toBe("ready");
      expect(currentLease?.activationOwnershipId).toBe(callSession?.ownershipId);
      const [retiredOwner] = await db
        .select()
        .from(executionOwnershipTable)
        .where(eq(executionOwnershipTable.id, currentOwner.id));
      expect(retiredOwner?.ownershipState).toBe("released");
      expect(sessionsNow.find((row) => row.id === currentSession.id)?.bindingState).toBe("lost");
      expect((await inspectContainer(containerName))?.Id).toBe(containerBefore?.Id);
    }
    expect(callIds[0]).not.toBe(callIds[1]);
    const secondSessions = await getRuntimeSessionBindingsByInvocation(ctx.tenantId, invocation.id);
    const secondSession = secondSessions.find((row) =>
      row.sourceOperationKey.startsWith(`agent-call:${callIds[1]}:`),
    );
    await resumeHarnessInvocation({
      tenantId: ctx.tenantId,
      invocationId: invocation.id,
      sourceType: "user_action",
      agentCallId: firstSource,
      sourceVersion: 1,
    });
    expect(stub.resumeRequests).toHaveLength(3);
    expect(
      (await getEnvironmentLeaseById(ctx.tenantId, leaseBefore.id))?.activationOwnershipId,
    ).toBe(secondSession?.ownershipId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A05 唯一决策表：来源意图与准备槽
//
// 这一组**不使用容器实例化**：来源意图的全部判据都在 I 根事务与 Attempt 的准备槽上，
// 受管实例的"真实回读"不属于本组要证明的不变量（那由上面两个用例覆盖）。
// 层：真实 MySQL + 真实协议对端（本地 HTTP）+ 真实 Ingress；唯一替身是**对端的执行体**
// （它不跑用户任务，只按稳定幂等键回执并自报 execution.started）。
// ═══════════════════════════════════════════════════════════════════════════

const INTENT_CALLBACK_ENDPOINTS = {
  events: "http://127.0.0.1/runtime/events",
  heartbeat: "http://127.0.0.1/runtime/heartbeat",
  context: "http://127.0.0.1/gateway/context",
  capabilityActions: "http://127.0.0.1/gateway/capability-actions",
  toolCalls: "http://127.0.0.1/gateway/tool-calls",
  userActions: "http://127.0.0.1/gateway/user-actions",
};

interface IntentRuntimeStub {
  endpoint: string;
  readonly requests: Array<{ path: string; idempotencyKey: string; body: RuntimeStartRequest }>;
  /** 稳定幂等键 → 该次执行的事实。同一个键只会执行一次。 */
  readonly executions: Map<string, { remoteSessionRef: string; remoteExecutionRef: string }>;
  /** 下一次请求在真实落库之后丢弃响应（模拟 ACK 丢失）。 */
  dropNextResponse: boolean;
  /** 收到请求时是否经真实 Ingress 自报 execution.started。 */
  deliverStarted: boolean;
  dispose(): Promise<void>;
}

/**
 * 真实 HTTP 对端：按 `idempotency-key` 去重（同一个稳定意图只执行一次），
 * 并可直接用真实 Ingress 投递 `execution.started` —— 这让"重投"与"又执行了一代"
 * 成为两个可分辨的持久事实，而不是靠调用次数猜。
 */
async function startIntentRuntimeStub(input: {
  tenantId: string;
  invocationId: string;
  capabilitiesDigest: string;
}): Promise<IntentRuntimeStub> {
  const requests: IntentRuntimeStub["requests"] = [];
  const executions: IntentRuntimeStub["executions"] = new Map();
  let server: Server | null = null;
  const stub: IntentRuntimeStub = {
    endpoint: "",
    requests,
    executions,
    dropNextResponse: false,
    deliverStarted: false,
    async dispose() {
      const current = server;
      server = null;
      if (!current) return;
      await new Promise<void>((resolve, reject) =>
        current.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "";
      const isResume =
        request.method === "POST" && url === `/runtime/invocations/${input.invocationId}/resume`;
      const isStart = request.method === "POST" && url === "/runtime/invocations";
      if (!isResume && !isStart) {
        respondJson(response, 404, { error: { code: "RUNTIME_ROUTE_NOT_FOUND", message: url } });
        return;
      }
      const body = RuntimeStartRequestSchema.parse(await readJsonBody(request));
      if ((isResume && body.intentType !== "resume") || (isStart && body.intentType !== "start")) {
        respondJson(response, 400, {
          error: { code: "REQUEST_SCHEMA_INVALID", message: "intent/path mismatch" },
        });
        return;
      }
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey) {
        respondJson(response, 400, {
          error: { code: "REQUEST_SCHEMA_INVALID", message: "idempotency key missing" },
        });
        return;
      }
      requests.push({ path: url, idempotencyKey, body });
      const existing = executions.get(idempotencyKey);
      const accepted = existing ?? {
        remoteSessionRef: `stub-session:${idempotencyKey}`,
        remoteExecutionRef: `stub-execution:${idempotencyKey}`,
      };
      if (!existing) {
        executions.set(idempotencyKey, accepted);
        if (stub.deliverStarted) {
          await ingressRuntimeEvents({
            tenantId: input.tenantId,
            invocationId: input.invocationId,
            batch: {
              protocolVersion: PROTOCOL_VERSION,
              authority: body.authority,
              events: [
                {
                  eventId: randomUUID(),
                  producerSequence: body.producerSequenceStart,
                  type: "execution.started",
                  schemaVersion: 1,
                  payload: {
                    intentKey: idempotencyKey,
                    semanticRequestDigest: body.semanticRequestDigest,
                    remoteSessionRef: accepted.remoteSessionRef,
                    remoteExecutionRef: accepted.remoteExecutionRef,
                    capabilitiesDigest: input.capabilitiesDigest,
                  },
                },
              ],
            },
          });
        }
      }
      if (stub.dropNextResponse) {
        stub.dropNextResponse = false;
        response.destroy();
        return;
      }
      respondJson(response, 202, {
        protocolVersion: PROTOCOL_VERSION,
        authority: body.authority,
        semanticRequestDigest: body.semanticRequestDigest,
        accepted: true,
        remoteSessionRef: accepted.remoteSessionRef,
        remoteExecutionRef: accepted.remoteExecutionRef,
        capabilitiesDigest: input.capabilitiesDigest,
        acceptedAt: Date.now(),
      });
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        respondJson(response, 500, { error: { code: "STUB_FAILURE", message: String(error) } });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  stub.endpoint = `http://127.0.0.1:${address.port}`;
  return stub;
}

/** A05 夹具的 EnvironmentRevision：不声明可实例化镜像（本组不做容器实例化）。 */
function intentRevisionInput(): EnvironmentRevisionInput {
  return {
    environmentType: "sandbox",
    filesystemPolicyJson: {
      readOnlyRootfs: true,
      workspaceMountPath: null,
      isolatedFromHost: true,
      extraMounts: [],
    },
    networkPolicyJson: { mode: "disabled" },
    resourceLimitsJson: {
      memoryBytes: MEMORY_BYTES,
      cpus: 0.5,
      pidsLimit: PIDS_LIMIT,
      openFilesLimit: OPEN_FILES_LIMIT,
    },
    secretPolicyJson: { injection: "none", envNames: [] },
    executionTarget: {
      kind: "container",
      image: "a05-intent-fixture:latest",
      imageDigest: `sha256:${"a".repeat(64)}`,
      entrypoint: ["/bin/sh"],
      args: ["-c", "sleep 900"],
    },
    requiredCapabilities: {
      containerized: true,
      processIsolation: true,
      networkIsolation: true,
      readOnlyRootfs: true,
      resourceLimits: true,
      memoryLimit: true,
      cpuLimit: true,
      pidsLimit: true,
      openFilesLimit: true,
      pinnedImage: true,
      secretInjection: "none",
      filesystemIsolation: true,
    },
    createdByType: "user",
    createdById: "test-admin",
  };
}

async function seedIntentFixture(input: { withEnvironment?: boolean } = {}) {
  const tenant = await ensureDefaultTenant();
  const runtimeId = randomUUID();
  const runtimeRevisionId = randomUUID();
  const digest = protocolDigest({ runtimeId, runtimeRevisionId, fixture: "a05-resume-intent" });
  await db.insert(runtimeTable).values({
    id: runtimeId,
    tenantId: tenant.id,
    runtimeKey: `a05-intent-runtime-${runtimeId}`,
    displayName: "A05 意图对端",
    runtimeKind: "external",
    ownerUserId: "test-user",
    lifecycleState: "enabled",
    currentRevisionId: runtimeRevisionId,
    versionNo: 1,
  });
  await db.insert(runtimeRevisionTable).values({
    id: runtimeRevisionId,
    tenantId: tenant.id,
    runtimeId,
    revisionNo: 1,
    protocolType: "harness_runtime_protocol",
    protocolVersion: PROTOCOL_VERSION,
    protocolContractDigest: digest,
    runtimeEvidenceKind: "external_endpoint",
    runtimeTargetDigest: digest,
    endpointRef: "http://127.0.0.1/a05-intent-runtime",
    runtimeArtifactRef: null,
    artifactId: null,
    artifactDigest: null,
    runtimeCapabilitiesJson: defaultRuntimeCapabilities(),
    identityMode: "none",
    networkZone: "external",
    configHash: digest,
    credentialRefId: null,
    revisionState: "published",
    createdBy: "test-service",
  });
  let environmentDefinitionRevisionId: string | undefined;
  if (input.withEnvironment) {
    const definition = await createEnvironmentDefinition({
      tenantId: tenant.id,
      environmentKey: `a05-intent-env-${tenant.id.slice(0, 8)}`,
      displayName: "A05 意图夹具环境",
      revision: intentRevisionInput(),
    });
    environmentDefinitionRevisionId = definition.currentRevisionId as string;
  }
  const fixture = await seedPreparedRuntimeAttempt({
    tenantId: tenant.id,
    runtimeRevisionId,
    environmentDefinitionRevisionId,
    policyRevisionId: randomUUID(),
    governanceConfigRevisionId: randomUUID(),
  });
  const revision = await getRuntimeRevisionById(runtimeRevisionId);
  if (!revision) throw new Error("RuntimeRevision 缺失");
  return {
    ...fixture,
    runtimeRevisionId,
    capabilitiesDigest: expectedCapabilityManifestDigest({
      runtimeRevisionId,
      runtimeCapabilitiesJson: revision.runtimeCapabilitiesJson,
    }),
  };
}

function intentTransport(stub: IntentRuntimeStub) {
  return {
    runtimeClient: createHttpRuntimeClient(),
    runtimeEndpoint: stub.endpoint,
    auth: { mode: "none" as const },
    callbackEndpoints: INTENT_CALLBACK_ENDPOINTS,
  };
}

/** 读 Attempt 的准备槽持久事实（绝不读内存标志）。 */
async function readPreparationSlot(tenantId: string, attemptId: string) {
  const [row] = await db
    .select({
      preparationState: invocationAttemptTable.preparationState,
      preparationIntentKey: invocationAttemptTable.preparationIntentKey,
      preparationRequestDigest: invocationAttemptTable.preparationRequestDigest,
      preparationClaimId: invocationAttemptTable.preparationClaimId,
      preparationLeaseExpiresAt: invocationAttemptTable.preparationLeaseExpiresAt,
      preparationCount: invocationAttemptTable.preparationCount,
    })
    .from(invocationAttemptTable)
    .where(
      and(eq(invocationAttemptTable.tenantId, tenantId), eq(invocationAttemptTable.id, attemptId)),
    )
    .limit(1);
  if (!row) throw new Error("InvocationAttempt 缺失");
  return row;
}

async function markIntentAttemptPrepared(tenantId: string, attemptId: string): Promise<void> {
  const evidence = { kind: "a05-intent-attempt-prepared", attemptId };
  await db.transaction((tx) =>
    markAttemptPreparedForTestInTransaction(tx, {
      attemptId,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
  void tenantId;
}

async function claimLeaseReprepareForTest(input: {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  leaseId: string;
  sourceOperationKey: string;
  claimId: string;
  recoveryAnchorDigest: string;
}) {
  const [binding] = await db
    .select()
    .from(executionBindingTable)
    .where(eq(executionBindingTable.invocationId, input.invocationId))
    .limit(1);
  const invocation = await getInvocationById(input.tenantId, input.invocationId);
  if (!binding || !invocation) throw new Error("准备领取测试夹具不完整");
  const claimed = await claimAttemptPreparation({
    source: {
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      attemptId: input.attemptId,
      sourceOperationKey: input.sourceOperationKey,
      intentType: "resume",
      sourceKind: "user_resume",
      sourceRef: input.sourceOperationKey,
      predecessor: null,
      runtimeRevisionId: binding.runtimeRevisionId,
      workspaceBindingId: binding.workspaceBindingId,
      environmentDefinitionRevisionId: binding.environmentDefinitionRevisionId,
      bindingConfigDigest: binding.configHash,
      inputDigest: invocation.inputDigest,
      recovery: {
        kind: "resume",
        anchor: `test-anchor:${input.recoveryAnchorDigest}`,
        anchorDigest: input.recoveryAnchorDigest,
        checkpointId: null,
      },
    },
    claimId: input.claimId,
  });
  if (claimed.disposition !== "claimed" || !claimed.claim) {
    throw new Error(`测试准备领取未成功（${claimed.disposition}）`);
  }
  return {
    lease: await beginEnvironmentLeaseReprepare({
      preparationClaim: claimed.claim,
      leaseId: input.leaseId,
      recoveryAnchorDigest: input.recoveryAnchorDigest,
    }),
    claim: claimed.claim,
  };
}

/**
 * MANAGED 准备槽的完整一次生命周期（真实 store 写入，不做容器实例化）：
 * prepared+激活 → 登记准备槽（新准备）→ 写入新锚点的 Prepared 证据 → 再激活。
 *
 * 返回的 `authority` 是激活者（也就是"原新 O"）。
 */
async function seedPreparedSlotLifecycle(input: {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  runtimeRevisionId: string;
  workspaceBindingId: string;
  environmentDefinitionRevisionId: string;
  recoveryAnchorDigest: string;
  preparationIntentKey: string;
  preparationRequestDigest: string;
  preparationClaimId: string;
}) {
  const revision = await getEnvironmentRevisionById(
    input.tenantId,
    input.environmentDefinitionRevisionId,
  );
  if (!revision) throw new Error("EnvironmentRevision 缺失");
  const seeded = await seedPreparedEnvironmentLease({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    revision,
    workspaceBindingId: input.workspaceBindingId,
    recoveryAnchorDigest: input.recoveryAnchorDigest,
  });
  const authority = await acquireTestRuntimeAuthority({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    runtimeRevisionId: input.runtimeRevisionId,
    environmentLeaseId: seeded.id,
    // 取得执行权依据的恢复水位必须与 Lease 上冻结的 Prepared 证据一致（A05 的正题）。
    recoveryAnchorDigest: input.recoveryAnchorDigest,
  });
  await activateSeededEnvironmentLease({
    tenantId: input.tenantId,
    lease: seeded,
    ownershipId: authority.ownership.id,
    recoveryAnchorDigest: input.recoveryAnchorDigest,
  });
  // fixture 的 acquireTestRuntimeAuthority 不执行真实 Start 的 claim 消费；
  // 此处显式模拟激活提交，否则下一来源会正确地看到健康旧 claim 并返回 busy。
  await db
    .update(invocationAttemptTable)
    .set({ preparationClaimId: null, preparationLeaseExpiresAt: null })
    .where(eq(invocationAttemptTable.id, input.attemptId));
  const prepared = await claimLeaseReprepareForTest({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    leaseId: seeded.id,
    attemptId: input.attemptId,
    sourceOperationKey: input.preparationIntentKey,
    claimId: input.preparationClaimId,
    recoveryAnchorDigest: input.recoveryAnchorDigest,
  });
  const reprepared = await seedPreparedEnvironmentLease({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    revision,
    workspaceBindingId: input.workspaceBindingId,
    lease: prepared.lease,
    recoveryAnchorDigest: input.recoveryAnchorDigest,
  });
  await activateSeededEnvironmentLease({
    tenantId: input.tenantId,
    lease: reprepared,
    ownershipId: authority.ownership.id,
    recoveryAnchorDigest: input.recoveryAnchorDigest,
  });
  // 生产时序：Start 事务把 Attempt 标回 prepared（同一次 Resume 的第二次投递据此识别）。
  await markIntentAttemptPrepared(input.tenantId, input.attemptId);
  return {
    revision,
    leaseId: seeded.id,
    ownershipId: authority.ownership.id,
    lease: await getEnvironmentLeaseById(input.tenantId, seeded.id),
  };
}

describe("A05：唯一决策表（来源意图与环境准备交接的逐行判据）", () => {
  beforeEach(async () => {
    process.env.SNOW_VITEST_IDENTITY_FIXTURE = "enabled";
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  it("A05-T01 / N03-T2/N04-T3：ACK 与 started 均未到，同意图重投不另造 O/S、不重置 ready/激活", async () => {
    const fixture = await seedIntentFixture();
    const { tenantId, invocation, binding, attempt } = fixture;
    const stub = await startIntentRuntimeStub({
      tenantId,
      invocationId: invocation.id,
      capabilitiesDigest: fixture.capabilitiesDigest,
    });
    externalRuntimeStubs.push(stub);

    // ── 1. 真实 Start：第一代真的执行 ──
    stub.deliverStarted = true;
    const initial = await startRuntimeInvocation({
      tenantId,
      invocation,
      binding,
      attempt,
      sourceOperationKey: `invocation:${invocation.id}`,
      preparationClaim: await attemptPreparationClaimForTest(attempt.id),
      ...intentTransport(stub),
    });
    expect(await countIngressEvents(invocation.id, "execution.started")).toBe(1);

    // ── 2. 真实暂停（Ingress 接纳 execution.suspended）──
    const anchorDigest = protocolDigest({ anchor: "a05-t01" });
    await ingressRuntimeEvents({
      tenantId,
      invocationId: invocation.id,
      batch: {
        protocolVersion: PROTOCOL_VERSION,
        authority: initial.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "2",
            type: "execution.suspended",
            schemaVersion: 1,
            payload: { reason: "a05-t01", resumeAnchorDigest: anchorDigest },
          },
        ],
      },
    });
    expect((await getLatestAttempt(invocation.id))?.attemptState).toBe("suspended");

    // ── 3. 第一次恢复：远端已执行，但回执丢失且这一代 started 尚未到 ──
    const resumeKey = `command:${randomUUID()}`;
    stub.deliverStarted = false;
    stub.dropNextResponse = true;
    const firstFailure = await resumeRuntimeInvocation({
      tenantId,
      invocation,
      binding,
      attempt,
      sourceOperationKey: resumeKey,
      anchor: "a05-t01",
      anchorDigest,
      ...intentTransport(stub),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(firstFailure).toBeInstanceOf(RuntimeStartTransportError);
    if (!(firstFailure instanceof RuntimeStartTransportError)) {
      throw new Error("首次 Resume 必须返回携带出发身份的失败");
    }

    const sessionsWhenAckLost = await getRuntimeSessionBindingsByInvocation(
      tenantId,
      invocation.id,
    );
    expect(sessionsWhenAckLost).toHaveLength(2);
    const resumedSession = sessionsWhenAckLost.find((row) => row.intentType === "resume");
    expect(resumedSession).toBeTruthy();
    if (!resumedSession) throw new Error("恢复必须建立新的 resume Session");
    // ACK 丢失、started 未到：仍然只有 first 那一次 started。
    expect(await countIngressEvents(invocation.id, "execution.started")).toBe(1);

    // ── 4. 重投同一持久 Resume 命令（同来源键 + 同语义摘要）──
    const replayed = await resumeRuntimeInvocation({
      tenantId,
      invocation,
      binding,
      attempt,
      sourceOperationKey: resumeKey,
      anchor: "a05-t01",
      anchorDigest,
      sessionDispatchClaim: firstFailure.dispatchIdentity,
      ...intentTransport(stub),
    });
    // 同一来源意图只有一个 S/O，且就是原来那一个。
    const bySource = await getRuntimeSessionBindingBySourceIntent(tenantId, {
      invocationId: invocation.id,
      attemptId: attempt.id,
      intentType: "resume",
      sourceOperationKey: resumeKey,
    });
    expect(bySource?.id).toBe(resumedSession.id);
    // 重投返回原意图的**持久**回执（Session 身份以按来源意图回读为准）。
    expect(replayed.remoteSessionRef).toBe(bySource?.remoteSessionRef);
    expect(replayed.remoteExecutionRef).toBe(bySource?.remoteExecutionRef);
    expect(await getRuntimeSessionBindingsByInvocation(tenantId, invocation.id)).toHaveLength(2);
    // 重投是**交付重试**：远端收到两次同一幂等键，但只执行一次。
    const resumeRequests = stub.requests.filter((entry) => entry.path.endsWith("/resume"));
    expect(resumeRequests).toHaveLength(2);
    expect(new Set(resumeRequests.map((entry) => entry.idempotencyKey))).toEqual(
      new Set([`start:${resumedSession.ownershipId}`]),
    );
    expect(stub.executions.size).toBe(2);

    // ── 5. 随后提交原代际真实 started：仍可被接纳 ──
    //
    // 序号取自平台在 Resume 请求里告知的 `producerSequenceStart`：producerSequence 是
    // **每 Invocation 连续**的序号（Ingress 逐条核对 `lastProducerSequence + 1`），不是
    // 每个所有权从 1 重数。晚到的 started 属于"原代际的真实事件"，因此必须用原请求告知
    // 的起点；写死 "1" 会被判成与首次 started 抢同一序号，那是测试造错了事件，不是实现拒绝。
    const resumeRequest = stub.requests.find((entry) => entry.path.endsWith("/resume"));
    if (!resumeRequest) throw new Error("缺少 Resume 请求记录");
    await ingressRuntimeEvents({
      tenantId,
      invocationId: invocation.id,
      batch: {
        protocolVersion: PROTOCOL_VERSION,
        authority: authorityIdentity({
          invocationId: invocation.id,
          runtimeRevisionId: binding.runtimeRevisionId,
          attemptId: resumedSession.attemptId,
          ownershipId: resumedSession.ownershipId,
          leaseEpoch: resumedSession.leaseEpoch,
          sessionBindingId: resumedSession.id,
        }),
        events: [
          {
            eventId: randomUUID(),
            producerSequence: resumeRequest.body.producerSequenceStart,
            type: "execution.started",
            schemaVersion: 1,
            payload: {
              intentKey: `start:${resumedSession.ownershipId}`,
              semanticRequestDigest: replayed.semanticRequestDigest,
              remoteSessionRef: replayed.remoteSessionRef,
              remoteExecutionRef: replayed.remoteExecutionRef,
              capabilitiesDigest: fixture.capabilitiesDigest,
            },
          },
        ],
      },
    });
    expect(await countIngressEvents(invocation.id, "execution.started")).toBe(2);
    expect((await getInvocationById(tenantId, invocation.id))?.executionState).toBe("running");

    // ── 6. 环境维度：同来源、同摘要的重投必须**原样返回当前 Lease** ──
    // 这是"无条件 reprepare 会清掉 ready/激活"的直接反证。
    const managed = await seedIntentFixture({ withEnvironment: true });
    const envRevisionId = managed.binding.environmentDefinitionRevisionId;
    if (!envRevisionId) throw new Error("MANAGED 夹具必须冻结 EnvironmentDefinitionRevision");
    const envAnchor = protocolDigest({ anchor: "a05-t01-env" });
    const intentKey = `resume:${managed.invocation.id}:${managed.attempt.id}`;
    const intentDigest = protocolDigest({
      scope: "environment-reprepare",
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      anchorDigest: envAnchor,
    });
    const lifecycle = await seedPreparedSlotLifecycle({
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      runtimeRevisionId: managed.runtimeRevisionId,
      workspaceBindingId: managed.workspace.id,
      environmentDefinitionRevisionId: envRevisionId,
      recoveryAnchorDigest: envAnchor,
      preparationIntentKey: intentKey,
      preparationRequestDigest: intentDigest,
      preparationClaimId: "claim-first",
    });
    expect(lifecycle.lease?.readinessState).toBe("ready");
    expect(lifecycle.lease?.activationOwnershipId).toBe(lifecycle.ownershipId);
    const slotBefore = await readPreparationSlot(managed.tenantId, managed.attempt.id);

    const replayedLease = await beginEnvironmentLeaseReprepare({
      preparationClaim: await attemptPreparationClaimForTest(managed.attempt.id),
      leaseId: lifecycle.leaseId,
      recoveryAnchorDigest: envAnchor,
    });
    expect(replayedLease.id).toBe(lifecycle.leaseId);
    expect(replayedLease.readinessState).toBe("ready");
    expect(replayedLease.activationOwnershipId).toBe(lifecycle.ownershipId);
    const slotAfter = await readPreparationSlot(managed.tenantId, managed.attempt.id);
    expect(slotAfter.preparationClaimId).toBe(slotBefore.preparationClaimId);
    expect(slotAfter.preparationCount).toBe(slotBefore.preparationCount);
  });

  it("A05-T02 / N03-T3：started 已到但 ACK 丢失，同源重投只返回原回执且不复活执行", async () => {
    const fixture = await seedIntentFixture();
    const { tenantId, invocation, binding, attempt } = fixture;
    const stub = await startIntentRuntimeStub({
      tenantId,
      invocationId: invocation.id,
      capabilitiesDigest: fixture.capabilitiesDigest,
    });
    externalRuntimeStubs.push(stub);

    stub.deliverStarted = true;
    const initial = await startRuntimeInvocation({
      tenantId,
      invocation,
      binding,
      attempt,
      sourceOperationKey: `invocation:${invocation.id}`,
      preparationClaim: await attemptPreparationClaimForTest(attempt.id),
      ...intentTransport(stub),
    });
    const anchorDigest = protocolDigest({ anchor: "a05-t02" });
    await ingressRuntimeEvents({
      tenantId,
      invocationId: invocation.id,
      batch: {
        protocolVersion: PROTOCOL_VERSION,
        authority: initial.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "2",
            type: "execution.suspended",
            schemaVersion: 1,
            payload: { reason: "a05-t02", resumeAnchorDigest: anchorDigest },
          },
        ],
      },
    });

    const resumeKey = `command:${randomUUID()}`;
    const resumed = await resumeRuntimeInvocation({
      tenantId,
      invocation,
      binding,
      attempt,
      sourceOperationKey: resumeKey,
      anchor: "a05-t02",
      anchorDigest,
      ...intentTransport(stub),
    });
    // 恢复已 active/executing。
    expect(await countIngressEvents(invocation.id, "execution.started")).toBe(2);
    const sessionsAfterResume = await getRuntimeSessionBindingsByInvocation(
      tenantId,
      invocation.id,
    );
    expect(sessionsAfterResume).toHaveLength(2);
    const resumedSession = sessionsAfterResume.find((row) => row.intentType === "resume");
    if (!resumedSession) throw new Error("恢复必须建立 resume Session");
    expect(resumedSession.bindingState).toBe("active");

    // 用同 source/digest 重投：返回原意图结果。
    const replayed = await resumeRuntimeInvocation({
      tenantId,
      invocation,
      binding,
      attempt,
      sourceOperationKey: resumeKey,
      anchor: "a05-t02",
      anchorDigest,
      ...intentTransport(stub),
    });
    // 重投返回原意图的**持久**回执（Session 身份即原 resume Session）。
    expect(replayed.remoteSessionRef).toBe(resumed.remoteSessionRef);
    expect(replayed.remoteExecutionRef).toBe(resumed.remoteExecutionRef);
    // 不新增 Session、不新增代际。
    expect(await getRuntimeSessionBindingsByInvocation(tenantId, invocation.id)).toHaveLength(2);
    expect((await getActiveExecutionOwnership({ tenantId, invocationId: invocation.id }))?.id).toBe(
      resumedSession.ownershipId,
    );
    // 不重复用户任务：稳定幂等键只执行一次，started 不再增加。
    expect(stub.executions.size).toBe(2);
    expect(await countIngressEvents(invocation.id, "execution.started")).toBe(2);
  });

  it("A05-T03 / N05-T4：同源并发只形成一个逻辑 O/S，落败者不清成功方 Lease/Owner", async () => {
    const fixture = await seedIntentFixture();
    const { tenantId, invocation, binding, attempt } = fixture;
    const stub = await startIntentRuntimeStub({
      tenantId,
      invocationId: invocation.id,
      capabilitiesDigest: fixture.capabilitiesDigest,
    });
    externalRuntimeStubs.push(stub);

    stub.deliverStarted = true;
    const initial = await startRuntimeInvocation({
      tenantId,
      invocation,
      binding,
      attempt,
      sourceOperationKey: `invocation:${invocation.id}`,
      preparationClaim: await attemptPreparationClaimForTest(attempt.id),
      ...intentTransport(stub),
    });
    const anchorDigest = protocolDigest({ anchor: "a05-t03" });
    await ingressRuntimeEvents({
      tenantId,
      invocationId: invocation.id,
      batch: {
        protocolVersion: PROTOCOL_VERSION,
        authority: initial.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "2",
            type: "execution.suspended",
            schemaVersion: 1,
            payload: { reason: "a05-t03", resumeAnchorDigest: anchorDigest },
          },
        ],
      },
    });

    const resumeKey = `command:${randomUUID()}`;
    const request = () =>
      resumeRuntimeInvocation({
        tenantId,
        invocation,
        binding,
        attempt,
        sourceOperationKey: resumeKey,
        anchor: "a05-t03",
        anchorDigest,
        ...intentTransport(stub),
      });
    const outcomes = await Promise.allSettled([request(), request()]);
    // 负向控制：数据库唯一冲突**不得**被当成成功，也不得作为业务结论。
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(String(outcome.reason)).not.toContain("Duplicate entry");
      }
    }
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);

    const sessions = await getRuntimeSessionBindingsByInvocation(tenantId, invocation.id);
    const resumeSessions = sessions.filter((row) => row.intentType === "resume");
    expect(resumeSessions).toHaveLength(1);
    expect(sessions).toHaveLength(2);
    const bySource = await getRuntimeSessionBindingBySourceIntent(tenantId, {
      invocationId: invocation.id,
      attemptId: attempt.id,
      intentType: "resume",
      sourceOperationKey: resumeKey,
    });
    expect(bySource?.id).toBe(resumeSessions[0]?.id);
    // 稳定幂等键只执行一次。
    expect(stub.executions.size).toBe(2);
    expect(
      new Set(
        stub.requests
          .filter((entry) => entry.path.endsWith("/resume"))
          .map((e) => e.idempotencyKey),
      ),
    ).toEqual(new Set([`start:${resumeSessions[0]?.ownershipId}`]));

    // 环境维度：同一意图上已有健康准备者时，第二个准备者必须被**明确拒绝**，
    // 且不能改动 Lease（leaseId / operationId 稳定）。
    const managed = await seedIntentFixture({ withEnvironment: true });
    const envRevisionId = managed.binding.environmentDefinitionRevisionId;
    if (!envRevisionId) throw new Error("MANAGED 夹具必须冻结 EnvironmentDefinitionRevision");
    const envAnchor = protocolDigest({ anchor: "a05-t03-env" });
    const intentKey = `resume:${managed.invocation.id}:${managed.attempt.id}`;
    const intentDigest = protocolDigest({
      scope: "environment-reprepare",
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      anchorDigest: envAnchor,
    });
    const lifecycle = await seedPreparedSlotLifecycle({
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      runtimeRevisionId: managed.runtimeRevisionId,
      workspaceBindingId: managed.workspace.id,
      environmentDefinitionRevisionId: envRevisionId,
      recoveryAnchorDigest: envAnchor,
      preparationIntentKey: intentKey,
      preparationRequestDigest: intentDigest,
      preparationClaimId: "claim-previous",
    });
    // 把上一轮完成的槽改成"仍在进行的健康准备"，模拟另一个并发准备者。
    await db
      .update(invocationAttemptTable)
      .set({
        preparationState: "preparing",
        preparationClaimId: "claim-incumbent",
        preparationLeaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(
        and(
          eq(invocationAttemptTable.tenantId, managed.tenantId),
          eq(invocationAttemptTable.id, managed.attempt.id),
        ),
      );
    const leaseBefore = await getEnvironmentLeaseById(managed.tenantId, lifecycle.leaseId);
    await expect(
      claimLeaseReprepareForTest({
        tenantId: managed.tenantId,
        invocationId: managed.invocation.id,
        leaseId: lifecycle.leaseId,
        attemptId: managed.attempt.id,
        sourceOperationKey: intentKey,
        claimId: "claim-challenger",
        recoveryAnchorDigest: envAnchor,
      }),
    ).rejects.toThrow("测试准备领取未成功（busy）");
    const leaseAfter = await getEnvironmentLeaseById(managed.tenantId, lifecycle.leaseId);
    expect(leaseAfter?.id).toBe(leaseBefore?.id);
    expect(leaseAfter?.readinessState).toBe(leaseBefore?.readinessState);
    expect(leaseAfter?.activationOwnershipId).toBe(leaseBefore?.activationOwnershipId);
    expect(
      ((leaseAfter?.resourceManifest as Record<string, unknown> | null)?.operationId ?? null) as
        | string
        | null,
    ).toBe(
      ((leaseBefore?.resourceManifest as Record<string, unknown> | null)?.operationId ?? null) as
        | string
        | null,
    );
  });

  it("A05-T04 / N03-T4/N04-T2：同来源键换摘要零变更拒绝，不改 O/S/Lease", async () => {
    const fixture = await seedIntentFixture();
    const { tenantId, invocation, binding, attempt } = fixture;
    const stub = await startIntentRuntimeStub({
      tenantId,
      invocationId: invocation.id,
      capabilitiesDigest: fixture.capabilitiesDigest,
    });
    externalRuntimeStubs.push(stub);

    stub.deliverStarted = true;
    const initial = await startRuntimeInvocation({
      tenantId,
      invocation,
      binding,
      attempt,
      sourceOperationKey: `invocation:${invocation.id}`,
      preparationClaim: await attemptPreparationClaimForTest(attempt.id),
      ...intentTransport(stub),
    });
    const anchorDigest = protocolDigest({ anchor: "a05-t04-original" });
    await ingressRuntimeEvents({
      tenantId,
      invocationId: invocation.id,
      batch: {
        protocolVersion: PROTOCOL_VERSION,
        authority: initial.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "2",
            type: "execution.suspended",
            schemaVersion: 1,
            payload: { reason: "a05-t04", resumeAnchorDigest: anchorDigest },
          },
        ],
      },
    });

    const resumeKey = `command:${randomUUID()}`;
    await resumeRuntimeInvocation({
      tenantId,
      invocation,
      binding,
      attempt,
      sourceOperationKey: resumeKey,
      anchor: "a05-t04-original",
      anchorDigest,
      ...intentTransport(stub),
    });
    const sessionsBefore = await getRuntimeSessionBindingsByInvocation(tenantId, invocation.id);
    const resumedSession = sessionsBefore.find((row) => row.intentType === "resume");
    if (!resumedSession) throw new Error("恢复必须建立 resume Session");
    const ownerBefore = await getActiveExecutionOwnership({
      tenantId,
      invocationId: invocation.id,
    });

    // 已进入 running 后，新建另一条正式 Resume 命令不能借原暂停重新启动。
    const newCommandId = await db.transaction((tx) =>
      createInvocationCommandInTransaction(tx, {
        tenantId,
        invocationId: invocation.id,
        commandType: "resume",
        idempotencyKey: `running-resume:${randomUUID()}`,
        payloadJson: { resume_source: "user_pause", resume_payload: { source: "user_pause" } },
        requestedByType: "user",
        requestedById: "test-user",
      }),
    );
    const slotBeforeNewCommand = await readPreparationSlot(tenantId, attempt.id);
    const requestsBeforeNewCommand = stub.requests.length;
    await expect(
      resumeRuntimeInvocation({
        tenantId,
        invocation,
        binding,
        attempt,
        sourceOperationKey: `command:${newCommandId}`,
        anchor: "a05-t04-original",
        anchorDigest,
        ...intentTransport(stub),
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });
    expect(await readPreparationSlot(tenantId, attempt.id)).toEqual(slotBeforeNewCommand);
    expect(stub.requests).toHaveLength(requestsBeforeNewCommand);
    expect(await getRuntimeSessionBindingsByInvocation(tenantId, invocation.id)).toEqual(
      sessionsBefore,
    );
    expect(await getActiveExecutionOwnership({ tenantId, invocationId: invocation.id })).toEqual(
      ownerBefore,
    );

    // 保持来源键，替换语义输入（锚点）→ 必须拒绝。
    const changedAnchorDigest = protocolDigest({ anchor: "a05-t04-changed" });
    await expect(
      resumeRuntimeInvocation({
        tenantId,
        invocation,
        binding,
        attempt,
        sourceOperationKey: resumeKey,
        anchor: "a05-t04-changed",
        anchorDigest: changedAnchorDigest,
        ...intentTransport(stub),
      }),
    ).rejects.toThrow("StartIntentConflict");

    const sessionsAfter = await getRuntimeSessionBindingsByInvocation(tenantId, invocation.id);
    expect(sessionsAfter).toHaveLength(sessionsBefore.length);
    const resumedAfter = sessionsAfter.find((row) => row.id === resumedSession.id);
    expect(resumedAfter?.sourceRequestDigest).toBe(resumedSession.sourceRequestDigest);
    expect(resumedAfter?.remoteSessionRef).toBe(resumedSession.remoteSessionRef);
    expect((await getActiveExecutionOwnership({ tenantId, invocationId: invocation.id }))?.id).toBe(
      ownerBefore?.id,
    );

    // 环境维度：同来源意图键换摘要同样必须被拒，且 Lease 完全不动。
    const managed = await seedIntentFixture({ withEnvironment: true });
    const envRevisionId = managed.binding.environmentDefinitionRevisionId;
    if (!envRevisionId) throw new Error("MANAGED 夹具必须冻结 EnvironmentDefinitionRevision");
    const envAnchor = protocolDigest({ anchor: "a05-t04-env" });
    const intentKey = `resume:${managed.invocation.id}:${managed.attempt.id}`;
    const intentDigest = protocolDigest({
      scope: "environment-reprepare",
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      anchorDigest: envAnchor,
    });
    const lifecycle = await seedPreparedSlotLifecycle({
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      runtimeRevisionId: managed.runtimeRevisionId,
      workspaceBindingId: managed.workspace.id,
      environmentDefinitionRevisionId: envRevisionId,
      recoveryAnchorDigest: envAnchor,
      preparationIntentKey: intentKey,
      preparationRequestDigest: intentDigest,
      preparationClaimId: "claim-t04",
    });
    const differentDigest = protocolDigest({
      scope: "environment-reprepare",
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      anchorDigest: protocolDigest({ anchor: "a05-t04-env-changed" }),
    });
    await expect(
      claimLeaseReprepareForTest({
        tenantId: managed.tenantId,
        invocationId: managed.invocation.id,
        leaseId: lifecycle.leaseId,
        attemptId: managed.attempt.id,
        sourceOperationKey: intentKey,
        claimId: "claim-t04-b",
        recoveryAnchorDigest: protocolDigest({ anchor: "a05-t04-env-changed" }),
      }),
    ).rejects.toMatchObject({ name: "InvocationAttemptStateConflictError" });
    const leaseAfter = await getEnvironmentLeaseById(managed.tenantId, lifecycle.leaseId);
    expect(leaseAfter?.readinessState).toBe("ready");
    expect(leaseAfter?.activationOwnershipId).toBe(lifecycle.ownershipId);
    expect(leaseAfter?.preparedDigest).toBe(lifecycle.lease?.preparedDigest);
  });

  it("A05-T05：准备 IO 后进程崩溃 —— 进度是持久事实，接续者按同一稳定 operation 重做同一意图", async () => {
    const managed = await seedIntentFixture({ withEnvironment: true });
    const envRevisionId = managed.binding.environmentDefinitionRevisionId;
    if (!envRevisionId) throw new Error("MANAGED 夹具必须冻结 EnvironmentDefinitionRevision");
    const revision = await getEnvironmentRevisionById(managed.tenantId, envRevisionId);
    if (!revision) throw new Error("EnvironmentRevision 缺失");
    const anchorDigest = protocolDigest({ anchor: "a05-t05" });
    const lease = await seedPreparedEnvironmentLease({
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      revision,
      workspaceBindingId: managed.workspace.id,
      recoveryAnchorDigest: anchorDigest,
    });
    await db
      .update(invocationAttemptTable)
      .set({ preparationClaimId: null, preparationLeaseExpiresAt: null })
      .where(eq(invocationAttemptTable.id, managed.attempt.id));
    const operationIdBefore = (lease.resourceManifest as Record<string, unknown>)
      .operationId as string;
    const intentKey = `resume:${managed.invocation.id}:${managed.attempt.id}`;
    const intentDigest = protocolDigest({
      scope: "environment-reprepare",
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      anchorDigest,
    });

    // 第一个准备者登记准备槽（IO 即将开始）——随后"进程被杀"：本测试不再持有任何内存状态。
    const crashed = await claimLeaseReprepareForTest({
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      leaseId: lease.id,
      attemptId: managed.attempt.id,
      sourceOperationKey: intentKey,
      claimId: "claim-crashed",
      recoveryAnchorDigest: anchorDigest,
    });
    // 崩溃后仍可从库里读到进度（仅内存记录的实现在这里就失败了）：状态 + 来源意图 +
    // 本次 claim + 期限，四项缺一不可 —— 少任何一项，接续者都无法判断"谁在做、为谁做"。
    const crashedSlot = await readPreparationSlot(managed.tenantId, managed.attempt.id);
    expect(crashedSlot.preparationState).toBe("preparing");
    expect(crashedSlot.preparationIntentKey).toBe(intentKey);
    expect(crashedSlot.preparationRequestDigest).toBe(crashed.claim.requestDigest);
    expect(crashedSlot.preparationClaimId).toBe("claim-crashed");
    expect(crashedSlot.preparationLeaseExpiresAt).toBeTruthy();
    // 登记只表示"开始做"：崩溃的这一轮**没有**完成，完成计数不得被虚增（夹具的初始准备
    // 已计 1 次，此处必须仍是 1）。把进行中的一轮记成已完成，就等于用计数谎报进度。
    expect(crashedSlot.preparationCount).toBe(1);

    // 旧 claim 失效（租约过期）→ 正式恢复消费者接续同一稳定意图。
    await db
      .update(invocationAttemptTable)
      .set({ preparationLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(
        and(
          eq(invocationAttemptTable.tenantId, managed.tenantId),
          eq(invocationAttemptTable.id, managed.attempt.id),
        ),
      );
    const resumed = await claimLeaseReprepareForTest({
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      leaseId: lease.id,
      attemptId: managed.attempt.id,
      sourceOperationKey: intentKey,
      claimId: "claim-successor",
      recoveryAnchorDigest: anchorDigest,
    });
    const resumedLease = resumed.lease;
    // 同一份稳定 operation/Lease，不另造无主资源。
    expect(resumedLease.id).toBe(lease.id);
    expect((resumedLease.resourceManifest as Record<string, unknown>).operationId as string).toBe(
      operationIdBefore,
    );
    const successorSlot = await readPreparationSlot(managed.tenantId, managed.attempt.id);
    expect(successorSlot.preparationState).toBe("preparing");
    expect(successorSlot.preparationClaimId).toBe("claim-successor");
    expect(successorSlot.preparationIntentKey).toBe(intentKey);
    expect(successorSlot.preparationCount).toBe(1);
    // 继任者真正做完这一轮（生产时序：准备完成之后由 Start 事务落 Prepared 证据）——
    // 此时完成计数才 +1，证明"计数只跟完成走"这条语义在两个方向上都被守住。
    await markIntentAttemptPrepared(managed.tenantId, managed.attempt.id);
    const completedSlot = await readPreparationSlot(managed.tenantId, managed.attempt.id);
    expect(completedSlot.preparationState).toBe("prepared");
    expect(completedSlot.preparationCount).toBe(2);
  });

  it("A05-T06 / N05-T3：旧 IO 成功但证据提交时 claim 已变化，拒绝且不清继任实例", async () => {
    const managed = await seedIntentFixture({ withEnvironment: true });
    const envRevisionId = managed.binding.environmentDefinitionRevisionId;
    if (!envRevisionId) throw new Error("MANAGED 夹具必须冻结 EnvironmentDefinitionRevision");
    const revision = await getEnvironmentRevisionById(managed.tenantId, envRevisionId);
    if (!revision) throw new Error("EnvironmentRevision 缺失");
    const anchorDigest = protocolDigest({ anchor: "a05-t06" });
    const lease = await seedPreparedEnvironmentLease({
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      revision,
      workspaceBindingId: managed.workspace.id,
      recoveryAnchorDigest: anchorDigest,
    });
    await db
      .update(invocationAttemptTable)
      .set({ preparationClaimId: null, preparationLeaseExpiresAt: null })
      .where(eq(invocationAttemptTable.id, managed.attempt.id));
    const intentKey = `resume:${managed.invocation.id}:${managed.attempt.id}`;
    const intentDigest = protocolDigest({
      scope: "environment-reprepare",
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      anchorDigest,
    });

    // A 登记准备槽后 IO 卡住；claim 失效后 B 领取并完成、激活。
    await claimLeaseReprepareForTest({
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      leaseId: lease.id,
      attemptId: managed.attempt.id,
      sourceOperationKey: intentKey,
      claimId: "claim-A",
      recoveryAnchorDigest: anchorDigest,
    });
    await db
      .update(invocationAttemptTable)
      .set({ preparationLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(
        and(
          eq(invocationAttemptTable.tenantId, managed.tenantId),
          eq(invocationAttemptTable.id, managed.attempt.id),
        ),
      );
    await claimLeaseReprepareForTest({
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      leaseId: lease.id,
      attemptId: managed.attempt.id,
      sourceOperationKey: intentKey,
      claimId: "claim-B",
      recoveryAnchorDigest: anchorDigest,
    });
    const preparedByB = await seedPreparedEnvironmentLease({
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      revision,
      workspaceBindingId: managed.workspace.id,
      lease: (await getEnvironmentLeaseById(managed.tenantId, lease.id)) ?? lease,
      recoveryAnchorDigest: anchorDigest,
    });
    // 生产时序：环境准备完成之后，Start 事务才把 Attempt 标成 prepared（此时 slot 的
    // 来源意图/claim 保留 B 的），执行权才有可能被授出。跳过这一步就不是在验证实现。
    await markIntentAttemptPrepared(managed.tenantId, managed.attempt.id);
    const authority = await acquireTestRuntimeAuthority({
      tenantId: managed.tenantId,
      invocationId: managed.invocation.id,
      attemptId: managed.attempt.id,
      runtimeRevisionId: managed.runtimeRevisionId,
      environmentLeaseId: preparedByB.id,
      recoveryAnchorDigest: anchorDigest,
    });
    await activateSeededEnvironmentLease({
      tenantId: managed.tenantId,
      lease: preparedByB,
      ownershipId: authority.ownership.id,
      recoveryAnchorDigest: anchorDigest,
    });
    const settledByB = await getEnvironmentLeaseById(managed.tenantId, lease.id);
    expect(settledByB?.readinessState).toBe("ready");
    expect(settledByB?.activationOwnershipId).toBe(authority.ownership.id);

    // A 迟到的完成：必须被准备槽 CAS 拒绝，且不写任何证据。
    await expect(
      seedPreparedEnvironmentLease({
        tenantId: managed.tenantId,
        invocationId: managed.invocation.id,
        attemptId: managed.attempt.id,
        revision,
        workspaceBindingId: managed.workspace.id,
        lease: (await getEnvironmentLeaseById(managed.tenantId, lease.id)) ?? lease,
        recoveryAnchorDigest: anchorDigest,
        preparationClaim: {
          tenantId: managed.tenantId,
          invocationId: managed.invocation.id,
          attemptId: managed.attempt.id,
          intentKey,
          requestDigest: intentDigest,
          claimId: "claim-A",
          source: executionSourceForTest({
            tenantId: managed.tenantId,
            invocationId: managed.invocation.id,
            attemptId: managed.attempt.id,
            sourceOperationKey: intentKey,
          }),
        },
      }),
    ).rejects.toMatchObject({ name: "EnvironmentPreparationClaimSupersededError" });

    const afterLateCompletion = await getEnvironmentLeaseById(managed.tenantId, lease.id);
    expect(afterLateCompletion?.readinessState).toBe("ready");
    expect(afterLateCompletion?.activationOwnershipId).toBe(authority.ownership.id);
    expect(afterLateCompletion?.preparedDigest).toBe(settledByB?.preparedDigest);
    expect(afterLateCompletion?.versionNo).toBe(settledByB?.versionNo);
    // 准备槽仍属于 B —— 旧完成既没有把槽写回去，也没有登记任何清理义务。
    // 完成计数 = 夹具的初始准备 1 次 + B 真实做完的 1 次；A 的迟到完成被拒，因此不计。
    const slot = await readPreparationSlot(managed.tenantId, managed.attempt.id);
    expect(slot.preparationClaimId).toBe("claim-B");
    expect(slot.preparationCount).toBe(2);
  });

  it("A05-T07 / N04-T1：旧来源跨轮晚到，在环境/目录变化前拒绝且不改当前执行权", async () => {
    const fixture = await seedIntentFixture();
    const { tenantId, invocation, binding, attempt } = fixture;
    const stub = await startIntentRuntimeStub({
      tenantId,
      invocationId: invocation.id,
      capabilitiesDigest: fixture.capabilitiesDigest,
    });
    externalRuntimeStubs.push(stub);

    stub.deliverStarted = true;
    const initial = await startRuntimeInvocation({
      tenantId,
      invocation,
      binding,
      attempt,
      sourceOperationKey: `invocation:${invocation.id}`,
      preparationClaim: await attemptPreparationClaimForTest(attempt.id),
      ...intentTransport(stub),
    });
    const anchorDigest = protocolDigest({ anchor: "a05-t07" });
    await ingressRuntimeEvents({
      tenantId,
      invocationId: invocation.id,
      batch: {
        protocolVersion: PROTOCOL_VERSION,
        authority: initial.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "2",
            type: "execution.suspended",
            schemaVersion: 1,
            payload: { reason: "a05-t07", resumeAnchorDigest: anchorDigest },
          },
        ],
      },
    });

    const unacceptedKey = `command:${randomUUID()}`;
    const beforeUnaccepted = await readPreparationSlot(tenantId, attempt.id);
    await expect(
      acceptExecutionPreparation({
        request: executionSourceRequestForStart({
          tenantId,
          invocation,
          binding,
          attempt,
          sourceOperationKey: unacceptedKey,
          intentType: "resume",
          recovery: { kind: "resume", anchor: "a05-t07", anchorDigest },
        }),
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });
    expect(await readPreparationSlot(tenantId, attempt.id)).toEqual(beforeUnaccepted);

    const firstResumeKey = `command:${randomUUID()}`;
    // 快来源已取得 O/S，但 execution.started 尚未到：Attempt 仍是 suspended。
    // 慢来源不能借这个窗口把快来源的准备槽和后续 Lease 重新归属。
    stub.deliverStarted = false;
    await resumeRuntimeInvocation({
      tenantId,
      invocation,
      binding,
      attempt,
      sourceOperationKey: firstResumeKey,
      anchor: "a05-t07",
      anchorDigest,
      ...intentTransport(stub),
    });
    const sessionsBefore = await getRuntimeSessionBindingsByInvocation(tenantId, invocation.id);
    const resumedSession = sessionsBefore.find((row) => row.intentType === "resume");
    if (!resumedSession) throw new Error("恢复必须建立 resume Session");
    const ownerBefore = await getActiveExecutionOwnership({
      tenantId,
      invocationId: invocation.id,
    });
    expect(ownerBefore?.id).toBe(resumedSession.ownershipId);
    const startedBefore = await countIngressEvents(invocation.id, "execution.started");
    const slotBefore = await readPreparationSlot(tenantId, attempt.id);
    const lateCommandId = await db.transaction((tx) =>
      createInvocationCommandInTransaction(tx, {
        tenantId,
        invocationId: invocation.id,
        commandType: "resume",
        idempotencyKey: `late-resume:${randomUUID()}`,
        payloadJson: { resume_source: "user_pause", resume_payload: { source: "user_pause" } },
        requestedByType: "user",
        requestedById: "test-user",
      }),
    );
    await expect(
      acceptExecutionPreparation({
        request: executionSourceRequestForStart({
          tenantId,
          invocation,
          binding,
          attempt,
          sourceOperationKey: `command:${lateCommandId}`,
          intentType: "resume",
          recovery: { kind: "resume", anchor: "a05-t07", anchorDigest },
        }),
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });
    expect(await readPreparationSlot(tenantId, attempt.id)).toEqual(slotBefore);
    const competingKey = `command:${randomUUID()}`;
    await seedTestResumeCommand({
      tenantId,
      invocationId: invocation.id,
      sourceOperationKey: competingKey,
    });
    await expect(
      acceptExecutionPreparation({
        request: executionSourceRequestForStart({
          tenantId,
          invocation,
          binding,
          attempt,
          sourceOperationKey: competingKey,
          intentType: "resume",
          recovery: { kind: "resume", anchor: "a05-t07", anchorDigest },
        }),
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });
    expect(await readPreparationSlot(tenantId, attempt.id)).toEqual(slotBefore);

    // 另一个来源意图的恢复请求：当前健康 Owner 不属于它 → 拒绝，不改写执行权。
    await expect(
      resumeRuntimeInvocation({
        tenantId,
        invocation,
        binding,
        attempt,
        sourceOperationKey: competingKey,
        anchor: "a05-t07",
        anchorDigest,
        ...intentTransport(stub),
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });

    const sessionsAfter = await getRuntimeSessionBindingsByInvocation(tenantId, invocation.id);
    expect(sessionsAfter).toHaveLength(sessionsBefore.length);
    const resumedAfter = sessionsAfter.find((row) => row.id === resumedSession.id);
    expect(resumedAfter?.sourceOperationKey).toBe(firstResumeKey);
    expect(resumedAfter?.bindingState).toBe(resumedSession.bindingState);
    const ownerAfter = await getActiveExecutionOwnership({ tenantId, invocationId: invocation.id });
    expect(ownerAfter?.id).toBe(ownerBefore?.id);
    expect(ownerAfter?.ownershipState).toBe("active");
    expect(await countIngressEvents(invocation.id, "execution.started")).toBe(startedBefore);
    expect(stub.executions.size).toBe(2);
  });
});

describe("N02：Attempt 准备领取贯穿成功、失败与换手", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  async function seedClaimFixture() {
    const fixture = await seedIntentFixture();
    await db
      .update(invocationAttemptTable)
      .set({
        preparationState: "pending",
        preparationEvidence: null,
        preparationDigest: null,
        preparedAt: null,
        preparationIntentKey: null,
        preparationRequestDigest: null,
        preparationSourceJson: null,
        preparationClaimId: null,
        preparationLeaseExpiresAt: null,
        preparationCount: 0,
      })
      .where(eq(invocationAttemptTable.id, fixture.attempt.id));
    return fixture;
  }

  function preparationInput(
    fixture: Awaited<ReturnType<typeof seedClaimFixture>>,
    claimId: string,
  ) {
    const intentKey = `invocation:${fixture.invocation.id}`;
    return {
      source: {
        ...executionSourceRequestForStart({
          tenantId: fixture.tenantId,
          invocation: fixture.invocation,
          binding: fixture.binding,
          attempt: fixture.attempt,
          sourceOperationKey: intentKey,
        }),
        predecessor: null,
      },
      claimId,
    };
  }

  it("N02-T2: 准备进程崩溃后只接管同一候选，不靠无限租约或新建 Attempt", async () => {
    const fixture = await seedClaimFixture();
    const first = await claimAttemptPreparation(preparationInput(fixture, randomUUID()));
    expect(first.disposition).toBe("claimed");
    await db
      .update(invocationAttemptTable)
      .set({ preparationLeaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(invocationAttemptTable.id, fixture.attempt.id));
    const second = await claimAttemptPreparation(preparationInput(fixture, randomUUID()));
    expect(second.disposition).toBe("claimed");
    expect(second.attempt.id).toBe(fixture.attempt.id);
    expect(second.attempt.preparationCount).toBe(0);
  });

  it("N02-T1: Prepared 进度仍由健康 claim 排他，过期 nonce 不能续领", async () => {
    const fixture = await seedClaimFixture();
    const first = await claimAttemptPreparation(preparationInput(fixture, randomUUID()));
    if (!first.claim) throw new Error("W1 未取得准备 claim");
    const evidence = { kind: "prepared-exclusive", attemptId: fixture.attempt.id };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: fixture.attempt.id,
        evidence,
        digest: protocolDigest(evidence),
        preparationClaim: first.claim!,
      }),
    );
    const competing = await claimAttemptPreparation(preparationInput(fixture, randomUUID()));
    expect(competing.disposition).toBe("busy");
    expect(competing.attempt.preparationClaimId).toBe(first.claim.claimId);
    expect(competing.attempt.preparationState).toBe("prepared");

    await db
      .update(invocationAttemptTable)
      .set({ preparationLeaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(invocationAttemptTable.id, fixture.attempt.id));
    const stale = await claimAttemptPreparation(preparationInput(fixture, first.claim.claimId));
    expect(stale.disposition).toBe("busy");
    const successor = await claimAttemptPreparation(preparationInput(fixture, randomUUID()));
    expect(successor.disposition).toBe("claimed");
    expect(successor.attempt.preparationState).toBe("prepared");
    expect(successor.attempt.preparationDigest).toBe(protocolDigest(evidence));
  });

  it("N02-T1/N02-T3/N02-T4: 旧 claim 的普通失败和成功迟到均不能污染已运行继任代际", async () => {
    const fixture = await seedClaimFixture();
    const first = await claimAttemptPreparation(preparationInput(fixture, randomUUID()));
    if (!first.claim) throw new Error("W1 未取得准备 claim");
    await db
      .update(invocationAttemptTable)
      .set({ preparationLeaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(invocationAttemptTable.id, fixture.attempt.id));
    const second = await claimAttemptPreparation(preparationInput(fixture, randomUUID()));
    if (!second.claim) throw new Error("W2 未接管准备 claim");
    const evidence = { kind: "topic02-successor", attemptId: fixture.attempt.id };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: fixture.attempt.id,
        evidence,
        digest: protocolDigest(evidence),
        preparationClaim: second.claim!,
      }),
    );
    const generation = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      activationEvidence: { kind: "topic02-successor-active" },
    });
    await db.transaction((tx) => updateAttemptState(tx, fixture.attempt.id, "running"));

    await expect(
      db.transaction((tx) =>
        markAttemptPreparedInTransaction(tx, {
          attemptId: fixture.attempt.id,
          evidence: { kind: "late-w1-success" },
          digest: protocolDigest({ kind: "late-w1-success" }),
          preparationClaim: first.claim!,
        }),
      ),
    ).rejects.toThrow("PreparationClaimSuperseded");
    await expect(
      failAttemptAndInvokeRecoveryAuthority({
        tenantId: fixture.tenantId,
        attempt: fixture.attempt,
        invocation: fixture.invocation,
        errorCode: "LatePlainIoError",
        errorSummary: "W1 returned after W2 was running",
        now: new Date(),
        workIdentity: { kind: "preparation", claim: first.claim },
      }),
    ).rejects.toThrow("PreparationClaimSuperseded");

    expect((await getAttemptById(fixture.attempt.id))?.attemptState).toBe("running");
    expect(
      (
        await getActiveExecutionOwnership({
          tenantId: fixture.tenantId,
          invocationId: fixture.invocation.id,
        })
      )?.id,
    ).toBe(generation.ownership.id);
    expect(
      (await getRuntimeSessionBindingById(fixture.tenantId, generation.session.id))?.bindingState,
    ).toBe("prepared");
  });

  it("N02-T4 / R1-c: 新领取事务持有根锁时，旧失败提交必须等待并在换手后零写入", async () => {
    const fixture = await seedClaimFixture();
    const first = await claimAttemptPreparation(preparationInput(fixture, randomUUID()));
    if (!first.claim) throw new Error("W1 未取得准备 claim");
    await db
      .update(invocationAttemptTable)
      .set({ preparationLeaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(invocationAttemptTable.id, fixture.attempt.id));

    let releaseW2!: () => void;
    const holdW2 = new Promise<void>((resolve) => {
      releaseW2 = resolve;
    });
    let reportW2!: (claim: NonNullable<typeof first.claim>) => void;
    const w2Claimed = new Promise<NonNullable<typeof first.claim>>((resolve) => {
      reportW2 = resolve;
    });
    const secondInput = preparationInput(fixture, randomUUID());
    const secondTransaction = db.transaction(async (tx) => {
      await tx
        .select({ id: invocationTable.id })
        .from(invocationTable)
        .where(eq(invocationTable.id, fixture.invocation.id))
        .for("update");
      const second = await claimAttemptPreparationInTransaction(tx, secondInput);
      if (!second.claim) throw new Error(`W2 未接管准备 claim：${second.disposition}`);
      reportW2(second.claim);
      await holdW2;
      return second.claim;
    });
    try {
      const secondClaim = await w2Claimed;
      const oldFailure = failAttemptAndInvokeRecoveryAuthority({
        tenantId: fixture.tenantId,
        attempt: fixture.attempt,
        invocation: fixture.invocation,
        errorCode: "LatePlainIoError",
        errorSummary: "W1 旧普通失败在 W2 事务期间提交",
        now: new Date(),
        workIdentity: { kind: "preparation", claim: first.claim },
      });
      const whileLocked = await Promise.race([
        oldFailure.then(
          () => "settled",
          () => "settled",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
      ]);
      expect(whileLocked).toBe("waiting");
      releaseW2();
      expect((await secondTransaction).claimId).toBe(secondClaim.claimId);
      await expect(oldFailure).rejects.toThrow("PreparationClaimSuperseded");
      const after = await getAttemptById(fixture.attempt.id);
      expect(after?.attemptState).not.toBe("failed");
      expect(after?.preparationClaimId).toBe(secondClaim.claimId);
      expect(after?.preparationState).toBe("preparing");
    } finally {
      releaseW2();
      await secondTransaction;
    }
  });

  it("N02-T3: 旧准备真实 IO 成功晚到后仅清理独占候选，不改继任代际", async () => {
    const fixture = await seedClaimFixture();
    const root = await mkdtemp(path.join(tmpdir(), "snow-n02-late-prepare-"));
    try {
      const broker = createWorkspaceHostBroker({ root });
      const first = await claimAttemptPreparation(preparationInput(fixture, randomUUID()));
      if (!first.claim) throw new Error("W1 未取得准备 claim");
      let releaseOldIo!: () => void;
      const holdOldIo = new Promise<void>((resolve) => {
        releaseOldIo = resolve;
      });
      let signalPhysicalReady!: (value: Awaited<ReturnType<typeof broker.prepare>>) => void;
      const physicalReady = new Promise<Awaited<ReturnType<typeof broker.prepare>>>((resolve) => {
        signalPhysicalReady = resolve;
      });
      const oldIo = broker
        .prepare({
          candidateAttemptId: fixture.attempt.id,
          revisionId: fixture.binding.runtimeRevisionId,
          workspaceBindingId: fixture.binding.workspaceBindingId,
          operationId: `old-prepare:${randomUUID()}`,
        })
        .then(async (prepared) => {
          signalPhysicalReady(prepared);
          await holdOldIo;
          return prepared;
        });
      try {
        const oldPhysical = await physicalReady;
        await expect(stat(oldPhysical.candidateRoot)).resolves.toBeTruthy();
        await db
          .update(invocationAttemptTable)
          .set({ preparationLeaseExpiresAt: new Date(Date.now() - 1) })
          .where(eq(invocationAttemptTable.id, fixture.attempt.id));
        const second = await claimAttemptPreparation(preparationInput(fixture, randomUUID()));
        if (!second.claim) throw new Error("W2 未接管准备 claim");
        const successor = await broker.prepare({
          candidateAttemptId: fixture.attempt.id,
          revisionId: fixture.binding.runtimeRevisionId,
          workspaceBindingId: fixture.binding.workspaceBindingId,
          operationId: `new-prepare:${randomUUID()}`,
        });
        const evidence = {
          kind: "candidate-prepared",
          resourceId: successor.resourceId,
          candidateRoot: successor.candidateRoot,
        };
        await db.transaction((tx) =>
          markAttemptPreparedInTransaction(tx, {
            attemptId: fixture.attempt.id,
            evidence,
            digest: protocolDigest(evidence),
            preparationClaim: second.claim!,
          }),
        );
        const active = await acquireTestRuntimeAuthority({
          tenantId: fixture.tenantId,
          invocationId: fixture.invocation.id,
          attemptId: fixture.attempt.id,
          runtimeRevisionId: fixture.binding.runtimeRevisionId,
        });
        releaseOldIo();
        const lateSuccess = await oldIo;
        await expect(
          db.transaction((tx) =>
            markAttemptPreparedInTransaction(tx, {
              attemptId: fixture.attempt.id,
              evidence: { kind: "late-old-io", resourceId: lateSuccess.resourceId },
              digest: protocolDigest({ kind: "late-old-io", resourceId: lateSuccess.resourceId }),
              preparationClaim: first.claim!,
            }),
          ),
        ).rejects.toThrow("PreparationClaimSuperseded");
        await cleanupWorkspaceCandidate(broker, lateSuccess);
        await expect(stat(lateSuccess.candidateRoot)).rejects.toThrow();
        await expect(stat(successor.candidateRoot)).resolves.toBeTruthy();
        expect((await getAttemptById(fixture.attempt.id))?.preparationDigest).toBe(
          protocolDigest(evidence),
        );
        expect(
          (
            await getActiveExecutionOwnership({
              tenantId: fixture.tenantId,
              invocationId: fixture.invocation.id,
            })
          )?.id,
        ).toBe(active.ownership.id);
      } finally {
        releaseOldIo();
        await oldIo;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("R1-b: 旧准备 claim 不得沿继任者已建的 Session 继续派发", async () => {
    const fixture = await seedClaimFixture();
    const first = await claimAttemptPreparation(preparationInput(fixture, randomUUID()));
    if (!first.claim) throw new Error("W1 未取得准备 claim");
    await db
      .update(invocationAttemptTable)
      .set({ preparationLeaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(invocationAttemptTable.id, fixture.attempt.id));
    const second = await claimAttemptPreparation(preparationInput(fixture, randomUUID()));
    if (!second.claim) throw new Error("W2 未接管准备 claim");
    const evidence = { kind: "r1-b-successor", attemptId: fixture.attempt.id };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: fixture.attempt.id,
        evidence,
        digest: protocolDigest(evidence),
        preparationClaim: second.claim!,
      }),
    );
    const generation = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const before = await readPreparationSlot(fixture.tenantId, fixture.attempt.id);
    await expect(
      acceptExecutionPreparation({
        request: executionSourceRequestForStart({
          tenantId: fixture.tenantId,
          invocation: fixture.invocation,
          binding: fixture.binding,
          attempt: fixture.attempt,
          sourceOperationKey: `invocation:${fixture.invocation.id}`,
        }),
        claimId: first.claim.claimId,
      }),
    ).rejects.toThrow("PreparationClaimSuperseded");
    expect(await readPreparationSlot(fixture.tenantId, fixture.attempt.id)).toEqual(before);
    expect(
      (
        await getActiveExecutionOwnership({
          tenantId: fixture.tenantId,
          invocationId: fixture.invocation.id,
        })
      )?.id,
    ).toBe(generation.ownership.id);
    expect(
      (await getRuntimeSessionBindingById(fixture.tenantId, generation.session.id))?.bindingState,
    ).toBe("prepared");
  });
});
