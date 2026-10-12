/**
 * A06：检查点默认入口、远程 RPC 与恢复目录必须端到端对齐。
 *
 * 审查报告（cceffbb3）的 A06 指出六个关联阻断点，其中最要紧的是"默认路径串不起来"——
 * 组件单独看都能跑，但**默认组合层**到不了它们：
 *
 * 1. 默认命令网关不装配 Workspace（`endpoint.workspace` 恒 `undefined`）→ `WorkspaceNotReady`；
 * 2. 远程 Broker 的 `snapshot()` 无条件抛"不承接 in-process SnapshotStorage"，RPC 清单里也没有它；
 * 3. Remote restore 把带方法的 `SnapshotStorage` 实例放进 JSON 请求；
 * 4. Remote `releaseFreeze` 发 `{receipt}`、服务端把包装对象当 receipt 用 —— 目标安全点从未解冻；
 * 5. Remote `cleanup` 发 `{preparation}`，清理目标错位；
 * 6. 默认恢复落到 `prepare()` 建的 `controlRoot/candidates/...`，而 `activateWriter`
 *    明确拒绝控制面目录作 Writer root —— 即使快照恢复成功，随后也无法激活。
 *
 * 本文件验证**默认主链**（不是"手选目录的组件行为"）：
 *
 *   `takeRecoverablePauseCheckpoint`（默认 dispatch → 默认命令网关）
 *     → 生产组合层按部署配置解析受管 Workspace（真实远端 Broker，真实 RPC）
 *     → Runtime 安全点（真实 HTTP 对端）
 *     → 真实内容寻址快照落盘
 *     → Backend 真实解冻 + Gate 回 open
 *     → `runtime-start` 用**恢复目录**（受管运行区）恢复并真实激活 Writer
 *
 * 端口边界自身（可序列化契约 / 目录归属）由 `workspace-host-rpc-contract.test.ts` 覆盖。
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveGenericUserAction } from "@/lib/conversations/user-action-resolve-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createEnvironmentDefinition,
  getEnvironmentRevisionById,
} from "@/lib/environment/environment-definition-store";
import { activateEnvironmentLease } from "@/lib/environment/environment-lease-store";
import type { EnvironmentRevisionInput } from "@/lib/environment/environment-revision";
import { seedPreparedEnvironmentLease } from "@/lib/environment/test-support/seed-prepared-environment-lease";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
import {
  assertExecutionSourceSnapshot,
  executionSourceDigest,
  executionSourceRequestOf,
} from "@/lib/executions/domain/preparation-source";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { getActiveExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { TEST_EXECUTION_BINDING_EVIDENCE } from "@/lib/executions/test-support/create-unverified-execution-binding";
import { markAttemptPreparedForTestInTransaction } from "@/lib/executions/test-support/preparation-fixtures";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { environmentLeaseTable } from "@/lib/persistence/schema/environment";
import {
  executionBindingTable,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationCommandTable,
  invocationTable,
  runtimeEventIngressTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { filesystemCheckpointTable } from "@/lib/persistence/schema/filesystem-checkpoint";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { acceptExecutionPreparation } from "@/lib/runtime/application/execution-preparation";
import { resolveExecutionResources } from "@/lib/runtime/application/execution-resources";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import {
  executionSourceRequestForStart,
  startRuntimeInvocation,
} from "@/lib/runtime/application/runtime-start";
import {
  dispatchResumeCommandToRuntime,
  retryDispatchedCommandToRuntime,
} from "@/lib/runtime/command-dispatch-gateway";
import { acceptResumeCommandPreparation } from "@/lib/runtime/command-dispatcher";
import {
  dockerInfo,
  inspectImage,
  listContainersByLabel,
  removeContainer,
} from "@/lib/runtime/container/docker-cli";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
import { claimInvocationCommandDispatch } from "@/lib/runtime/retry/dispatch-retry-queries";
import { createRuntimeDispatchRetryWorker } from "@/lib/runtime/retry/runtime-dispatch-retry-worker";
import { createHttpRuntimeClient } from "@/lib/runtime/runtime-client";
import {
  PROTOCOL_VERSION,
  type RuntimeEventType,
  type RuntimeStartRequest,
  RuntimeStartRequestSchema,
  protocolDigest,
} from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import { takeRecoverablePauseCheckpoint } from "@/lib/workspace/checkpoint-pause";
import { runCheckpointMaintenanceLane } from "@/lib/workspace/checkpoint-release";
import { restoreFilesystemCheckpoint } from "@/lib/workspace/checkpoint-restore";
import {
  getFilesystemCheckpoint,
  listFilesystemCheckpoints,
} from "@/lib/workspace/checkpoint-store";
import {
  type RecoveryAnchorDeclarations,
  computeRecoveryAnchorDigest,
  parseRecoveryAnchor,
} from "@/lib/workspace/recovery-anchor";
import { FileSnapshotStorage } from "@/lib/workspace/snapshot-storage";
import { createWorkspaceBackend } from "@/lib/workspace/workspace-backend";
import { computeWorkspaceContractDigest } from "@/lib/workspace/workspace-contract";
import {
  createRemoteWorkspaceHost,
  createWorkspaceHostBroker,
  listenWorkspaceHostRpc,
} from "@/lib/workspace/workspace-host-server";
import { createWorkspace, createWorkspaceBinding } from "@/lib/workspace/workspace-queries";
import {
  activatePreparedWorkspaceWriter,
  prepareWorkspaceCandidate,
} from "@/lib/workspace/workspace-writer";
import { and, asc, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TENANT_ID = "00000000-0000-4000-8000-000000000000";
const RUNTIME_CAPABILITIES_JSON = ["event_stream"];

const filesystemSemantics = {
  kind: "portable",
  caseSensitive: true,
  symlinks: true,
  permissions: true,
  hardlinks: false,
  specialFiles: false,
  xattrsAcl: false,
  mtime: "preserved",
} as const;

const checkpointPolicy = {
  safePointTimeoutSeconds: 120,
  chunkBytes: 4_194_304,
  maxTotalBytes: "10737418240",
  maxEntries: 100_000,
  trigger: "before_suspend_and_explicit",
  retention: "retain_while_referenced",
};

// ─── Runtime 对端（真实 HTTP server）──────────────────────────

interface CheckpointRuntimeStub {
  readonly endpoint: string;
  readonly safePointRequests: Array<{ checkpointIntentId: string; idempotencyKey: string }>;
  readonly releaseRequests: Array<{
    checkpointIntentId: string;
    path: string;
    idempotencyKey: string;
  }>;
  readonly resumeRequests: RuntimeStartRequest[];
  readonly resumeIdempotencyKeys: string[];
  setCapabilitiesDigest(value: string): void;
  setReleaseFailure(value: boolean): void;
  /** 让**下一次** Resume 接纳完成后切断连接：Runtime 已接纳，但回执永远到不了平台。 */
  dropNextResumeResponse(): void;
  dispose(): Promise<void>;
}

async function startCheckpointRuntimeStub(): Promise<CheckpointRuntimeStub> {
  const safePointRequests: Array<{ checkpointIntentId: string; idempotencyKey: string }> = [];
  const releaseRequests: Array<{
    checkpointIntentId: string;
    path: string;
    idempotencyKey: string;
  }> = [];
  const resumeRequests: RuntimeStartRequest[] = [];
  const resumeIdempotencyKeys: string[] = [];
  let capabilitiesDigest = "";
  let dropNextResume = false;
  let releaseFailure = false;
  const server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "";
      const idempotencyKey = request.headers["idempotency-key"];
      const safePoint = /^\/runtime\/invocations\/[^/]+\/safe-points$/.test(url);
      const release = /^\/runtime\/invocations\/[^/]+\/safe-points\/([^/]+)\/release$/.exec(url);
      const resume = /^\/runtime\/invocations\/[^/]+\/resume$/.test(url);
      if (request.method !== "POST" || (!safePoint && !release && !resume)) {
        respondJson(response, 404, { error: { code: "RUNTIME_ROUTE_NOT_FOUND", message: url } });
        return;
      }
      if (typeof idempotencyKey !== "string" || !idempotencyKey) {
        respondJson(response, 400, {
          error: { code: "REQUEST_SCHEMA_INVALID", message: "idempotency key missing" },
        });
        return;
      }
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      if (safePoint) {
        const checkpointIntentId = String(body.checkpointIntentId);
        safePointRequests.push({ checkpointIntentId, idempotencyKey });
        // 安全点回执只提供"已到安全点、Writer 已排空"的证据；Checkpoint 本身由平台提交。
        respondJson(response, 200, {
          accepted: true,
          checkpointIntentId,
          safePointEvidenceDigest: protocolDigest({ safePoint: checkpointIntentId }),
          writerQuiescenceAchievedAt: Date.now(),
        });
        return;
      }
      if (release) {
        releaseRequests.push({ checkpointIntentId: release[1]!, path: url, idempotencyKey });
        if (releaseFailure) {
          respondJson(response, 503, {
            error: { code: "RUNTIME_RELEASE_UNAVAILABLE", message: "simulated release failure" },
          });
          return;
        }
        respondJson(response, 200, { released: true });
        return;
      }
      const parsed = RuntimeStartRequestSchema.parse(body);
      resumeRequests.push(parsed);
      resumeIdempotencyKeys.push(idempotencyKey);
      if (dropNextResume) {
        // 接纳事实已经产生（请求内容已记录），但回执在网络上丢失：平台侧只能看到一次可重试的传输失败。
        dropNextResume = false;
        request.socket.destroy();
        return;
      }
      const remoteSessionRef = `stub-session:${parsed.authority.sessionBindingId}`;
      const remoteExecutionRef = `stub-execution:${parsed.authority.ownershipId}`;
      respondJson(response, 202, {
        protocolVersion: PROTOCOL_VERSION,
        authority: parsed.authority,
        semanticRequestDigest: parsed.semanticRequestDigest,
        accepted: true,
        remoteSessionRef,
        remoteExecutionRef,
        capabilitiesDigest,
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
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    safePointRequests,
    releaseRequests,
    resumeRequests,
    resumeIdempotencyKeys,
    setCapabilitiesDigest(value: string) {
      capabilitiesDigest = value;
    },
    setReleaseFailure(value: boolean) {
      releaseFailure = value;
    },
    dropNextResumeResponse() {
      dropNextResume = true;
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
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readGate(invocationId: string) {
  const [invocation] = await db
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, TENANT_ID), eq(invocationTable.id, invocationId)))
    .limit(1);
  return invocation ?? null;
}

// ─── 夹具 ───────────────────────────────────────────────────

/**
 * 逐条复核 `lockCheckpointFacts` 的守卫事实。
 *
 * 它抛的是裸 `CheckpointStale`（生产语义正确，但**无法定位**是哪一条不成立）。
 * 用例在调用默认入口前先自查同样这几条，把不透明失败变成"夹具缺了哪条事实"。
 * 顺序与 `lockCheckpointFacts` 一致，便于对照。
 */
async function assertCheckpointGateFacts(ctx: DefaultPathContext): Promise<void> {
  const [attempt] = await db
    .select()
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, TENANT_ID),
        eq(invocationAttemptTable.id, ctx.attemptId),
        eq(invocationAttemptTable.invocationId, ctx.invocationId),
      ),
    )
    .limit(1);
  const [binding] = await db
    .select()
    .from(executionBindingTable)
    .where(
      and(
        eq(executionBindingTable.tenantId, TENANT_ID),
        eq(executionBindingTable.invocationId, ctx.invocationId),
      ),
    )
    .limit(1);
  const [owner] = await db
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, TENANT_ID),
        eq(executionOwnershipTable.id, ctx.ownershipId),
      ),
    )
    .limit(1);
  const [session] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, TENANT_ID),
        eq(runtimeSessionBindingTable.ownershipId, ctx.ownershipId),
      ),
    )
    .limit(1);
  const [lease] = owner?.environmentLeaseId
    ? await db
        .select()
        .from(environmentLeaseTable)
        .where(
          and(
            eq(environmentLeaseTable.tenantId, TENANT_ID),
            eq(environmentLeaseTable.id, owner.environmentLeaseId),
          ),
        )
        .limit(1)
    : [];

  const checks: Array<[string, boolean]> = [
    ["attempt 存在", Boolean(attempt)],
    ["binding 存在", Boolean(binding)],
    ["binding.environmentMode === MANAGED", binding?.environmentMode === "MANAGED"],
    [
      "binding.environmentDefinitionRevisionId 非空",
      Boolean(binding?.environmentDefinitionRevisionId),
    ],
    ["owner.workspaceWriterGeneration 非 null", owner?.workspaceWriterGeneration !== null],
    ["session 存在", Boolean(session)],
    ["session.invocationId 匹配", session?.invocationId === ctx.invocationId],
    ["session.attemptId 匹配", session?.attemptId === ctx.attemptId],
    ["session.leaseEpoch 匹配 owner", session?.leaseEpoch === owner?.leaseEpoch],
    [
      "session.runtimeRevisionId 匹配 binding",
      session?.runtimeRevisionId === binding?.runtimeRevisionId,
    ],
    ["session.bindingState === active", session?.bindingState === "active"],
    ["environmentLease 存在", Boolean(lease)],
    [
      "lease.environmentDefinitionRevisionId 匹配 binding",
      lease?.environmentDefinitionRevisionId === binding?.environmentDefinitionRevisionId,
    ],
    ["lease.leaseState === active", lease?.leaseState === "active"],
    ["lease.readinessState === ready", lease?.readinessState === "ready"],
    ["lease.activationOwnershipId 匹配 owner", lease?.activationOwnershipId === owner?.id],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
  if (failed.length > 0) {
    throw new Error(
      `Checkpoint 前置事实不满足（lockCheckpointFacts 会抛 CheckpointStale）：${failed.join("；")}\n` +
        `owner=${JSON.stringify({
          id: owner?.id,
          executionPhase: owner?.executionPhase,
          ownershipState: owner?.ownershipState,
          workspaceWriterGeneration: owner?.workspaceWriterGeneration,
          environmentLeaseId: owner?.environmentLeaseId,
          leaseEpoch: owner?.leaseEpoch,
        })}\n` +
        `binding=${JSON.stringify({
          environmentMode: binding?.environmentMode,
          environmentDefinitionRevisionId: binding?.environmentDefinitionRevisionId,
          runtimeRevisionId: binding?.runtimeRevisionId,
          workspaceBindingId: binding?.workspaceBindingId,
        })}\n` +
        `session=${JSON.stringify({
          id: session?.id,
          bindingState: session?.bindingState,
          runtimeRevisionId: session?.runtimeRevisionId,
          leaseEpoch: session?.leaseEpoch,
          invocationId: session?.invocationId,
          attemptId: session?.attemptId,
        })}\n` +
        `lease=${JSON.stringify({
          id: lease?.id,
          leaseState: lease?.leaseState,
          readinessState: lease?.readinessState,
          activationOwnershipId: lease?.activationOwnershipId,
          environmentDefinitionRevisionId: lease?.environmentDefinitionRevisionId,
        })}`,
    );
  }
}

interface DefaultPathContext {
  baseRoot: string;
  /** 运行根（Writer root）：Binding 冻结的 locationRef。 */
  writerRoot: string;
  hostRoot: string;
  /** 控制面根（realpath 后的 `<hostRoot>/.snow`）。 */
  controlRoot: string;
  storageRoot: string;
  brokerStorageRoot: string;
  scopeDigest: string;
  workspaceBindingId: string;
  environmentRevisionId: string;
  runtimeRevisionId: string;
  invocationId: string;
  attemptId: string;
  ownershipId: string;
  authority: {
    invocationId: string;
    runtimeRevisionId: string;
    attemptId: string;
    ownershipId: string;
    leaseEpoch: string;
    sessionBindingId: string;
  };
  stub: CheckpointRuntimeStub;
}

/** 受管环境容器标签：与本模块实例登记口径一致（清理用）。 */
const ENVIRONMENT_TENANT_LABEL = "snow-harness.environment.tenantId";

/** 本地优先镜像候选（与 A05 / R07 合规验收同一口径，不允许静默跳过）。 */
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

let dockerReady = false;
let resolvedImage: string | null = null;
let resolvedImageDigest = "";

/**
 * 受管容器 Revision：与 A05 同口径。
 *
 * 刻意不用 host_agent —— 该后端诚实声明 `processIsolation=false`，任何要求进程隔离的
 * 策略都会 fail closed（`environment-instance-backend.ts` 的 host_agent 探针是硬编码），
 * 因此"真受管"只能在 container Runtime 上成立。
 */
function containerRevisionInput(): EnvironmentRevisionInput {
  if (!resolvedImage) {
    throw new Error(
      `A06 默认路径验收需要本地具备候选镜像之一：${IMAGE_CANDIDATES.join(", ")}（不允许静默跳过）。`,
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
    createdByType: "service",
    createdById: "test-service",
  };
}

/**
 * 恢复运行根清单。
 *
 * 只统计 `workspace-<digest>` 目录：同级的控制面候选目录（`<operationId>`）与恢复状态旁文件
 * （`*.restore-state.json`）都是生产既有的控制事实，不属于"第二份恢复目录"。
 * T07 要证的是**恢复只落一份运行根**，不是"目录里只能有一个文件"。
 */
async function readRestoredRunRoots(runsDir: string): Promise<string[]> {
  return (await readdir(runsDir)).filter(
    (name) =>
      name.startsWith("workspace-") &&
      !name.endsWith(".staging") &&
      !name.endsWith(".restore-state.json"),
  );
}

async function findRestoredRunRoot(writerRoot: string, attemptId: string): Promise<string> {
  const runsDir = path.join(await realpath(writerRoot), ".snow-runs", attemptId);
  const restored = await readRestoredRunRoots(runsDir);
  if (restored.length !== 1) {
    throw new Error(`期望唯一恢复运行根，实际为 ${restored.length} 个`);
  }
  return path.join(runsDir, restored[0]!);
}

describe("Checkpoint 默认端到端路径（A06）", () => {
  let temporaryRoots: string[] = [];
  const envKeys = [
    "SNOWHARNESS_WORKSPACE_HOST_URL",
    "SNOWHARNESS_WORKSPACE_HOST_ROOT",
    "SNOWHARNESS_SNAPSHOT_STORAGE_ROOT",
    "SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT",
    "RUNTIME_DEFAULT",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();
  const stubs: CheckpointRuntimeStub[] = [];
  let rpc: Awaited<ReturnType<typeof listenWorkspaceHostRpc>> | null = null;

  beforeAll(async () => {
    dockerReady = await dockerInfo();
    if (!dockerReady) return;
    for (const candidate of IMAGE_CANDIDATES) {
      const inspected = await inspectImage(candidate);
      if (inspected) {
        resolvedImage = candidate;
        resolvedImageDigest = inspected.Id;
        return;
      }
    }
  });

  afterAll(async () => {
    if (!dockerReady) return;
    for (const name of await listContainersByLabel(ENVIRONMENT_TENANT_LABEL, TENANT_ID)) {
      await removeContainer(name);
    }
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
    temporaryRoots = [];
    stubs.length = 0;
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
  });

  afterEach(async () => {
    for (const stub of stubs.splice(0)) await stub.dispose();
    await rpc?.close();
    rpc = null;
    for (const key of envKeys) {
      const value = savedEnv.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
    temporaryRoots = [];
  });

  /**
   * 建立"真实受管 Workspace + 真实远端 Broker + 真实 Runtime 对端"的默认组合事实。
   *
   * 关键点：**不注入**任何 WorkspaceBackend / Runtime client 覆盖 —— 生产组合层
   * 只能靠部署配置（env）解析，env 就是真实部署形态。
   */
  async function setupDefaultPathContext(): Promise<DefaultPathContext> {
    const base = await mkdtemp(path.join(tmpdir(), "a06-default-path-"));
    temporaryRoots.push(base);
    const writerRoot = path.join(base, "writer");
    const hostRoot = path.join(base, "host");
    const storageRoot = path.join(base, "snapshot-storage");
    const brokerStorageRoot = path.join(base, "broker-default-storage");
    await mkdir(writerRoot, { recursive: true });
    await mkdir(hostRoot, { recursive: true });
    // 受管环境实例的状态登记根：生产由部署配置给出，这里指向本用例的临时目录，
    // 避免跨用例/跨轮次共用同一份 registry。
    const environmentControlRoot = path.join(base, "environment-control");
    await mkdir(environmentControlRoot, { recursive: true });
    process.env.SNOWHARNESS_ENVIRONMENT_CONTROL_ROOT = environmentControlRoot;
    // 平台部署事实：受管 Environment 的真实实例化只在 container Runtime 上成立。
    // Docker 与候选镜像缺失时直接失败，不静默跳过、不降级 host。
    if (!dockerReady) {
      throw new Error("A06 默认路径验收需要真实 docker（`docker info` 退出 0）。");
    }
    process.env.RUNTIME_DEFAULT = "container";

    // Broker 自己持有默认存储：用于证明跨控制端口传 `file` 引用时，真实 IO 落在
    // **引用指向的根**，而不是恰好回退到 Broker 的默认存储（那会让"持久快照"看起来通过）。
    const broker = createWorkspaceHostBroker({
      root: hostRoot,
      managedRoot: writerRoot,
      snapshotStorage: new FileSnapshotStorage(brokerStorageRoot),
    });
    const probe = await broker.probeIdentity();
    rpc = await listenWorkspaceHostRpc({ broker });
    // 部署事实：受管 Workspace Host 是独立进程，经 RPC 访问。
    process.env.SNOWHARNESS_WORKSPACE_HOST_URL = rpc.url;
    Reflect.deleteProperty(process.env, "SNOWHARNESS_WORKSPACE_HOST_ROOT");
    process.env.SNOWHARNESS_SNAPSHOT_STORAGE_ROOT = storageRoot;

    const logicalWorkspace = await createWorkspace({
      tenantId: TENANT_ID,
      workspaceKey: `a06-workspace-${randomUUID()}`,
      displayName: "A06 default path",
    });
    // 远端 Host 没有"本地根"概念：运行根就是 Binding 冻结的 locationRef。
    const workspace = await createWorkspaceBinding({
      tenantId: TENANT_ID,
      workspaceId: logicalWorkspace.id,
      continuityMode: "CHECKPOINT_RESTORABLE",
      bindingType: "remote",
      locationRef: writerRoot,
      storageScopeDigest: probe.scopeDigest,
      backendKind: "managed_host",
      hostIdentity: probe.hostIdentity,
      storageIdentity: probe.storageIdentity,
      accessMode: "read_write",
      filesystemSemantics,
      checkpointPolicy,
      contractDigest: computeWorkspaceContractDigest({
        bindingId: "a06-fixture",
        continuityMode: "CHECKPOINT_RESTORABLE",
        storageScopeDigest: probe.scopeDigest,
        backendKind: "managed_host",
        hostIdentity: probe.hostIdentity,
        storageIdentity: probe.storageIdentity,
        filesystemSemantics,
        checkpointPolicy,
      }),
      createdBy: "test-service",
    });
    const environment = await createEnvironmentDefinition({
      tenantId: TENANT_ID,
      environmentKey: `a06-environment-${randomUUID()}`,
      displayName: "A06 environment",
      revision: containerRevisionInput(),
    });
    const environmentRevision = await getEnvironmentRevisionById(
      TENANT_ID,
      environment.currentRevisionId!,
    );
    if (!environmentRevision) throw new Error("EnvironmentDefinitionRevision fixture missing");

    // Runtime：真实 external_endpoint（安全点 / 释放 / resume 都经真实 HTTP）。
    const stub = await startCheckpointRuntimeStub();
    stubs.push(stub);
    const runtimeId = randomUUID();
    const runtimeRevisionId = randomUUID();
    const digest = protocolDigest({ runtimeId, runtimeRevisionId, fixture: "a06-default-path" });
    await db.insert(runtimeTable).values({
      id: runtimeId,
      tenantId: TENANT_ID,
      runtimeKey: `a06-runtime-${runtimeId}`,
      displayName: "A06 external runtime",
      runtimeKind: "external",
      ownerUserId: "test-user",
      lifecycleState: "enabled",
      currentRevisionId: runtimeRevisionId,
      versionNo: 1,
    });
    await db.insert(runtimeRevisionTable).values({
      id: runtimeRevisionId,
      tenantId: TENANT_ID,
      runtimeId,
      revisionNo: 1,
      protocolType: "harness_runtime_protocol",
      protocolVersion: PROTOCOL_VERSION,
      protocolContractDigest: digest,
      runtimeEvidenceKind: "external_endpoint",
      runtimeTargetDigest: digest,
      endpointRef: stub.endpoint,
      runtimeArtifactRef: null,
      artifactId: null,
      artifactDigest: null,
      runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
      identityMode: "none",
      networkZone: "external",
      configHash: digest,
      credentialRefId: null,
      revisionState: "published",
      createdBy: "test-service",
    });
    // 回执摘要必须等于发布事实（否则 runtime-start 以 RUNTIME_CAPABILITY_MISMATCH fail closed）。
    stub.setCapabilitiesDigest(
      expectedCapabilityManifestDigest({
        runtimeRevisionId,
        runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
      }),
    );

    const fixture = await seedPreparedRuntimeAttempt({
      tenantId: TENANT_ID,
      workspaceBinding: workspace,
      environmentDefinitionRevisionId: environmentRevision.id,
      runtimeRevisionId,
      controlPlaneEvidence: {
        ...TEST_EXECUTION_BINDING_EVIDENCE,
        runtimeEvidenceKind: "external_endpoint",
        runtimeArtifactId: null,
        runtimeArtifactDigest: null,
        runtimeConfigDigest: digest,
        runtimeTargetDigest: digest,
        capabilityManifestDigest: expectedCapabilityManifestDigest({
          runtimeRevisionId,
          runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
        }),
      },
    });
    const lease = await seedPreparedEnvironmentLease({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      revision: environmentRevision,
      workspaceBindingId: workspace.id,
    });
    // 生产时序：Start 在派发前固定激活证据，executionPhase 仍是 `dispatching`；
    // 只有 Runtime 的 `execution.started` 被真实 ingress 接纳，phase 才推到 `executing`。
    // 这里不手写 phase —— 手写会绕过 applyLifecycle，等于把"已启动"当成夹具自述。
    const acquired = await acquireTestRuntimeAuthority({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId,
      environmentLeaseId: lease.id,
      runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
    });
    // Writer 经**真实远端 Host** 激活：prepare / activateWriter / getWriter 全走 RPC。
    const backend = createWorkspaceBackend(createRemoteWorkspaceHost(rpc.url));
    const candidate = await prepareWorkspaceCandidate({
      attemptId: fixture.attempt.id,
      binding: workspace,
      backend,
      root: workspace.locationRef!,
      operationId: `a06-writer:${fixture.attempt.id}`,
      runtimeRevisionId,
    });
    if (!candidate) throw new Error("Workspace candidate missing");
    const activated = await activatePreparedWorkspaceWriter({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      ownership: acquired.ownership,
      authority: acquired.authority,
      candidate,
    });
    const activationEvidence = {
      kind: "a06-activation",
      writerGeneration: activated.writerGeneration,
      grantRef: activated.grant.grantRef,
    };
    await db
      .update(executionOwnershipTable)
      .set({
        workspaceWriterGeneration: activated.writerGeneration,
        activationEvidence,
        activationDigest: protocolDigest(activationEvidence),
        activatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(executionOwnershipTable.id, acquired.ownership.id));
    await activateEnvironmentLease({
      tenantId: TENANT_ID,
      leaseId: lease.id,
      ownershipId: acquired.ownership.id,
      attemptId: fixture.attempt.id,
      invocationId: fixture.invocation.id,
      environmentDefinitionRevisionId: environmentRevision.id,
      recoveryAnchorDigest: null,
    });

    // Session 走**生产单向转换**：prepared → dispatching（带语义请求 + 远端引用 + 传输回执），
    // 再由真实 `execution.started` ingress 推到 `active`。Checkpoint 的 Gate 前置事实
    // （`session.bindingState === "active"`）只有这样才成立；直接 UPDATE 成 active 会绕过转换表。
    const semanticRequest = { fixture: "a06-default-path", invocationId: fixture.invocation.id };
    const semanticRequestDigest = protocolDigest(semanticRequest);
    const remoteSessionRef = `a06-session:${acquired.session.id}`;
    const remoteExecutionRef = `a06-execution:${fixture.invocation.id}`;
    const capabilitiesDigest = expectedCapabilityManifestDigest({
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
    });
    await applyRuntimeSessionDispatchForTest(TENANT_ID, acquired.session.id, {
      bindingState: "dispatching",
      semanticRequestJson: semanticRequest,
      semanticRequestDigest,
      remoteSessionRef,
      remoteExecutionRef,
      transportAcknowledgement: { capabilitiesDigest },
    });
    const ingress = await ingressRuntimeEvents({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      batch: {
        protocolVersion: 3,
        authority: acquired.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "1",
            type: "execution.started",
            schemaVersion: 1,
            payload: {
              intentKey: acquired.session.startIntentKey,
              semanticRequestDigest,
              remoteSessionRef,
              remoteExecutionRef,
              capabilitiesDigest,
            },
          },
        ],
      },
    });
    if (ingress.receipts.length !== 1) {
      throw new Error(`execution.started 未被接纳：${JSON.stringify(ingress)}`);
    }

    return {
      baseRoot: base,
      writerRoot: workspace.locationRef!,
      hostRoot,
      controlRoot: path.join(await realpath(hostRoot), ".snow"),
      storageRoot,
      brokerStorageRoot,
      scopeDigest: probe.scopeDigest,
      workspaceBindingId: workspace.id,
      environmentRevisionId: environmentRevision.id,
      runtimeRevisionId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      ownershipId: acquired.ownership.id,
      authority: acquired.authority,
      stub,
    };
  }

  it("A06-01: 默认 Checkpoint 命令在真实远端 Broker 上完成 quiescing → 持久快照 → 真实解冻 → Gate 回 open", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "checkpoint payload", "utf8");

    await assertCheckpointGateFacts(ctx);

    // 默认入口：request + 默认 dispatch（生产网关，无任何 Resolver 注入）。
    const outcome = await takeRecoverablePauseCheckpoint({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      requestedById: "test-service",
    });
    // ①：装配层不再 WorkspaceNotReady；②③④：远端真的收到了安全点与释放。
    expect(outcome).toMatchObject({ requested: true, dispatched: true });
    expect(outcome.dispatchReason).toBeUndefined();
    expect(ctx.stub.safePointRequests).toHaveLength(1);
    expect(ctx.stub.releaseRequests).toHaveLength(1);
    const checkpointIntentId = outcome.checkpointIntentId!;
    expect(ctx.stub.safePointRequests[0]?.checkpointIntentId).toBe(checkpointIntentId);
    expect(ctx.stub.releaseRequests[0]?.checkpointIntentId).toBe(checkpointIntentId);
    // 释放走的是 `/safe-points/<intentId>/release`，不是别的安全点。
    expect(ctx.stub.releaseRequests[0]?.path).toContain(
      `/safe-points/${checkpointIntentId}/release`,
    );

    // 命令收口为 acknowledged（不是留在 dispatched 被维护 lane 反复领取）。
    const [command] = await db
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, TENANT_ID),
          eq(invocationCommandTable.id, outcome.commandId!),
        ),
      )
      .limit(1);
    expect(command?.commandState).toBe("acknowledged");

    // 持久 Checkpoint：证据来自真实扫描，manifestRef 指向**引用**给定的存储根。
    const gate = await readGate(ctx.invocationId);
    expect(gate?.checkpointGate).toBe("open");
    const checkpoint = gate?.checkpointPreparedEvidence as { checkpointId?: string } | null;
    expect(checkpoint?.checkpointId).toBeTruthy();
    const row = await getFilesystemCheckpoint(TENANT_ID, checkpoint!.checkpointId!);
    expect(row).not.toBeNull();
    expect(row?.invocationId).toBe(ctx.invocationId);
    expect(row?.workspaceBindingId).toBe(ctx.workspaceBindingId);
    expect(row?.fileCount).toBeGreaterThan(0);
    expect(await listFilesystemCheckpoints(TENANT_ID, ctx.invocationId)).toHaveLength(1);
    const anchor = parseRecoveryAnchor(row?.recoveryAnchor);
    expect(anchor).not.toBeNull();
    expect(row?.recoveryAnchorDigest).toBe(computeRecoveryAnchorDigest(anchor!));
    expect(row?.recoveryAnchorDigest).toBe(
      (row?.storageEvidence as { freeze: { anchorDigest: string } }).freeze.anchorDigest,
    );
    const manifest = await new FileSnapshotStorage(ctx.storageRoot).readManifest(
      row!.manifestRef,
      row!.manifestDigest,
    );
    expect(manifest.contentRootDigest).toBe(row?.contentRootDigest);
    expect(manifest.entries.some((entry) => entry.path === "state.txt")).toBe(true);
    // 快照真的落在 `SNOWHARNESS_SNAPSHOT_STORAGE_ROOT` 指向的根里……
    await expect(readFile(path.join(ctx.storageRoot, row!.manifestRef), "utf8")).resolves.toContain(
      "state.txt",
    );
    // ……而不是恰好回退到 Broker 自己的默认存储。
    await expect(
      readFile(path.join(ctx.brokerStorageRoot, row!.manifestRef), "utf8"),
    ).rejects.toThrow();
  });

  it("N06-T7: Checkpoint 已提交但 release/命令 ACK 未收口时，正式重投返回原对象并续做原释放", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "checkpoint replay payload", "utf8");
    await assertCheckpointGateFacts(ctx);
    ctx.stub.setReleaseFailure(true);
    const first = await takeRecoverablePauseCheckpoint({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      requestedById: "test-service",
    });
    expect(first).toMatchObject({ requested: true, dispatched: true });
    const commandId = first.commandId!;
    const intentId = first.checkpointIntentId!;
    const afterFirst = await readGate(ctx.invocationId);
    const evidence = afterFirst?.checkpointPreparedEvidence as {
      checkpointId?: string;
      release?: { runtime?: string; backend?: string };
    } | null;
    expect(evidence?.checkpointId).toBeTruthy();
    expect(evidence?.release).toMatchObject({ runtime: "pending", backend: "confirmed" });
    expect(afterFirst?.checkpointGate).toBe("releasing");
    expect(ctx.stub.safePointRequests).toHaveLength(1);

    // 模拟持久 Checkpoint/释放事实已经提交，而命令 ACK 尾部随进程退出丢失。
    await db
      .update(invocationCommandTable)
      .set({
        commandState: "queued",
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        nextDispatchAt: new Date(0),
        completedAt: null,
        receiptJson: null,
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where(eq(invocationCommandTable.id, commandId));
    ctx.stub.setReleaseFailure(false);
    const replay = await retryDispatchedCommandToRuntime({ tenantId: TENANT_ID, commandId });
    expect(replay.dispatched).toBe(true);
    if (!replay.dispatched) throw new Error("Checkpoint 重投未被正式网关接纳");
    expect(replay.command.commandState).toBe("acknowledged");
    expect(replay.command.response).toMatchObject({
      checkpoint: {
        checkpointId: evidence?.checkpointId,
      },
      replayed: true,
    });
    expect(ctx.stub.safePointRequests).toHaveLength(1);
    expect(ctx.stub.releaseRequests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ctx.stub.releaseRequests.map((request) => request.checkpointIntentId))).toEqual(
      new Set([intentId]),
    );
    const rows = await db
      .select({ id: filesystemCheckpointTable.id })
      .from(filesystemCheckpointTable)
      .where(eq(filesystemCheckpointTable.invocationId, ctx.invocationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(evidence?.checkpointId);
    expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("open");
  });

  it("N06-T4: Runtime release 首次失败后，正式维护 lane 向原目标重发同键并开放 Gate", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "release retry", "utf8");
    await assertCheckpointGateFacts(ctx);
    ctx.stub.setReleaseFailure(true);
    const initial = await takeRecoverablePauseCheckpoint({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      requestedById: "test-service",
    });
    expect(initial.dispatched).toBe(true);
    const intentId = initial.checkpointIntentId!;
    const pending = await readGate(ctx.invocationId);
    expect(pending?.checkpointGate).toBe("releasing");
    expect(pending?.checkpointPreparedEvidence).toMatchObject({
      release: { runtime: "pending", backend: "confirmed" },
    });
    expect(ctx.stub.releaseRequests).toHaveLength(1);
    const originalRequest = ctx.stub.releaseRequests[0]!;
    expect(originalRequest).toMatchObject({
      checkpointIntentId: intentId,
      idempotencyKey: `checkpoint-release:${intentId}`,
    });

    ctx.stub.setReleaseFailure(false);
    const maintenance = await runCheckpointMaintenanceLane({
      now: new Date(pending!.updatedAt.getTime() + 1),
      graceMs: 0,
    });
    expect(maintenance.releases.failures).toEqual([]);
    expect(maintenance.releases.examined).toBeGreaterThanOrEqual(1);
    expect(maintenance.releases.awaitingRuntime).toBe(0);
    expect(maintenance.releases.gateOpened).toBe(1);
    expect(ctx.stub.releaseRequests).toHaveLength(2);
    expect(ctx.stub.releaseRequests[1]).toEqual(originalRequest);
    const settled = await readGate(ctx.invocationId);
    expect(settled?.checkpointGate).toBe("open");
    expect(settled?.checkpointPreparedEvidence).toMatchObject({
      release: { runtime: "confirmed", backend: "confirmed" },
    });
    const owner = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    expect(owner?.id).toBe(ctx.ownershipId);
  });

  it("R5-f: 旧意图释放后新安全点成功，已提交新命令重投不重复建对象且写入恢复", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "first checkpoint", "utf8");
    await assertCheckpointGateFacts(ctx);
    const first = await runDefaultCheckpoint(ctx);
    expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("open");

    await writeFile(path.join(ctx.writerRoot, "state.txt"), "second checkpoint", "utf8");
    const second = await takeRecoverablePauseCheckpoint({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      requestedById: "test-service",
    });
    expect(second.dispatched).toBe(true);
    expect(second.checkpointIntentId).not.toBe(first.checkpoint.checkpointIntentId);
    const pending = await readGate(ctx.invocationId);
    const secondEvidence = pending?.checkpointPreparedEvidence as { checkpointId?: string } | null;
    expect(secondEvidence?.checkpointId).toBeTruthy();
    expect(secondEvidence?.checkpointId).not.toBe(first.checkpointId);
    expect(pending?.checkpointGate).toBe("open");
    expect(ctx.stub.safePointRequests).toHaveLength(2);
    expect(ctx.stub.releaseRequests).toHaveLength(2);

    await db
      .update(invocationCommandTable)
      .set({
        commandState: "queued",
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        nextDispatchAt: new Date(0),
        completedAt: null,
        receiptJson: null,
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where(eq(invocationCommandTable.id, second.commandId!));
    const replay = await retryDispatchedCommandToRuntime({
      tenantId: TENANT_ID,
      commandId: second.commandId!,
    });
    expect(replay.dispatched).toBe(true);
    if (!replay.dispatched) throw new Error("新 Checkpoint 命令重投失败");
    expect(replay.command.response).toMatchObject({
      checkpoint: { checkpointId: secondEvidence?.checkpointId },
      replayed: true,
    });
    expect((await readGate(ctx.invocationId))?.checkpointGate).toBe("open");
    expect(ctx.stub.safePointRequests).toHaveLength(2);
    expect(ctx.stub.releaseRequests).toHaveLength(2);
    const checkpoints = await db
      .select({ id: filesystemCheckpointTable.id })
      .from(filesystemCheckpointTable)
      .where(eq(filesystemCheckpointTable.invocationId, ctx.invocationId));
    expect(new Set(checkpoints.map((row) => row.id))).toEqual(
      new Set([first.checkpointId, secondEvidence?.checkpointId]),
    );

    const [owner] = await db
      .select()
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.id, ctx.ownershipId))
      .limit(1);
    if (!owner?.workspaceWriterGeneration) throw new Error("Writer generation 缺失");
    const remote = createRemoteWorkspaceHost(rpc!.url);
    const grant = await remote.getWriter(ctx.scopeDigest, owner.workspaceWriterGeneration);
    if (!grant) throw new Error("Writer grant 缺失");
    await remote.executeManagedFileOperation({
      identity: {
        tenantId: TENANT_ID,
        scopeDigest: grant.scopeDigest,
        writerGeneration: grant.writerGeneration,
        invocationId: grant.invocationId,
        attemptId: grant.attemptId,
        ownershipId: grant.ownershipId,
        operationId: grant.operationId,
      },
      operation: { kind: "write", path: "after-second-checkpoint.txt", content: "writable" },
    });
    expect(await readFile(path.join(grant.root, "after-second-checkpoint.txt"), "utf8")).toBe(
      "writable",
    );
  });

  it("A06-02: runtime-start 用恢复目录激活 Writer —— 候选运行区在受管根内、内容真实恢复", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "restore me", "utf8");
    await assertCheckpointGateFacts(ctx);
    const outcome = await takeRecoverablePauseCheckpoint({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      requestedById: "test-service",
    });
    expect(outcome.dispatched).toBe(true);
    const checkpoint = (await readGate(ctx.invocationId))?.checkpointPreparedEvidence as {
      checkpointId: string;
      anchorDigest: string;
    };
    expect(checkpoint.checkpointId).toBeTruthy();

    // 原运行目录内容永久丢失（受管存储卷本身仍在）：只有 Checkpoint 能把它带回来。
    await rm(path.join(ctx.writerRoot, "state.txt"), { force: true });
    await expect(readFile(path.join(ctx.writerRoot, "state.txt"), "utf8")).rejects.toThrow();

    // 新代际：新 Attempt（已 Prepared）+ 新 EnvironmentLease（绑本次恢复锚点）。
    const anchor = `checkpoint:${checkpoint.checkpointId}`;
    const anchorDigest = protocolDigest(anchor);
    const nextAttempt = await createAttempt({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      retryReasonCode: "checkpoint_restore",
    });
    const bindingRow = (await db
      .select()
      .from(executionBindingTable)
      .where(eq(executionBindingTable.invocationId, ctx.invocationId))
      .limit(1))![0]!;
    const invocation = (await readGate(ctx.invocationId))!;
    const sourceOperationKey = `checkpoint-restore:${checkpoint.checkpointId}`;
    const accepted = await acceptExecutionPreparation({
      request: executionSourceRequestForStart({
        tenantId: TENANT_ID,
        invocation,
        binding: bindingRow,
        attempt: nextAttempt,
        sourceOperationKey,
        intentType: "resume",
        recovery: { kind: "resume", anchor, anchorDigest, checkpointId: checkpoint.checkpointId },
      }),
    });
    if (accepted.disposition !== "claimed") throw new Error("A06 Resume 准备领取失败");
    const nextLease = await seedPreparedEnvironmentLease({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      attemptId: nextAttempt.id,
      revision: (await getEnvironmentRevisionById(TENANT_ID, ctx.environmentRevisionId))!,
      workspaceBindingId: ctx.workspaceBindingId,
      recoveryAnchorDigest: anchorDigest,
      preparationClaim: accepted.claim,
    });

    // 生产组合层解析执行资源（与请求内联调度同源，无测试覆盖）。
    const resources = await resolveExecutionResources({
      tenantId: TENANT_ID,
      binding: bindingRow,
      purpose: "resume",
    });
    expect(resources.workspace).toBeTruthy();
    expect(resources.workspace?.binding.id).toBe(ctx.workspaceBindingId);

    const started = await startRuntimeInvocation({
      tenantId: TENANT_ID,
      // A05：本次恢复的来源意图（生产由命令网关按已持久命令身份给出；
      // 夹具直接调 Start，用 Invocation 自身身份，仍是稳定值）。
      sourceOperationKey,
      invocation,
      binding: bindingRow,
      attempt: nextAttempt,
      runtimeClient: createHttpRuntimeClient(),
      runtimeEndpoint: ctx.stub.endpoint,
      auth: { mode: "none" },
      callbackEndpoints: buildGatewayEndpoints({ external: true, invocationId: ctx.invocationId }),
      environmentLeaseId: nextLease.id,
      environmentProvisioner: null,
      workspace: resources.workspace!,
      intentType: "resume",
      recovery: {
        kind: "resume",
        anchor,
        anchorDigest,
        checkpointId: checkpoint.checkpointId,
      },
      preparationClaim: accepted.claim,
    });
    // 远端收到的就是本次恢复锚点（不是重新算的另一个）。
    expect(ctx.stub.resumeRequests).toHaveLength(1);
    expect(ctx.stub.resumeRequests[0]?.recovery).toMatchObject({ kind: "resume", anchorDigest });

    // ⑥：恢复目录 = `prepare()` 给出的候选运行目录，落在受管写根内、控制面外。
    const canonicalExpected = await findRestoredRunRoot(ctx.writerRoot, nextAttempt.id);
    expect(await readFile(path.join(canonicalExpected, "state.txt"), "utf8")).toBe("restore me");
    expect(canonicalExpected.startsWith(`${ctx.controlRoot}${path.sep}`)).toBe(false);

    // Writer 真实激活到恢复目录（旧实现会以"Writer root 不能是控制面目录"拒绝）。
    const owner = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    expect(owner?.id).toBe(started.authority.ownershipId);
    const activationEvidence = owner?.activationEvidence as {
      workspace?: { mode?: string; writerGeneration?: number; grantRef?: string };
    };
    expect(activationEvidence?.workspace?.mode).toBe("CHECKPOINT_RESTORABLE");
    const remote = createRemoteWorkspaceHost(process.env.SNOWHARNESS_WORKSPACE_HOST_URL!);
    const grant = await remote.getWriter(
      ctx.scopeDigest,
      activationEvidence!.workspace!.writerGeneration!,
    );
    expect(grant?.grantRef).toBe(activationEvidence!.workspace!.grantRef);
    // 激活的写根就是恢复目录本身（同一物理路径），不是另一个同内容目录。
    expect(await realpath(grant!.root)).toBe(canonicalExpected);
    // 恢复出的目录就是可写运行根：Broker 认账（真实回读，不是自报）。
    await remote.assertWriter(grant!);

    // 执行权交替后，旧代际不再持有执行权（同一 Invocation 只有一个 Current Owner）。
    const [previous] = await db
      .select()
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.id, ctx.ownershipId))
      .limit(1);
    expect(previous?.ownershipState).not.toBe("active");
  });

  // ─── A06 场景夹具（T02–T08 共用）──────────────────────────────

  /** Invocation 的正式水位事实：对象版本 / 事件序号 / 恢复内容水位必须分开断言。 */
  async function readInvocationFacts(invocationId: string) {
    const invocation = await readGate(invocationId);
    if (!invocation) throw new Error(`Invocation 缺失: ${invocationId}`);
    return invocation;
  }

  async function readAttemptFacts(attemptId: string) {
    const [attempt] = await db
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.id, attemptId))
      .limit(1);
    if (!attempt) throw new Error(`Attempt 缺失: ${attemptId}`);
    return attempt;
  }

  /** 某正式事件类型被真实 Ingress 接纳的次数（"只有一次暂停效果"的持久证据）。 */
  async function countIngressEvents(invocationId: string, candidateType: string): Promise<number> {
    const rows = await db
      .select({ id: runtimeEventIngressTable.id })
      .from(runtimeEventIngressTable)
      .where(
        and(
          eq(runtimeEventIngressTable.tenantId, TENANT_ID),
          eq(runtimeEventIngressTable.invocationId, invocationId),
          eq(runtimeEventIngressTable.candidateType, candidateType),
        ),
      );
    return rows.length;
  }

  /**
   * 经**真实 Ingress** 接纳一批 Runtime 事件。
   *
   * `producerSequence` 从 `lastProducerSequence + 1` 起算：Ingress 对跳号 fail-closed，
   * 序号只能由当前正式账本推出，不能由用例编造。`sequenceOffset` 只服务于"故意制造跳号"
   * 的用例（用于验证半程故障整体回滚），不改变其它调用点的连续性。
   */
  async function ingestRuntimeBatch(
    ctx: DefaultPathContext,
    events: Array<{ type: RuntimeEventType; payload?: Record<string, unknown> }>,
    options: {
      sequenceOffset?: (index: number) => number;
      /** 恢复代际的 Ingress 权威（暂停后旧代际已失效，必须用 Runtime 实际持有的那一份）。 */
      authority?: DefaultPathContext["authority"];
    } = {},
  ) {
    const current = await readInvocationFacts(ctx.invocationId);
    const built = events.map((event, index) => ({
      eventId: randomUUID(),
      producerSequence: String(
        current.lastProducerSequence + 1n + BigInt(index + (options.sequenceOffset?.(index) ?? 0)),
      ),
      type: event.type,
      schemaVersion: 1,
      payload: event.payload ?? {},
    }));
    const result = await ingressRuntimeEvents({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      batch: { protocolVersion: 3, authority: options.authority ?? ctx.authority, events: built },
    });
    return { ...result, events: built };
  }

  /** 走**默认入口**取一次持久 Checkpoint：默认 dispatch → 生产命令网关（不注入任何 Resolver）。 */
  async function runDefaultCheckpoint(
    ctx: DefaultPathContext,
    declarations?: RecoveryAnchorDeclarations,
  ) {
    const outcome = await takeRecoverablePauseCheckpoint({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      requestedById: "test-service",
      ...(declarations ? { declarations } : {}),
    });
    if (!outcome.dispatched) throw new Error(`默认 Checkpoint 未派发：${JSON.stringify(outcome)}`);
    const invocation = await readInvocationFacts(ctx.invocationId);
    const evidence = invocation.checkpointPreparedEvidence as { checkpointId?: string } | null;
    const checkpointId = evidence?.checkpointId;
    if (!checkpointId) throw new Error("默认 Checkpoint 未提交持久快照");
    const checkpoint = await getFilesystemCheckpoint(TENANT_ID, checkpointId);
    if (!checkpoint) throw new Error(`Checkpoint 行缺失：${checkpointId}`);
    return { outcome, checkpointId, checkpoint, invocation };
  }

  /**
   * 走**真实恢复路径**（`restoreFilesystemCheckpoint`，与 `runtime-start` 同一实现）。
   *
   * 期望值默认取当前正式事实；用例只在明确验证"换了引用必须被拒"时才覆盖单项。
   */
  function restoreCheckpoint(
    ctx: DefaultPathContext,
    input: {
      checkpointId: string;
      destination: string;
      invocationId?: string;
      workspaceBindingId?: string;
      environmentDefinitionRevisionId?: string;
      recoveryVersion?: number;
    },
  ) {
    return readInvocationFacts(ctx.invocationId).then((current) =>
      restoreFilesystemCheckpoint({
        tenantId: TENANT_ID,
        checkpointId: input.checkpointId,
        destination: input.destination,
        storage: { kind: "file", root: ctx.storageRoot },
        backend: createWorkspaceBackend(createRemoteWorkspaceHost(rpc!.url)),
        expected: {
          invocationId: input.invocationId ?? ctx.invocationId,
          workspaceBindingId: input.workspaceBindingId ?? ctx.workspaceBindingId,
          environmentDefinitionRevisionId:
            input.environmentDefinitionRevisionId ?? ctx.environmentRevisionId,
          recoveryVersion: input.recoveryVersion ?? current.recoveryVersion,
        },
      }),
    );
  }

  /** 暂停的合法控制事实：引用刚提交的 Checkpoint，形状与 Runtime 自报一致。 */
  function suspendedEvent(
    checkpointId: string,
    resumeAnchorDigest: string,
  ): { type: RuntimeEventType; payload: Record<string, unknown> } {
    return { type: "execution.suspended", payload: { checkpointId, resumeAnchorDigest } };
  }

  async function writeCheckpointAnchor(
    checkpointId: string,
    anchor: unknown,
    recoveryAnchorDigest: string,
  ): Promise<void> {
    await db
      .update(filesystemCheckpointTable)
      .set({ recoveryAnchor: anchor, recoveryAnchorDigest })
      .where(eq(filesystemCheckpointTable.id, checkpointId));
  }

  /**
   * 建立恢复所需的"下一代际"：新 Attempt（已 Prepared）+ 新 EnvironmentLease（绑本次恢复锚点）。
   *
   * 与 A06-02 同一构造：恢复的输入是**已持久**的 Checkpoint 身份与锚点，
   * 不是用例自己拼的路径；`start()` 走真实 `startRuntimeInvocation`，
   * 失败时的候选目录清理由生产实现负责。
   */
  async function prepareResumeGeneration(
    ctx: DefaultPathContext,
    checkpoint: { checkpointId: string },
  ) {
    const anchor = `checkpoint:${checkpoint.checkpointId}`;
    const anchorDigest = protocolDigest(anchor);
    const attempt = await createAttempt({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      retryReasonCode: "checkpoint_restore",
    });
    const bindingRow = (
      await db
        .select()
        .from(executionBindingTable)
        .where(eq(executionBindingTable.invocationId, ctx.invocationId))
        .limit(1)
    )[0];
    if (!bindingRow) throw new Error("ExecutionBinding 缺失");
    const invocation = await readInvocationFacts(ctx.invocationId);
    const sourceOperationKey = `checkpoint-restore:${checkpoint.checkpointId}`;
    const accepted = await acceptExecutionPreparation({
      request: executionSourceRequestForStart({
        tenantId: TENANT_ID,
        invocation,
        binding: bindingRow,
        attempt,
        sourceOperationKey,
        intentType: "resume",
        recovery: { kind: "resume", anchor, anchorDigest, checkpointId: checkpoint.checkpointId },
      }),
    });
    if (accepted.disposition !== "claimed") throw new Error("A06 Resume 准备领取失败");
    const revision = await getEnvironmentRevisionById(TENANT_ID, ctx.environmentRevisionId);
    if (!revision) throw new Error("EnvironmentRevision 缺失");
    const lease = await seedPreparedEnvironmentLease({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      attemptId: attempt.id,
      revision,
      workspaceBindingId: ctx.workspaceBindingId,
      recoveryAnchorDigest: anchorDigest,
      preparationClaim: accepted.claim,
    });
    const candidateParent = path.join(await realpath(ctx.writerRoot), ".snow-runs", attempt.id);
    return {
      anchor,
      anchorDigest,
      attempt,
      lease,
      candidateParent,
      async stageReadyCandidate() {
        const resources = await resolveExecutionResources({
          tenantId: TENANT_ID,
          binding: bindingRow,
          purpose: "resume",
        });
        if (!resources.workspace) throw new Error("Workspace 执行资源缺失");
        const candidate = await prepareWorkspaceCandidate({
          attemptId: attempt.id,
          binding: resources.workspace.binding,
          backend: resources.workspace.backend,
          root: resources.workspace.root,
          operationId: `workspace-${protocolDigest({
            sourceOperationKey,
            checkpointId: checkpoint.checkpointId,
            sourceRequestDigest: executionSourceDigest(accepted.source),
          }).slice(7, 39)}`,
          runtimeRevisionId: bindingRow.runtimeRevisionId,
        });
        if (!candidate) throw new Error("Workspace 候选目录缺失");
        const restored = await restoreCheckpoint(ctx, {
          checkpointId: checkpoint.checkpointId,
          destination: candidate.preparation.candidateRoot,
        });
        return { candidate, restored };
      },
      async start() {
        const resources = await resolveExecutionResources({
          tenantId: TENANT_ID,
          binding: bindingRow,
          purpose: "resume",
        });
        if (!resources.workspace) throw new Error("Workspace 执行资源缺失");
        return startRuntimeInvocation({
          tenantId: TENANT_ID,
          sourceOperationKey,
          invocation,
          binding: bindingRow,
          attempt,
          runtimeClient: createHttpRuntimeClient(),
          runtimeEndpoint: ctx.stub.endpoint,
          auth: { mode: "none" },
          callbackEndpoints: buildGatewayEndpoints({
            external: true,
            invocationId: ctx.invocationId,
          }),
          environmentLeaseId: lease.id,
          environmentProvisioner: null,
          workspace: resources.workspace,
          intentType: "resume",
          recovery: { kind: "resume", anchor, anchorDigest, checkpointId: checkpoint.checkpointId },
          preparationClaim: accepted.claim,
        });
      },
    };
  }

  it("A06-T02: 纯控制事件（heartbeat/合法暂停）不使快照陈旧——对象与事件序号前进，内容水位不被伪推进", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "control-only", "utf8");
    await assertCheckpointGateFacts(ctx);
    const checkpoint = await runDefaultCheckpoint(ctx);
    const atCheckpoint = checkpoint.invocation;
    // 基线语义：快照记载的水位就是提交时的当前水位。
    expect(checkpoint.checkpoint.recoveryVersion).toBe(atCheckpoint.recoveryVersion);
    expect(checkpoint.checkpoint.producerSequence).toBe(atCheckpoint.lastProducerSequence);

    // 快照之后到达的都是**控制元数据**：占事件序号、推进对象版本，但不改变执行内容。
    await ingestRuntimeBatch(ctx, [
      { type: "progress", payload: { summary: "heartbeat" } },
      { type: "progress", payload: { summary: "ack" } },
    ]);
    const afterControl = await readInvocationFacts(ctx.invocationId);
    expect(afterControl.recoveryVersion).toBe(atCheckpoint.recoveryVersion);
    expect(afterControl.versionNo).toBeGreaterThan(atCheckpoint.versionNo);
    expect(afterControl.lastProducerSequence).toBeGreaterThan(atCheckpoint.lastProducerSequence);

    // 暂停本身也是纯生命周期事实：它必须能引用**刚提交的**快照。
    // （修复前暂停会自增水位，于是同一个 Checkpoint 立刻变成"自己的陈旧锚点"。）
    const accepted = await ingestRuntimeBatch(ctx, [
      suspendedEvent(checkpoint.checkpointId, checkpoint.checkpoint.recoveryAnchorDigest),
    ]);
    expect(accepted.receipts).toHaveLength(1);
    const paused = await readInvocationFacts(ctx.invocationId);
    expect(paused.executionState).toBe("waiting_user");
    expect(paused.recoveryVersion).toBe(atCheckpoint.recoveryVersion);
    expect(paused.lastProducerSequence).toBeGreaterThan(atCheckpoint.lastProducerSequence);
    const pausedAttempt = await readAttemptFacts(ctx.attemptId);
    expect(pausedAttempt.attemptState).toBe("suspended");
    expect(pausedAttempt.resumeAnchorDigest).toBe(checkpoint.checkpoint.recoveryAnchorDigest);

    // 允许的恢复边界：同一快照仍能**真实恢复**，不因账本多出控制事件而被拒。
    const restored = await restoreCheckpoint(ctx, {
      checkpointId: checkpoint.checkpointId,
      destination: path.join(ctx.baseRoot, "restore-control-only"),
    });
    expect(await readFile(path.join(restored.destination, "state.txt"), "utf8")).toBe(
      "control-only",
    );
    expect(restored.replayFromProducerSequence).toBe(
      String(checkpoint.checkpoint.producerSequence),
    );
  });

  it("A06-T03: 快照之后真实采用行动结果 → 旧 Snapshot 必须陈旧，且不启动缺状态的 Runtime", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "v1", "utf8");
    await assertCheckpointGateFacts(ctx);
    const checkpoint = await runDefaultCheckpoint(ctx);
    const atCheckpoint = checkpoint.invocation;

    // 真实接纳一条被**采用**的行动结果：这是"执行内容发生变化"的正式事实。
    await ingestRuntimeBatch(ctx, [
      { type: "action", payload: { action_id: "a06-stale", result: "applied" } },
    ]);
    const afterAdoption = await readInvocationFacts(ctx.invocationId);
    expect(afterAdoption.recoveryVersion).toBe(atCheckpoint.recoveryVersion + 1);

    // ① 直接恢复：恢复边界由**当前**事实重建，拿当前水位也必须失败。
    await expect(
      restoreCheckpoint(ctx, {
        checkpointId: checkpoint.checkpointId,
        destination: path.join(ctx.baseRoot, "restore-stale"),
        recoveryVersion: afterAdoption.recoveryVersion,
      }),
    ).rejects.toThrow("CheckpointStale");
    // 失败没有落下半成品目录。
    await expect(
      readFile(path.join(ctx.baseRoot, "restore-stale", "state.txt"), "utf8"),
    ).rejects.toThrow();

    // ② 走真实启动：必须在**联系 Runtime 之前**失败（陈旧快照不得换来一次用户任务）。
    const generation = await prepareResumeGeneration(ctx, checkpoint);
    await expect(generation.start()).rejects.toThrow("CheckpointStale");
    expect(ctx.stub.resumeRequests).toHaveLength(0);
    // 也没有把陈旧 Checkpoint "就地升级"成可恢复：登记的水位仍是最初提交值。
    const checkpointAfter = await getFilesystemCheckpoint(TENANT_ID, checkpoint.checkpointId);
    expect(checkpointAfter?.recoveryVersion).toBe(checkpoint.checkpoint.recoveryVersion);
    expect(checkpointAfter?.manifestDigest).toBe(checkpoint.checkpoint.manifestDigest);
  });

  it("A06-T04: 伪造或更换 Anchor 成员一律拒绝，且不改写不可变 Checkpoint", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "anchor-members", "utf8");
    // 让一条行动结果被**真实采用**，再把它的 Ingress 事实声明为 Anchor 成员：
    // 声明必须指向当前正式事实，服务端逐条回读核验。
    await ingestRuntimeBatch(ctx, [
      { type: "action", payload: { action_id: "a06-member", result: "ok" } },
    ]);
    const [memberRow] = await db
      .select()
      .from(runtimeEventIngressTable)
      .where(
        and(
          eq(runtimeEventIngressTable.tenantId, TENANT_ID),
          eq(runtimeEventIngressTable.invocationId, ctx.invocationId),
          eq(runtimeEventIngressTable.candidateType, "action"),
        ),
      )
      .orderBy(asc(runtimeEventIngressTable.producerSequence))
      .limit(1);
    if (!memberRow) throw new Error("成员事实缺失");

    await assertCheckpointGateFacts(ctx);
    const checkpoint = await runDefaultCheckpoint(ctx, { actionFacts: [memberRow.id] });
    const original = checkpoint.checkpoint;
    const anchor = parseRecoveryAnchor(original.recoveryAnchor);
    if (!anchor) throw new Error("Anchor 形状非法");
    expect(anchor.actionFacts.map((fact) => fact.ref)).toEqual([memberRow.id]);

    // ① 换 Binding 引用：期望值指向另一个 WorkspaceBinding。
    await expect(
      restoreCheckpoint(ctx, {
        checkpointId: checkpoint.checkpointId,
        destination: path.join(ctx.baseRoot, "restore-other-binding"),
        workspaceBindingId: randomUUID(),
      }),
    ).rejects.toThrow("CheckpointStale");
    // ② 换成员摘要（Anchor 内容与 digest 不再自洽）：完整性拒绝。
    await writeCheckpointAnchor(
      checkpoint.checkpointId,
      {
        ...anchor,
        actionFacts: anchor.actionFacts.map((fact) => ({
          ...fact,
          evidenceDigest: `sha256:${"9".repeat(64)}`,
        })),
      },
      original.recoveryAnchorDigest,
    );
    await expect(
      restoreCheckpoint(ctx, {
        checkpointId: checkpoint.checkpointId,
        destination: path.join(ctx.baseRoot, "restore-bad-digest"),
      }),
    ).rejects.toThrow("CheckpointIntegrityFailed");

    // ③ 换成员引用到不存在/跨域事实（digest 一并重算，绕过完整性检查）：成员核验拒绝。
    const swapped = {
      ...anchor,
      actionFacts: anchor.actionFacts.map((fact) => ({ ...fact, ref: randomUUID() })),
    };
    await writeCheckpointAnchor(checkpoint.checkpointId, swapped, protocolDigest(swapped));
    await expect(
      restoreCheckpoint(ctx, {
        checkpointId: checkpoint.checkpointId,
        destination: path.join(ctx.baseRoot, "restore-swapped-member"),
      }),
    ).rejects.toThrow("MissingMember");

    // ④ 换消费集合（digest 一并重算）：水位/消费集合核验拒绝。
    const forgedConsumption = {
      ...anchor,
      consumedInputRefs: [
        {
          ref: randomUUID(),
          factType: "action",
          producerSequence: "1",
          evidenceDigest: `sha256:${"8".repeat(64)}`,
        },
      ],
    };
    await writeCheckpointAnchor(
      checkpoint.checkpointId,
      forgedConsumption,
      protocolDigest(forgedConsumption),
    );
    await expect(
      restoreCheckpoint(ctx, {
        checkpointId: checkpoint.checkpointId,
        destination: path.join(ctx.baseRoot, "restore-forged-consumption"),
      }),
    ).rejects.toThrow("ConsumedInputsDiverged");

    // 三次拒绝都没有"就地修复"历史：Checkpoint 仍是唯一一行，内容逐字等于用例写入值。
    const rows = await db
      .select()
      .from(filesystemCheckpointTable)
      .where(eq(filesystemCheckpointTable.invocationId, ctx.invocationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.manifestRef).toBe(original.manifestRef);
    expect(rows[0]?.manifestDigest).toBe(original.manifestDigest);
    expect(rows[0]?.recoveryAnchorDigest).toBe(protocolDigest(forgedConsumption));
    expect(rows[0]?.recoveryVersion).toBe(original.recoveryVersion);
  });

  it("A06-T05: 暂停事务中途失败整体回滚；已提交暂停的精确重放不再推进内容与序列", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "pause-atomic", "utf8");
    await assertCheckpointGateFacts(ctx);
    const checkpoint = await runDefaultCheckpoint(ctx);
    const before = await readInvocationFacts(ctx.invocationId);

    // ① 半程故障：批内第一条是合法 suspended，第二条跳号 → 整个 I 根事务必须整体回滚。
    const rollbackFailure = await ingestRuntimeBatch(
      ctx,
      [
        suspendedEvent(checkpoint.checkpointId, checkpoint.checkpoint.recoveryAnchorDigest),
        { type: "progress", payload: { summary: "gap" } },
      ],
      { sequenceOffset: (index) => (index >= 1 ? 1 : 0) },
    ).then(
      () => null,
      (error: unknown) => error as Error,
    );
    // 跳号在批内第 2 条才被发现 —— 此时第 1 条的暂停效果必须已被整体回滚。
    expect(rollbackFailure?.name).toBe("ProducerSequenceGapError");
    const afterRollback = await readInvocationFacts(ctx.invocationId);
    expect(afterRollback.executionState).toBe("running");
    expect(afterRollback.recoveryVersion).toBe(before.recoveryVersion);
    expect(afterRollback.lastProducerSequence).toBe(before.lastProducerSequence);
    // 没有半暂停：执行权仍在、Attempt 仍 running、没有落下恢复锚点。
    expect(
      await getActiveExecutionOwnership({ tenantId: TENANT_ID, invocationId: ctx.invocationId }),
    ).not.toBeNull();
    const attemptAfterRollback = await readAttemptFacts(ctx.attemptId);
    expect(attemptAfterRollback.attemptState).toBe("running");
    expect(attemptAfterRollback.resumeAnchorDigest).toBeNull();
    expect(attemptAfterRollback.filesystemCheckpointId).toBeNull();
    expect(await countIngressEvents(ctx.invocationId, "execution.suspended")).toBe(0);

    // ② 成功接纳一次暂停。
    const accepted = await ingestRuntimeBatch(ctx, [
      suspendedEvent(checkpoint.checkpointId, checkpoint.checkpoint.recoveryAnchorDigest),
    ]);
    const paused = await readInvocationFacts(ctx.invocationId);
    expect(paused.executionState).toBe("waiting_user");
    expect(paused.recoveryVersion).toBe(before.recoveryVersion);
    const pausedAttempt = await readAttemptFacts(ctx.attemptId);
    expect(pausedAttempt.attemptState).toBe("suspended");
    expect(pausedAttempt.filesystemCheckpointId).toBe(checkpoint.checkpointId);
    expect(pausedAttempt.resumeAnchorDigest).toBe(checkpoint.checkpoint.recoveryAnchorDigest);

    // ③ 回执丢失：**精确重放同一条事件**（同 eventId / 同序号 / 同载荷）。
    const replayed = await ingressRuntimeEvents({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      batch: {
        protocolVersion: 3,
        authority: ctx.authority,
        events: accepted.events,
      },
    });
    expect(replayed.replayedEventIds).toEqual(accepted.events.map((event) => event.eventId));
    expect(replayed.receipts).toHaveLength(1);
    const afterReplay = await readInvocationFacts(ctx.invocationId);
    expect(afterReplay.recoveryVersion).toBe(before.recoveryVersion);
    expect(afterReplay.lastProducerSequence).toBe(paused.lastProducerSequence);
    expect(afterReplay.versionNo).toBe(paused.versionNo);
    // 只有一次暂停效果：一条 suspended 事实、一个恢复锚点，没有第二个暂停锚点。
    expect(await countIngressEvents(ctx.invocationId, "execution.suspended")).toBe(1);
    const attemptAfterReplay = await readAttemptFacts(ctx.attemptId);
    expect(attemptAfterReplay.resumeAnchorDigest).toBe(pausedAttempt.resumeAnchorDigest);
    expect(attemptAfterReplay.filesystemCheckpointId).toBe(checkpoint.checkpointId);
  });

  it("A06-T01: 默认完整链路 —— checkpoint → 真实 suspended → 真实 UAR/Resume → restore → 新 started → 采用新输入 → 完成", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "checkpoint payload v1", "utf8");
    await assertCheckpointGateFacts(ctx);

    // ① Runtime 自报需要用户补充输入：真实 Ingress 建 UAR，并把回复变成**待消费**输入。
    const asked = await ingestRuntimeBatch(ctx, [
      {
        type: "user-action",
        payload: {
          request_type: "input",
          action_id: "a06-resume-input",
          purpose: "missing_scope",
          prompt: "请补充处理范围",
          input_schema: {
            type: "object",
            additionalProperties: false,
            required: ["text"],
            properties: { text: { type: "string", minLength: 1 } },
          },
        },
      },
    ]);
    expect(asked.receipts).toHaveLength(1);
    const [uar] = await db
      .select()
      .from(userActionRequestTable)
      .where(
        and(
          eq(userActionRequestTable.tenantId, TENANT_ID),
          eq(userActionRequestTable.invocationId, ctx.invocationId),
        ),
      );
    if (!uar) throw new Error("user-action 未持久化 UserActionRequest");
    expect(uar.requestState).toBe("pending");
    // 只"收到回复"不改变执行内容：水位不动。
    const waiting = await readInvocationFacts(ctx.invocationId);
    expect(waiting.executionState).toBe("waiting_user");
    const watermarkWhenAsked = waiting.recoveryVersion;

    // ② 默认入口取持久 Checkpoint（真实远端 Broker 快照 + 真实解冻）。
    const checkpoint = await runDefaultCheckpoint(ctx);
    const checkpointVersion = checkpoint.checkpoint.recoveryVersion;
    expect(checkpointVersion).toBe(watermarkWhenAsked);

    // ③ Runtime 正式提交暂停：必须引用刚提交的 Checkpoint。
    await ingestRuntimeBatch(ctx, [
      suspendedEvent(checkpoint.checkpointId, checkpoint.checkpoint.recoveryAnchorDigest),
    ]);
    const paused = await readInvocationFacts(ctx.invocationId);
    // A06 核心不变量：暂停**不推进**恢复内容水位 —— 快照与暂停后的当前水位必须一致。
    expect(paused.recoveryVersion).toBe(checkpointVersion);
    // 但事件序号与对象版本照常前进（生命周期事实仍要记账）。
    expect(paused.lastProducerSequence).toBeGreaterThan(checkpoint.checkpoint.producerSequence);
    expect(paused.versionNo).toBeGreaterThan(checkpoint.invocation.versionNo);
    const pausedAttempt = await readAttemptFacts(ctx.attemptId);
    expect(pausedAttempt.attemptState).toBe("suspended");
    expect(pausedAttempt.filesystemCheckpointId).toBe(checkpoint.checkpointId);
    expect(pausedAttempt.resumeAnchorDigest).toBe(checkpoint.checkpoint.recoveryAnchorDigest);
    expect(
      await getActiveExecutionOwnership({ tenantId: TENANT_ID, invocationId: ctx.invocationId }),
    ).toBeNull();

    // ④ 用户确认 → 真实 UAR 解析 → 持久 Resume 命令。
    const resolved = await resolveGenericUserAction({
      tenantId: TENANT_ID,
      requestId: uar.id,
      resolution: "submit",
      resolvedBy: "test-service",
      responseRedactedJson: { text: "范围=近 30 天" },
      idempotencyKey: `resolve:${uar.id}`,
      actorId: "test-service",
    });
    expect(resolved.request.requestState).toBe("resolved");

    // ⑤ 默认命令网关投递（不注入任何 Resolver）：真实恢复 → Writer 激活 → 联系 Runtime。
    const gateway = await dispatchResumeCommandToRuntime({
      tenantId: TENANT_ID,
      commandId: resolved.resumeCommand.id,
      actorId: "test-service",
      correlationId: uar.id,
    });
    const dispatchOutcome = !gateway.dispatched
      ? "not-dispatched"
      : [
          gateway.command.commandState,
          "errorCode" in gateway.command ? (gateway.command.errorCode ?? "-") : "-",
          "errorMessage" in gateway.command ? (gateway.command.errorMessage ?? "-") : "-",
        ].join(" / ");
    expect(
      dispatchOutcome.startsWith("acknowledged"),
      `Resume 派发结论：${dispatchOutcome}（持久尾码 ${await readCommandOutcome(resolved.resumeCommand.id)}）`,
    ).toBe(true);
    expect(ctx.stub.resumeRequests).toHaveLength(1);
    const resumeRequest = ctx.stub.resumeRequests[0]!;
    expect(resumeRequest.intentType).toBe("resume");
    // 恢复锚点就是暂停时留下的**持久**锚点，不是重新推导的另一个。
    expect(resumeRequest.recovery).toMatchObject({
      kind: "resume",
      checkpointId: checkpoint.checkpointId,
      anchorDigest: checkpoint.checkpoint.recoveryAnchorDigest,
    });

    // 恢复代际：同一 Attempt，**新** Ownership + 新 Session（intentType=resume）。
    const sessions = await db
      .select()
      .from(runtimeSessionBindingTable)
      .where(
        and(
          eq(runtimeSessionBindingTable.tenantId, TENANT_ID),
          eq(runtimeSessionBindingTable.invocationId, ctx.invocationId),
        ),
      )
      .orderBy(asc(runtimeSessionBindingTable.createdAt));
    expect(sessions).toHaveLength(2);
    const resumedSession = sessions[1]!;
    expect(resumedSession.attemptId).toBe(ctx.attemptId);
    expect(resumedSession.intentType).toBe("resume");
    expect(resumedSession.ownershipId).toBe(resumeRequest.authority.ownershipId);

    // ⑥ Runtime 接纳后回传 execution.started（真实 Ingress）。
    await ingestRuntimeBatch(
      ctx,
      [
        {
          type: "execution.started",
          payload: {
            intentKey: resumedSession.startIntentKey,
            semanticRequestDigest: resumedSession.semanticRequestDigest,
            remoteSessionRef: `stub-session:${resumeRequest.authority.sessionBindingId}`,
            remoteExecutionRef: `stub-execution:${resumeRequest.authority.ownershipId}`,
            capabilitiesDigest: expectedCapabilityManifestDigest({
              runtimeRevisionId: ctx.runtimeRevisionId,
              runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
            }),
          },
        },
      ],
      { authority: resumeRequest.authority },
    );
    const running = await readInvocationFacts(ctx.invocationId);
    expect(running.executionState).toBe("running");
    // 重新进入执行同样是纯生命周期：水位不动。
    expect(running.recoveryVersion).toBe(checkpointVersion);

    // ⑦ 实际恢复目录 = Writer 真实写根，文件内容来自快照（不是"记录里写了个路径"）。
    const owner = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    expect(owner?.id).toBe(resumeRequest.authority.ownershipId);
    expect(owner?.attemptId).toBe(ctx.attemptId);
    const activationEvidence = owner?.activationEvidence as {
      workspace?: { writerGeneration?: number; grantRef?: string };
    };
    const remote = createRemoteWorkspaceHost(process.env.SNOWHARNESS_WORKSPACE_HOST_URL!);
    const grant = await remote.getWriter(
      ctx.scopeDigest,
      activationEvidence!.workspace!.writerGeneration!,
    );
    const expectedRoot = await findRestoredRunRoot(ctx.writerRoot, ctx.attemptId);
    expect(await realpath(grant!.root)).toBe(expectedRoot);
    expect(expectedRoot.startsWith(`${ctx.controlRoot}${path.sep}`)).toBe(false);
    expect(await readFile(path.join(expectedRoot, "state.txt"), "utf8")).toBe(
      "checkpoint payload v1",
    );
    await remote.assertWriter(grant!);

    // ⑧ 恢复后的 Loop 真实采用这条回复：**这里**才是内容水位前进的唯一原因。
    await ingestRuntimeBatch(
      ctx,
      [
        {
          type: "response.completed",
          payload: {
            text: "已按补充范围完成",
            item_type: "assistant_message",
            finish_reason: "stop",
          },
        },
      ],
      { authority: resumeRequest.authority },
    );
    const adopted = await readInvocationFacts(ctx.invocationId);
    expect(adopted.recoveryVersion).toBe(checkpointVersion + 1);

    // ⑨ 正常收口。
    await ingestRuntimeBatch(
      ctx,
      [{ type: "execution.completed", payload: { finish_reason: "execution.completed" } }],
      { authority: resumeRequest.authority },
    );
    const done = await readInvocationFacts(ctx.invocationId);
    expect(done.executionState).toBe("completed");
    // 终态同样在推进白名单内（`execution.completed`：此后已不存在可恢复内容）。
    // 故恢复后共两次推进：⑧ 回复被真实采纳，⑨ 正常收口。
    expect(done.recoveryVersion).toBe(checkpointVersion + 2);
    expect(done.lastProducerSequence).toBeGreaterThan(adopted.lastProducerSequence);

    // 收口后 Checkpoint 的不可变身份与登记水位没有被"修好"成新版本。
    const finalCheckpoint = await getFilesystemCheckpoint(TENANT_ID, checkpoint.checkpointId);
    expect(finalCheckpoint?.recoveryVersion).toBe(checkpointVersion);
    expect(finalCheckpoint?.recoveryAnchorDigest).toBe(checkpoint.checkpoint.recoveryAnchorDigest);
  });

  // ─── 恢复侧共用夹具（T06–T08）────────────────────────────────

  /** Runtime 自报需要补充输入的正式事件载荷（形状与生产 Runtime 一致）。 */
  function resumeInputPayload(actionId = "a06-resume-input"): {
    type: RuntimeEventType;
    payload: Record<string, unknown>;
  } {
    return {
      type: "user-action",
      payload: {
        request_type: "input",
        action_id: actionId,
        purpose: "missing_scope",
        prompt: "请补充处理范围",
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: { text: { type: "string", minLength: 1 } },
        },
      },
    };
  }

  async function requireUar(ctx: DefaultPathContext, actionId = "a06-resume-input") {
    const [uar] = await db
      .select()
      .from(userActionRequestTable)
      .where(
        and(
          eq(userActionRequestTable.tenantId, TENANT_ID),
          eq(userActionRequestTable.invocationId, ctx.invocationId),
          eq(userActionRequestTable.harnessActionId, actionId),
        ),
      );
    if (!uar) throw new Error("user-action 未持久化 UserActionRequest");
    return uar;
  }

  async function readSessions(ctx: DefaultPathContext) {
    return db
      .select()
      .from(runtimeSessionBindingTable)
      .where(
        and(
          eq(runtimeSessionBindingTable.tenantId, TENANT_ID),
          eq(runtimeSessionBindingTable.invocationId, ctx.invocationId),
        ),
      )
      .orderBy(asc(runtimeSessionBindingTable.createdAt));
  }

  /**
   * Resume 命令的**已持久结论**。
   *
   * 只看"网关返回了对象"会把真正的失败藏在 `commandState=failed` 后面；命令尾部的
   * `lastErrorCode` 才是判断卡在环境、运输还是权威的唯一持久证据。
   */
  async function readCommandOutcome(commandId: string): Promise<string> {
    const [row] = await db
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, TENANT_ID),
          eq(invocationCommandTable.id, commandId),
        ),
      )
      .limit(1);
    if (!row) return "缺失";
    return (
      `${row.commandState}/${row.lastErrorCode ?? "-"}` +
      ` dispatchCount=${row.dispatchCount}` +
      ` lease=${row.dispatchLeaseExpiresAt?.toISOString() ?? "null"}` +
      ` next=${row.nextDispatchAt?.toISOString() ?? "null"}`
    );
  }

  /**
   * 等到维护 lane 的**真实前置条件**成立：命令的 `nextDispatchAt` 已到期。
   *
   * 只做**只读**等待，不改写任何行 —— 领取事务仍按 state/lease/due 逐项复核，
   * 这里等的是策略决定的真实退避（`backoffDelayMs(1) = 1s`），不是把行伪造成"已到期"。
   */
  async function waitForDispatchDue(commandId: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const [row] = await db
        .select({ nextDispatchAt: invocationCommandTable.nextDispatchAt })
        .from(invocationCommandTable)
        .where(
          and(
            eq(invocationCommandTable.tenantId, TENANT_ID),
            eq(invocationCommandTable.id, commandId),
          ),
        )
        .limit(1);
      const due = row?.nextDispatchAt;
      // 200ms 余量：宿主与容器时钟不共享同一读数，不要卡在边界上。
      if (!due || due.getTime() + 200 <= Date.now()) return;
      if (Date.now() > deadline) {
        throw new Error(`等待 dispatch 退避到期超时：nextDispatchAt=${due.toISOString()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  function submitResolution(requestId: string) {
    return resolveGenericUserAction({
      tenantId: TENANT_ID,
      requestId,
      resolution: "submit",
      resolvedBy: "test-service",
      responseRedactedJson: { text: "范围=近 30 天" },
      idempotencyKey: `resolve:${requestId}`,
      actorId: "test-service",
    });
  }

  /**
   * 走完 T01 的①–⑦并停在"恢复代际已真正运行"：用户补充输入 → 默认 Checkpoint →
   * 真实 suspended → 真实 UAR 解析 → 默认 Resume 网关 → 真实 restore/Writer 激活 → 新 started。
   */
  async function runPauseResumeChain(
    ctx: DefaultPathContext,
    options: {
      actionId?: string;
      authority?: DefaultPathContext["authority"];
      afterSuspended?: () => Promise<void>;
    } = {},
  ) {
    const actionId = options.actionId ?? "a06-resume-input";
    const currentAuthority = options.authority ?? ctx.authority;
    await ingestRuntimeBatch(ctx, [resumeInputPayload(actionId)], { authority: currentAuthority });
    const uar = await requireUar(ctx, actionId);
    const checkpoint = await runDefaultCheckpoint(ctx);
    await ingestRuntimeBatch(
      ctx,
      [suspendedEvent(checkpoint.checkpointId, checkpoint.checkpoint.recoveryAnchorDigest)],
      { authority: currentAuthority },
    );
    const paused = await readInvocationFacts(ctx.invocationId);
    await options.afterSuspended?.();
    const resolved = await submitResolution(uar.id);
    const gateway = await dispatchResumeCommandToRuntime({
      tenantId: TENANT_ID,
      commandId: resolved.resumeCommand.id,
      actorId: "test-service",
      correlationId: uar.id,
    });
    const outcome = await readCommandOutcome(resolved.resumeCommand.id);
    const resumeRequest = ctx.stub.resumeRequests.at(-1);
    if (!resumeRequest) throw new Error(`恢复意图未送达 Runtime（Resume 命令结论 ${outcome}）`);
    const sessions = await readSessions(ctx);
    const resumedSession = sessions.at(-1);
    if (!resumedSession) throw new Error("恢复未产生新 Session");
    await ingestRuntimeBatch(
      ctx,
      [
        {
          type: "execution.started",
          payload: {
            intentKey: resumedSession.startIntentKey,
            semanticRequestDigest: resumedSession.semanticRequestDigest,
            remoteSessionRef: `stub-session:${resumeRequest.authority.sessionBindingId}`,
            remoteExecutionRef: `stub-execution:${resumeRequest.authority.ownershipId}`,
            capabilitiesDigest: expectedCapabilityManifestDigest({
              runtimeRevisionId: ctx.runtimeRevisionId,
              runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
            }),
          },
        },
      ],
      { authority: resumeRequest.authority },
    );
    const running = await readInvocationFacts(ctx.invocationId);
    const owner = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    if (!owner) throw new Error("恢复后缺少 Current Ownership");
    const activationEvidence = owner.activationEvidence as {
      workspace?: { writerGeneration?: number };
    } | null;
    const writerGeneration = activationEvidence?.workspace?.writerGeneration;
    if (!writerGeneration) throw new Error("恢复后缺少 Writer generation");
    const remote = createRemoteWorkspaceHost(process.env.SNOWHARNESS_WORKSPACE_HOST_URL!);
    const grant = await remote.getWriter(ctx.scopeDigest, writerGeneration);
    if (!grant) throw new Error("恢复后的 Writer grant 不存在");
    const expectedRoot = await realpath(grant.root);
    return {
      uar,
      checkpoint,
      paused,
      resolved,
      gateway,
      resumeRequest,
      sessions,
      resumedSession,
      running,
      owner,
      expectedRoot,
    };
  }

  it("N08-T1/N08-T2: 同 Attempt 两轮不同快照使用独立候选；同源复投不覆盖活跃文件", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "checkpoint-k1", "utf8");
    await assertCheckpointGateFacts(ctx);

    const first = await runPauseResumeChain(ctx, { actionId: "n08-round-1" });
    expect(first.resumeRequest.authority.attemptId).toBe(ctx.attemptId);
    expect(await readFile(path.join(first.expectedRoot, "state.txt"), "utf8")).toBe(
      "checkpoint-k1",
    );

    // 第一轮已经运行并产生合法新文件；第二轮 Checkpoint 必须从当前 Writer root 取 K2，
    // 不能再次使用 Attempt 固定的旧非空目录。
    await writeFile(path.join(first.expectedRoot, "state.txt"), "checkpoint-k2", "utf8");
    const second = await runPauseResumeChain(ctx, {
      actionId: "n08-round-2",
      authority: first.resumeRequest.authority,
    });
    expect(second.resumeRequest.authority.attemptId).toBe(ctx.attemptId);
    expect(second.expectedRoot).not.toBe(first.expectedRoot);
    expect(await readFile(path.join(second.expectedRoot, "state.txt"), "utf8")).toBe(
      "checkpoint-k2",
    );
    const runsDir = path.join(await realpath(ctx.writerRoot), ".snow-runs", ctx.attemptId);
    expect(await readRestoredRunRoots(runsDir)).toHaveLength(2);

    // 同一 C2 已经交付并开始运行后发生合法写入；正式重投只能回读历史结论，不能重做 K2
    // restore、删除当前 root 或换一代 Writer。
    await writeFile(path.join(second.expectedRoot, "live.txt"), "live-after-resume", "utf8");
    const ownerBeforeReplay = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    const replay = await retryDispatchedCommandToRuntime({
      tenantId: TENANT_ID,
      commandId: second.resolved.resumeCommand.id,
    });
    expect(replay.dispatched).toBe(false);
    const ownerAfterReplay = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    expect(ownerAfterReplay?.id).toBe(ownerBeforeReplay?.id);
    expect(await readFile(path.join(second.expectedRoot, "live.txt"), "utf8")).toBe(
      "live-after-resume",
    );
  });

  it("N04-T1/R4-a: 第一轮已接受的慢命令跨第二轮晚到，不改受管 Lease、Writer 和文件", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "first-checkpoint", "utf8");
    await assertCheckpointGateFacts(ctx);
    let slowCommandId: string | null = null;
    const frozen = {
      request: null as ReturnType<typeof executionSourceRequestForStart> | null,
      anchorDigest: null as string | null,
    };
    const first = await runPauseResumeChain(ctx, {
      actionId: "r4a-first-pause",
      afterSuspended: async () => {
        // C1-A 在 P1 仍为当前暂停时通过正式命令接受入口冻结来源，随后暂不投递。
        slowCommandId = await db.transaction((tx) =>
          createInvocationCommandInTransaction(tx, {
            tenantId: TENANT_ID,
            invocationId: ctx.invocationId,
            commandType: "resume",
            idempotencyKey: `r4a-slow:${randomUUID()}`,
            payloadJson: {
              resume_source: "user_pause",
              resume_payload: { source: "user_pause" },
            },
            requestedByType: "user",
            requestedById: "test-user",
          }),
        );
        const [binding] = await db
          .select()
          .from(executionBindingTable)
          .where(eq(executionBindingTable.invocationId, ctx.invocationId))
          .limit(1);
        const attempt = await readAttemptFacts(ctx.attemptId);
        if (!binding || !attempt.filesystemCheckpointId || !attempt.resumeAnchorDigest) {
          throw new Error("C1-A 缺少正式暂停来源");
        }
        frozen.request = executionSourceRequestForStart({
          tenantId: TENANT_ID,
          invocation: await readInvocationFacts(ctx.invocationId),
          binding,
          attempt,
          sourceOperationKey: `command:${slowCommandId}`,
          intentType: "resume",
          recovery: {
            kind: "resume",
            anchor: `checkpoint:${attempt.filesystemCheckpointId}`,
            anchorDigest: attempt.resumeAnchorDigest,
            checkpointId: attempt.filesystemCheckpointId,
          },
        });
        frozen.anchorDigest = attempt.resumeAnchorDigest;
      },
    });
    if (!slowCommandId || !frozen.request || !frozen.anchorDigest) {
      throw new Error("C1-A 未被正式接受和冻结");
    }
    const [slowAccepted] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, slowCommandId))
      .limit(1);
    expect(slowAccepted?.commandState).toBe("queued");
    expect(
      (slowAccepted?.payloadJson as { pause_source_digest?: string }).pause_source_digest,
    ).toMatch(/^sha256:/);

    await writeFile(path.join(first.expectedRoot, "state.txt"), "second-checkpoint", "utf8");
    const second = await runPauseResumeChain(ctx, {
      actionId: "r4a-second-pause",
      authority: first.resumeRequest.authority,
    });
    await writeFile(path.join(second.expectedRoot, "live.txt"), "second-live", "utf8");
    const ownerBefore = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    const sessionsBefore = await readSessions(ctx);
    const leaseBefore = await db
      .select()
      .from(environmentLeaseTable)
      .where(eq(environmentLeaseTable.invocationId, ctx.invocationId));
    const attemptBefore = await readAttemptFacts(ctx.attemptId);
    expect(
      (slowAccepted?.payloadJson as { pause_source_digest: string }).pause_source_digest,
    ).not.toBe(
      protocolDigest({
        attemptId: attemptBefore.id,
        recoveryVersion: second.running.recoveryVersion,
        resumeAnchor: attemptBefore.resumeAnchor,
        resumeAnchorDigest: attemptBefore.resumeAnchorDigest,
      }),
    );
    const restoredBefore = await readRestoredRunRoots(
      path.join(await realpath(ctx.writerRoot), ".snow-runs", ctx.attemptId),
    );
    const resumeRequestsBefore = ctx.stub.resumeRequests.length;

    // C1-A 的只读请求在 P1 已冻结；现在从写事务 TX-A 正式进入，必须在 Lease reset 前复核。
    await expect(
      acceptExecutionPreparation({
        request: frozen.request,
        environmentReprepare: {
          leaseId: leaseBefore[0]!.id,
          recoveryAnchorDigest: frozen.anchorDigest,
        },
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });

    const late = await dispatchResumeCommandToRuntime({
      tenantId: TENANT_ID,
      commandId: slowCommandId,
      actorId: "test-service",
      correlationId: "r4a-late-c1a",
    });
    expect(late).toMatchObject({
      dispatched: true,
      command: { commandState: "failed", errorCode: "ResumePauseSourceSuperseded" },
    });
    expect(await readCommandOutcome(slowCommandId)).toContain("ResumePauseSourceSuperseded");
    expect(ctx.stub.resumeRequests).toHaveLength(resumeRequestsBefore);
    expect(await readSessions(ctx)).toEqual(sessionsBefore);
    expect(
      await db
        .select()
        .from(environmentLeaseTable)
        .where(eq(environmentLeaseTable.invocationId, ctx.invocationId)),
    ).toEqual(leaseBefore);
    expect(await readAttemptFacts(ctx.attemptId)).toEqual(attemptBefore);
    expect(
      (await getActiveExecutionOwnership({ tenantId: TENANT_ID, invocationId: ctx.invocationId }))
        ?.id,
    ).toBe(ownerBefore?.id);
    expect(
      await readRestoredRunRoots(
        path.join(await realpath(ctx.writerRoot), ".snow-runs", ctx.attemptId),
      ),
    ).toEqual(restoredBefore);
    expect(await readFile(path.join(second.expectedRoot, "state.txt"), "utf8")).toBe(
      "second-checkpoint",
    );
    expect(await readFile(path.join(second.expectedRoot, "live.txt"), "utf8")).toBe("second-live");
  });

  it("R4-b: 两种来源先后都在 Invocation 根锁内裁决，落败者不能重置 Lease", async () => {
    for (const firstLabel of ["W1", "W2"] as const) {
      const ctx = await setupDefaultPathContext();
      await writeFile(path.join(ctx.writerRoot, "state.txt"), `r4b-${firstLabel}`, "utf8");
      await ingestRuntimeBatch(ctx, [resumeInputPayload(`r4b-${firstLabel}`)]);
      const checkpoint = await runDefaultCheckpoint(ctx);
      await ingestRuntimeBatch(ctx, [
        suspendedEvent(checkpoint.checkpointId, checkpoint.checkpoint.recoveryAnchorDigest),
      ]);
      const [leaseBefore] = await db
        .select()
        .from(environmentLeaseTable)
        .where(eq(environmentLeaseTable.attemptId, ctx.attemptId))
        .limit(1);
      if (!leaseBefore) throw new Error("R4-b 缺少真实环境 Lease");
      const commands = new Map<string, string>();
      for (const label of ["W1", "W2"] as const) {
        const commandId = await db.transaction((tx) =>
          createInvocationCommandInTransaction(tx, {
            tenantId: TENANT_ID,
            invocationId: ctx.invocationId,
            commandType: "resume",
            idempotencyKey: `r4b:${firstLabel}:${label}:${randomUUID()}`,
            payloadJson: {
              resume_source: "user_pause",
              resume_payload: { source: "user_pause" },
            },
            requestedByType: "user",
            requestedById: "test-user",
          }),
        );
        commands.set(label, commandId);
        const claimed = await claimInvocationCommandDispatch({
          commandId,
          leaseOwner: `r4b-${label}-${randomUUID()}`,
          leaseDurationMs: 30_000,
          now: new Date(),
          allowImmediateQueued: true,
        });
        expect(claimed?.command.commandState).toBe("dispatched");
      }

      let rootLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        rootLocked = resolve;
      });
      let releaseRoot!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseRoot = resolve;
      });
      const holder = db.transaction(async (tx) => {
        await tx
          .select({ id: invocationTable.id })
          .from(invocationTable)
          .where(eq(invocationTable.id, ctx.invocationId))
          .for("update");
        rootLocked();
        await release;
      });
      try {
        await locked;
        const firstId = commands.get(firstLabel)!;
        const secondId = commands.get(firstLabel === "W1" ? "W2" : "W1")!;
        let firstSettled = false;
        let secondSettled = false;
        const first = acceptResumeCommandPreparation({
          tenantId: TENANT_ID,
          commandId: firstId,
        }).then(
          (claim) => {
            firstSettled = true;
            return { claim, error: null };
          },
          (error: unknown) => {
            firstSettled = true;
            return { claim: null, error };
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        const second = acceptResumeCommandPreparation({
          tenantId: TENANT_ID,
          commandId: secondId,
        }).then(
          (claim) => {
            secondSettled = true;
            return { claim, error: null };
          },
          (error: unknown) => {
            secondSettled = true;
            return { claim: null, error };
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (firstSettled) throw new Error(`首个 TX-A 提前结束：${String((await first).error)}`);
        if (secondSettled) throw new Error(`第二个 TX-A 提前结束：${String((await second).error)}`);
        expect(firstSettled).toBe(false);
        expect(secondSettled).toBe(false);
        // 两个 TX-A 都在 I 上等待，不能先拿 Lease 行锁形成 I←Lease 的反向等待。
        await db.transaction(async (tx) => {
          const [freeLease] = await tx
            .select({ id: environmentLeaseTable.id })
            .from(environmentLeaseTable)
            .where(eq(environmentLeaseTable.id, leaseBefore.id))
            .for("update")
            .limit(1);
          expect(freeLease?.id).toBe(leaseBefore.id);
        });
        releaseRoot();
        await holder;
        const firstOutcome = await first;
        const secondOutcome = await second;
        expect(firstOutcome.error).toBeNull();
        expect(firstOutcome.claim?.intentKey).toBe(`command:${firstId}`);
        expect(secondOutcome.claim).toBeNull();
        expect(String(secondOutcome.error)).toMatch(/AttemptPreparationBusy|NotCurrentExecutor/);
        const attemptAfter = await readAttemptFacts(ctx.attemptId);
        const [leaseAfter] = await db
          .select()
          .from(environmentLeaseTable)
          .where(eq(environmentLeaseTable.id, leaseBefore.id))
          .limit(1);
        expect(attemptAfter.preparationIntentKey).toBe(`command:${firstId}`);
        expect(leaseAfter?.versionNo).toBe(leaseBefore.versionNo + 1);
        expect(leaseAfter?.readinessState).toBe("preparing");
        expect(
          (leaseAfter?.resourceManifest as { recoveryAnchorDigest?: string }).recoveryAnchorDigest,
        ).toBe(checkpoint.checkpoint.recoveryAnchorDigest);
      } finally {
        releaseRoot();
        await holder;
      }
    }
  });

  it("R4-d: C2 已运行时正式 Worker 按 C1 冻结来源回读旧 ACK 而不触碰当前文件", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "c1-checkpoint", "utf8");
    await assertCheckpointGateFacts(ctx);
    const first = await runPauseResumeChain(ctx, { actionId: "r4d-c1" });
    await writeFile(path.join(first.expectedRoot, "state.txt"), "c2-checkpoint", "utf8");
    const second = await runPauseResumeChain(ctx, {
      actionId: "r4d-c2",
      authority: first.resumeRequest.authority,
    });
    expect(second.checkpoint.checkpointId).not.toBe(first.checkpoint.checkpointId);
    expect(second.resumedSession.id).not.toBe(first.resumedSession.id);
    expect(second.resumedSession.sourceRequestJson).not.toEqual(
      first.resumedSession.sourceRequestJson,
    );
    await writeFile(path.join(second.expectedRoot, "live.txt"), "c2-live-data", "utf8");
    const ownerBefore = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    const sessionsBefore = await readSessions(ctx);
    const leasesBefore = await db
      .select()
      .from(environmentLeaseTable)
      .where(eq(environmentLeaseTable.invocationId, ctx.invocationId));
    const requestsBefore = ctx.stub.resumeRequests.length;
    // C1 的命令尾部 ACK 提交丢失，但原 C1 Session 已持久保存真正的 Transport 回执。
    await db
      .update(invocationCommandTable)
      .set({
        commandState: "dispatched",
        receiptJson: null,
        completedAt: null,
        nextDispatchAt: new Date(Date.now() - 1_000),
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
      })
      .where(eq(invocationCommandTable.id, first.resolved.resumeCommand.id));
    expect((await createRuntimeDispatchRetryWorker().tick()).commands).toBeGreaterThanOrEqual(1);
    const [historical] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, first.resolved.resumeCommand.id))
      .limit(1);
    expect(historical?.commandState).toBe("acknowledged");
    expect(historical?.receiptJson).toEqual(first.resumedSession.transportAcknowledgement);
    expect(
      (await readSessions(ctx)).find((row) => row.id === first.resumedSession.id)
        ?.sourceRequestJson,
    ).toEqual(first.resumedSession.sourceRequestJson);
    expect(ctx.stub.resumeRequests).toHaveLength(requestsBefore);
    expect((await readSessions(ctx)).map((row) => row.id)).toEqual(
      sessionsBefore.map((row) => row.id),
    );
    expect(
      (
        await db
          .select()
          .from(environmentLeaseTable)
          .where(eq(environmentLeaseTable.invocationId, ctx.invocationId))
      ).map((row) => row.id),
    ).toEqual(leasesBefore.map((row) => row.id));
    expect(
      (
        await getActiveExecutionOwnership({
          tenantId: TENANT_ID,
          invocationId: ctx.invocationId,
        })
      )?.id,
    ).toBe(ownerBefore?.id);
    expect(await readFile(path.join(second.expectedRoot, "live.txt"), "utf8")).toBe("c2-live-data");
  });

  it("R4-c: 同 Attempt 的 C1/K1 与 C2/K2 各丢一次 ACK 后按各自冻结来源恢复", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "checkpoint-k1", "utf8");
    await assertCheckpointGateFacts(ctx);
    ctx.stub.dropNextResumeResponse();
    const first = await runPauseResumeChain(ctx, { actionId: "r4c-c1" });
    expect(first.gateway.dispatched && first.gateway.command.commandState).toBe("dispatched");
    await waitForDispatchDue(first.resolved.resumeCommand.id);
    expect((await createRuntimeDispatchRetryWorker().tick()).commands).toBeGreaterThanOrEqual(1);
    const [c1Command] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, first.resolved.resumeCommand.id))
      .limit(1);
    expect(c1Command?.commandState).toBe("acknowledged");
    expect(c1Command?.receiptJson).toEqual(
      (await readSessions(ctx)).find((row) => row.id === first.resumedSession.id)
        ?.transportAcknowledgement,
    );
    expect(await readSessions(ctx)).toHaveLength(2);
    expect(
      (await getActiveExecutionOwnership({ tenantId: TENANT_ID, invocationId: ctx.invocationId }))
        ?.id,
    ).toBe(first.resumedSession.ownershipId);
    expect(await readFile(path.join(first.expectedRoot, "state.txt"), "utf8")).toBe(
      "checkpoint-k1",
    );

    await writeFile(path.join(first.expectedRoot, "state.txt"), "checkpoint-k2", "utf8");
    ctx.stub.dropNextResumeResponse();
    const second = await runPauseResumeChain(ctx, {
      actionId: "r4c-c2",
      authority: first.resumeRequest.authority,
    });
    expect(second.gateway.dispatched && second.gateway.command.commandState).toBe("dispatched");
    await waitForDispatchDue(second.resolved.resumeCommand.id);
    expect((await createRuntimeDispatchRetryWorker().tick()).commands).toBeGreaterThanOrEqual(1);
    const [c2Command] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, second.resolved.resumeCommand.id))
      .limit(1);
    expect(c2Command?.commandState).toBe("acknowledged");
    expect(c2Command?.receiptJson).toEqual(
      (await readSessions(ctx)).find((row) => row.id === second.resumedSession.id)
        ?.transportAcknowledgement,
    );
    expect(await readSessions(ctx)).toHaveLength(3);
    expect(
      (await getActiveExecutionOwnership({ tenantId: TENANT_ID, invocationId: ctx.invocationId }))
        ?.id,
    ).toBe(second.resumedSession.ownershipId);
    expect(first.resumeRequest.authority.attemptId).toBe(ctx.attemptId);
    expect(second.resumeRequest.authority.attemptId).toBe(ctx.attemptId);
    expect(first.checkpoint.checkpointId).not.toBe(second.checkpoint.checkpointId);
    expect(first.resumedSession.id).not.toBe(second.resumedSession.id);
    expect(first.resumedSession.ownershipId).not.toBe(second.resumedSession.ownershipId);
    expect(await readFile(path.join(second.expectedRoot, "state.txt"), "utf8")).toBe(
      "checkpoint-k2",
    );
    expect(ctx.stub.resumeIdempotencyKeys).toEqual([
      `start:${first.resumedSession.ownershipId}`,
      `start:${first.resumedSession.ownershipId}`,
      `start:${second.resumedSession.ownershipId}`,
      `start:${second.resumedSession.ownershipId}`,
    ]);
    const beforeConflict = await readSessions(ctx);
    const c1Source = assertExecutionSourceSnapshot(first.resumedSession.sourceRequestJson);
    if (c1Source.recovery.kind !== "resume") throw new Error("C1 来源缺少恢复锚点");
    await expect(
      acceptExecutionPreparation({
        request: {
          ...executionSourceRequestOf(c1Source),
          recovery: {
            ...c1Source.recovery,
            anchorDigest: protocolDigest({ altered: "r4c" }),
          },
        },
      }),
    ).rejects.toThrow("StartIntentConflict");
    expect((await readSessions(ctx)).map((row) => row.id)).toEqual(
      beforeConflict.map((row) => row.id),
    );
    expect(await readFile(path.join(second.expectedRoot, "state.txt"), "utf8")).toBe(
      "checkpoint-k2",
    );
  });

  it("A06-T06: 暂停后的新回复在恢复后**只被采用一次**，采用时内容水位真实前进", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "reply-once", "utf8");
    await assertCheckpointGateFacts(ctx);
    const chain = await runPauseResumeChain(ctx);
    const versionAtResume = chain.checkpoint.checkpoint.recoveryVersion;
    // 恢复代际已开始执行，但"收到回复"与"重新进入执行"都不推进内容水位。
    expect(chain.paused.recoveryVersion).toBe(versionAtResume);
    expect(chain.running.recoveryVersion).toBe(versionAtResume);

    // ① 回复不丢：UAR 已解析为持久事实。
    expect(chain.resolved.request.requestState).toBe("resolved");
    expect(chain.resolved.request.resolution).toBe("submit");

    // ② Loop 真实采用这条回复：内容水位**前进一次**（一律不推进水位会在这里失败）。
    await ingestRuntimeBatch(
      ctx,
      [
        {
          type: "response.completed",
          payload: {
            text: "已按补充范围完成",
            item_type: "assistant_message",
            finish_reason: "stop",
          },
        },
      ],
      { authority: chain.resumeRequest.authority },
    );
    const adopted = await readInvocationFacts(ctx.invocationId);
    expect(adopted.recoveryVersion).toBe(versionAtResume + 1);

    // ③ 同一条 continuation 重投：不得把回复再消费一次。
    const redelivery = await retryDispatchedCommandToRuntime({
      tenantId: TENANT_ID,
      commandId: chain.resolved.resumeCommand.id,
    });
    expect(redelivery.dispatched).toBe(false);
    const afterRedelivery = await readInvocationFacts(ctx.invocationId);
    expect(afterRedelivery.recoveryVersion).toBe(adopted.recoveryVersion);
    expect(afterRedelivery.lastProducerSequence).toBe(adopted.lastProducerSequence);
    expect(await countIngressEvents(ctx.invocationId, "response.completed")).toBe(1);
    expect(await readSessions(ctx)).toHaveLength(2);
    // 恢复出来的目录没有因为重投被重建：文件内容是第一次恢复的那一份。
    expect(await readFile(path.join(chain.expectedRoot, "state.txt"), "utf8")).toBe("reply-once");
  });

  it("R3-d: Resume 的 started 先于 ACK，正式 Command Worker 回读历史且不重置运行目录", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "before-resume", "utf8");
    await assertCheckpointGateFacts(ctx);
    await ingestRuntimeBatch(ctx, [resumeInputPayload()]);
    const uar = await requireUar(ctx);
    const checkpoint = await runDefaultCheckpoint(ctx);
    await ingestRuntimeBatch(ctx, [
      suspendedEvent(checkpoint.checkpointId, checkpoint.checkpoint.recoveryAnchorDigest),
    ]);
    const resolved = await submitResolution(uar.id);
    ctx.stub.dropNextResumeResponse();
    const first = await dispatchResumeCommandToRuntime({
      tenantId: TENANT_ID,
      commandId: resolved.resumeCommand.id,
      actorId: "test-service",
      correlationId: uar.id,
    });
    expect(first.dispatched).toBe(true);
    if (!first.dispatched) throw new Error("首次 Resume 未投递");
    expect(first.command.commandState).toBe("dispatched");
    const request = ctx.stub.resumeRequests.at(-1);
    if (!request) throw new Error("Runtime 未收到 Resume 请求");
    const resumedSession = (await readSessions(ctx)).at(-1);
    if (!resumedSession) throw new Error("Resume Session 未持久化");
    await ingestRuntimeBatch(
      ctx,
      [
        {
          type: "execution.started",
          payload: {
            intentKey: resumedSession.startIntentKey,
            semanticRequestDigest: resumedSession.semanticRequestDigest,
            remoteSessionRef: `stub-session:${request.authority.sessionBindingId}`,
            remoteExecutionRef: `stub-execution:${request.authority.ownershipId}`,
            capabilitiesDigest: expectedCapabilityManifestDigest({
              runtimeRevisionId: ctx.runtimeRevisionId,
              runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
            }),
          },
        },
      ],
      { authority: request.authority },
    );
    expect((await readInvocationFacts(ctx.invocationId)).executionState).toBe("running");
    const owner = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    const evidence = owner?.activationEvidence as {
      workspace?: { writerGeneration?: number; grantRef?: string };
    } | null;
    const generation = evidence?.workspace?.writerGeneration;
    if (!owner || !generation) throw new Error("恢复执行缺少物理 Writer");
    const remote = createRemoteWorkspaceHost(process.env.SNOWHARNESS_WORKSPACE_HOST_URL!);
    const grant = await remote.getWriter(ctx.scopeDigest, generation);
    if (!grant) throw new Error("恢复 Writer grant 不存在");
    const activeRoot = await realpath(grant.root);
    await writeFile(path.join(activeRoot, "live.txt"), "changed-after-started", "utf8");
    await waitForDispatchDue(resolved.resumeCommand.id);
    const worker = await createRuntimeDispatchRetryWorker().tick();
    expect(worker.commands).toBeGreaterThanOrEqual(1);
    const [command] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, resolved.resumeCommand.id))
      .limit(1);
    expect(command?.commandState).toBe("acknowledged");
    const sessionAfterAck = (await readSessions(ctx)).at(-1);
    expect(sessionAfterAck?.transportAcknowledgement).toBeTruthy();
    expect(command?.receiptJson).toEqual(sessionAfterAck?.transportAcknowledgement);
    expect(ctx.stub.resumeRequests).toHaveLength(2);
    expect(ctx.stub.resumeRequests[1]?.authority).toEqual(request.authority);
    expect(ctx.stub.resumeIdempotencyKeys).toEqual([
      `start:${request.authority.ownershipId}`,
      `start:${request.authority.ownershipId}`,
    ]);
    expect(await readFile(path.join(activeRoot, "live.txt"), "utf8")).toBe("changed-after-started");
    expect((await remote.getWriter(ctx.scopeDigest, generation))?.grantRef).toBe(grant.grantRef);
    expect((await readSessions(ctx)).at(-1)?.id).toBe(resumedSession.id);
    expect(
      (
        await getActiveExecutionOwnership({
          tenantId: TENANT_ID,
          invocationId: ctx.invocationId,
        })
      )?.id,
    ).toBe(owner.id);

    await ingestRuntimeBatch(
      ctx,
      [{ type: "execution.completed", payload: { finish_reason: "execution.completed" } }],
      { authority: request.authority },
    );
    const beforeHistory = await readSessions(ctx);
    const historical = await retryDispatchedCommandToRuntime({
      tenantId: TENANT_ID,
      commandId: resolved.resumeCommand.id,
    });
    expect(historical.dispatched).toBe(false);
    expect(ctx.stub.resumeRequests).toHaveLength(2);
    expect((await readSessions(ctx)).map((row) => row.id)).toEqual(
      beforeHistory.map((row) => row.id),
    );
    expect(await readFile(path.join(activeRoot, "live.txt"), "utf8")).toBe("changed-after-started");
  });

  it("F3 / R3-d: ACK 真丢且执行已终态时正式 Command Worker 明确无回执收口", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "terminal-no-ack", "utf8");
    await assertCheckpointGateFacts(ctx);
    await ingestRuntimeBatch(ctx, [resumeInputPayload()]);
    const uar = await requireUar(ctx);
    const checkpoint = await runDefaultCheckpoint(ctx);
    await ingestRuntimeBatch(ctx, [
      suspendedEvent(checkpoint.checkpointId, checkpoint.checkpoint.recoveryAnchorDigest),
    ]);
    const resolved = await submitResolution(uar.id);
    ctx.stub.dropNextResumeResponse();
    const first = await dispatchResumeCommandToRuntime({
      tenantId: TENANT_ID,
      commandId: resolved.resumeCommand.id,
      actorId: "test-service",
      correlationId: uar.id,
    });
    expect(first.dispatched && first.command.commandState).toBe("dispatched");
    const request = ctx.stub.resumeRequests.at(-1);
    const resumedSession = (await readSessions(ctx)).at(-1);
    if (!request || !resumedSession) throw new Error("Resume 物理请求或 Session 缺失");
    await ingestRuntimeBatch(
      ctx,
      [
        {
          type: "execution.started",
          payload: {
            intentKey: resumedSession.startIntentKey,
            semanticRequestDigest: resumedSession.semanticRequestDigest,
            remoteSessionRef: `stub-session:${request.authority.sessionBindingId}`,
            remoteExecutionRef: `stub-execution:${request.authority.ownershipId}`,
            capabilitiesDigest: expectedCapabilityManifestDigest({
              runtimeRevisionId: ctx.runtimeRevisionId,
              runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
            }),
          },
        },
      ],
      { authority: request.authority },
    );
    await ingestRuntimeBatch(
      ctx,
      [{ type: "execution.completed", payload: { finish_reason: "execution.completed" } }],
      { authority: request.authority },
    );
    expect((await readInvocationFacts(ctx.invocationId)).executionState).toBe("completed");
    const sessionsBefore = await readSessions(ctx);
    expect(sessionsBefore.at(-1)?.transportAcknowledgement).toBeNull();
    const leasesBefore = await db
      .select()
      .from(environmentLeaseTable)
      .where(eq(environmentLeaseTable.invocationId, ctx.invocationId));
    await waitForDispatchDue(resolved.resumeCommand.id);
    expect((await createRuntimeDispatchRetryWorker().tick()).commands).toBeGreaterThanOrEqual(1);
    const [command] = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, resolved.resumeCommand.id))
      .limit(1);
    expect(command?.commandState).toBe("failed");
    expect(command?.lastErrorCode).toBe("SourceClosedWithoutReceipt");
    expect(command?.receiptJson).toEqual({ code: "SourceClosedWithoutReceipt" });
    expect(ctx.stub.resumeRequests).toHaveLength(1);
    expect((await readSessions(ctx)).map((row) => row.id)).toEqual(
      sessionsBefore.map((row) => row.id),
    );
    expect(
      (
        await db
          .select()
          .from(environmentLeaseTable)
          .where(eq(environmentLeaseTable.invocationId, ctx.invocationId))
      ).map((row) => row.id),
    ).toEqual(leasesBefore.map((row) => row.id));
    expect((await readInvocationFacts(ctx.invocationId)).executionState).toBe("completed");
  });

  it("A06-T07: 文件恢复完成后确认丢失 —— 同 Resume 意图重投复用同一恢复操作，root/manifest 不漂移", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "restore-once", "utf8");
    await assertCheckpointGateFacts(ctx);
    await ingestRuntimeBatch(ctx, [resumeInputPayload()]);
    const uar = await requireUar(ctx);
    const checkpoint = await runDefaultCheckpoint(ctx);
    await ingestRuntimeBatch(ctx, [
      suspendedEvent(checkpoint.checkpointId, checkpoint.checkpoint.recoveryAnchorDigest),
    ]);
    const resolved = await submitResolution(uar.id);

    // ① 第一次投递：平台侧恢复真的完成了（目录/清单/所有权都已落库），但回执丢失。
    ctx.stub.dropNextResumeResponse();
    const first = await dispatchResumeCommandToRuntime({
      tenantId: TENANT_ID,
      commandId: resolved.resumeCommand.id,
      actorId: "test-service",
      correlationId: uar.id,
    });
    expect(first.dispatched).toBe(true);
    if (!first.dispatched) throw new Error("首次投递未产生结果");
    expect(first.command.commandState).toBe("dispatched");
    const firstRequest = ctx.stub.resumeRequests.at(-1);
    if (!firstRequest) throw new Error("首次恢复意图未送达 Runtime");
    const firstOwner = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    expect(firstOwner?.id).toBe(firstRequest.authority.ownershipId);
    const expectedRoot = await findRestoredRunRoot(ctx.writerRoot, ctx.attemptId);
    // 恢复实际完成：文件真的在写根里（不是空目录）。
    expect(await readFile(path.join(expectedRoot, "state.txt"), "utf8")).toBe("restore-once");
    const runsDir = path.dirname(expectedRoot);
    expect(await readRestoredRunRoots(runsDir)).toEqual([path.basename(expectedRoot)]);
    const firstEvidence = firstOwner?.activationEvidence as {
      workspace?: { writerGeneration?: number; grantRef?: string };
    };
    const remoteSession = createRemoteWorkspaceHost(process.env.SNOWHARNESS_WORKSPACE_HOST_URL!);
    const firstGrant = await remoteSession.getWriter(
      ctx.scopeDigest,
      firstEvidence!.workspace!.writerGeneration!,
    );

    // ② 同 Resume 意图重投（维护 lane 的真实入口）。
    //
    // 首投的尾部是 `dispatched` + `runtime_network_unavailable`（回执没到），退避窗口由策略
    // 给出（attempt 1 → 1s）；维护 lane 只能在 `nextDispatchAt` 到期后领取。这里等真实时钟
    // 越过它，而不是改写行去伪造到期 —— 领取事务的 state/lease/due 判据全部照常执行。
    await waitForDispatchDue(resolved.resumeCommand.id);
    const redelivered = await retryDispatchedCommandToRuntime({
      tenantId: TENANT_ID,
      commandId: resolved.resumeCommand.id,
    });
    expect(
      redelivered.dispatched,
      `重投结论：${redelivered.dispatched ? "-" : redelivered.reason}（持久尾码 ${await readCommandOutcome(
        resolved.resumeCommand.id,
      )}）`,
    ).toBe(true);

    // ③ 同一个恢复操作被**验证重用**：同一所有权 / 同幂等键 / 同锚点，没有第二份恢复。
    expect(ctx.stub.resumeRequests).toHaveLength(2);
    const secondRequest = ctx.stub.resumeRequests[1]!;
    // 稳定启动意图 = `start:<ownershipId>`（Stub 对任何其它键一律回 409）：
    // 两次投递能都被接纳、且携带同一 ownershipId，就证明复用同一次恢复意图。
    expect(secondRequest.authority.ownershipId).toBe(firstRequest.authority.ownershipId);
    expect(secondRequest.authority.sessionBindingId).toBe(firstRequest.authority.sessionBindingId);
    expect(secondRequest.recovery).toMatchObject({
      kind: "resume",
      checkpointId: checkpoint.checkpointId,
      anchorDigest: checkpoint.checkpoint.recoveryAnchorDigest,
    });
    expect(await readSessions(ctx)).toHaveLength(2);

    // ④ root/manifest 不漂移：同一写根、同一 grant，仍只有一份恢复目录。
    const owner = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    expect(owner?.id).toBe(firstOwner?.id);
    const evidence = owner?.activationEvidence as {
      workspace?: { writerGeneration?: number; grantRef?: string };
    };
    expect(evidence?.workspace?.grantRef).toBe(firstEvidence?.workspace?.grantRef);
    const grant = await remoteSession.getWriter(
      ctx.scopeDigest,
      evidence!.workspace!.writerGeneration!,
    );
    expect(grant?.grantRef).toBe(firstGrant?.grantRef);
    expect(await realpath(grant!.root)).toBe(expectedRoot);
    expect(await readRestoredRunRoots(runsDir)).toEqual([path.basename(expectedRoot)]);
    // "凭水位相等跳过文件验证"会在这里暴露：目录必须真的有恢复出来的内容。
    expect(await readFile(path.join(expectedRoot, "state.txt"), "utf8")).toBe("restore-once");
    await remoteSession.assertWriter(grant!);
  });

  it("A06-T08: 真实篡改快照 → 完整默认 restore 在授予执行权前失败，并保留清理证据", async () => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "tamper-me", "utf8");
    await assertCheckpointGateFacts(ctx);
    const checkpoint = await runDefaultCheckpoint(ctx);

    // 篡改**实际存储的内容成员**：长度不变、字节不同。
    //
    // 不能去 replace 清单里的 "tamper-me" —— 清单只记路径/长度/逐块 digest，不含文件正文，
    // 那样的"篡改"是空操作（会假绿）。真正的成员篡改必须落到内容块上，且只有逐块重算
    // digest 才能发现。
    const manifestPath = path.join(ctx.storageRoot, checkpoint.checkpoint.manifestRef);
    const storedManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries: Array<{ path: string; chunks?: Array<{ digest: string }> }>;
    };
    const stateEntry = storedManifest.entries.find((entry) => entry.path.endsWith("state.txt"));
    const chunkDigest = stateEntry?.chunks?.[0]?.digest;
    if (!chunkDigest) throw new Error("快照清单里没有 state.txt 的内容块");
    const chunkPath = path.join(ctx.storageRoot, "chunks", chunkDigest.slice("sha256:".length));
    const chunkBytes = new Uint8Array(await readFile(chunkPath));
    chunkBytes[0] = chunkBytes[0]! ^ 0x01; // 翻一个 bit：长度不变，digest 必变
    await writeFile(chunkPath, chunkBytes);

    const before = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    const generation = await prepareResumeGeneration(ctx, checkpoint);
    const failure = await generation.start().then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure).not.toBeNull();
    expect(failure!.message).toMatch(/digest|integrity|manifest|CheckpointStale/i);

    // ① 没有启动用户任务：Runtime 一次都没被联系。
    expect(ctx.stub.resumeRequests).toHaveLength(0);
    // ② 没有授予执行权：当前 Ownership 仍是原来那一代，候选 Attempt 没有被激活。
    const after = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    expect(after?.id).toBe(before?.id);
    expect(after?.attemptId).toBe(ctx.attemptId);
    // ③ 失败与清理证据：候选运行目录被生产实现显式清理，不残留半成品。
    await expect(
      readdir(generation.candidateParent)
        .then((names) => names.filter((name) => name.startsWith("workspace-")))
        .catch(() => []),
    ).resolves.toEqual([]);
    // ④ 被篡改的快照没有被"修好"成新版本。
    const checkpointAfter = await getFilesystemCheckpoint(TENANT_ID, checkpoint.checkpointId);
    expect(checkpointAfter?.manifestDigest).toBe(checkpoint.checkpoint.manifestDigest);
    expect(checkpointAfter?.recoveryVersion).toBe(checkpoint.checkpoint.recoveryVersion);
  });

  it.each([
    {
      name: "同长度改写",
      mutate: (root: string) => writeFile(path.join(root, "state.txt"), "TAMPER-ME", "utf8"),
    },
    { name: "删除文件", mutate: (root: string) => rm(path.join(root, "state.txt")) },
    {
      name: "添加文件",
      mutate: (root: string) => writeFile(path.join(root, "extra.txt"), "extra", "utf8"),
    },
  ])("N08-T3: ready 候选目标被$name后，真实恢复准入拒绝", async ({ mutate }) => {
    const ctx = await setupDefaultPathContext();
    await writeFile(path.join(ctx.writerRoot, "state.txt"), "tamper-me", "utf8");
    await assertCheckpointGateFacts(ctx);
    const checkpoint = await runDefaultCheckpoint(ctx);
    const generation = await prepareResumeGeneration(ctx, checkpoint);
    const beforeOwner = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    const { candidate, restored } = await generation.stageReadyCandidate();
    const target = candidate.preparation.candidateRoot;
    expect(restored.destination).toBe(target);
    expect(await readFile(path.join(target, "state.txt"), "utf8")).toBe("tamper-me");
    const marker = JSON.parse(await readFile(`${target}.restore-state.json`, "utf8")) as {
      phase: string;
      manifestDigest: string;
    };
    expect(marker.phase).toBe("ready");
    expect(marker.manifestDigest).toBe(checkpoint.checkpoint.manifestDigest);
    const manifest = JSON.parse(
      await readFile(path.join(ctx.storageRoot, checkpoint.checkpoint.manifestRef), "utf8"),
    ) as { entries: Array<{ path: string; chunks?: Array<{ digest: string }> }> };
    const chunkDigest = manifest.entries.find((entry) => entry.path === "state.txt")?.chunks?.[0]
      ?.digest;
    if (!chunkDigest) throw new Error("快照源内容块缺失");
    const chunkPath = path.join(ctx.storageRoot, "chunks", chunkDigest.slice("sha256:".length));
    const sourceChunk = await readFile(chunkPath);

    await mutate(target);
    await expect(generation.start()).rejects.toThrow(/CheckpointIntegrityFailed|目标实际内容/);
    expect(await readFile(chunkPath)).toEqual(sourceChunk);
    expect(ctx.stub.resumeRequests).toHaveLength(0);
    const afterOwner = await getActiveExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
    });
    expect(afterOwner?.id).toBe(beforeOwner?.id);
    expect(afterOwner?.attemptId).toBe(ctx.attemptId);
    expect(await getFilesystemCheckpoint(TENANT_ID, checkpoint.checkpointId)).toMatchObject({
      manifestDigest: checkpoint.checkpoint.manifestDigest,
      recoveryVersion: checkpoint.checkpoint.recoveryVersion,
    });
  });
});
