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
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createEnvironmentDefinition,
  getEnvironmentRevisionById,
} from "@/lib/environment/environment-definition-store";
import { activateEnvironmentLease } from "@/lib/environment/environment-lease-store";
import { seedPreparedEnvironmentLease } from "@/lib/environment/test-support/seed-prepared-environment-lease";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { getActiveExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
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
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { resolveExecutionResources } from "@/lib/runtime/application/execution-resources";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { startRuntimeInvocation } from "@/lib/runtime/application/runtime-start";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
import { createHttpRuntimeClient } from "@/lib/runtime/runtime-client";
import {
  PROTOCOL_VERSION,
  type RuntimeStartRequest,
  RuntimeStartRequestSchema,
  protocolDigest,
} from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import { takeRecoverablePauseCheckpoint } from "@/lib/workspace/checkpoint-pause";
import { getFilesystemCheckpoint } from "@/lib/workspace/checkpoint-store";
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
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  readonly releaseRequests: Array<{ checkpointIntentId: string; path: string }>;
  readonly resumeRequests: RuntimeStartRequest[];
  setCapabilitiesDigest(value: string): void;
  dispose(): Promise<void>;
}

async function startCheckpointRuntimeStub(): Promise<CheckpointRuntimeStub> {
  const safePointRequests: Array<{ checkpointIntentId: string; idempotencyKey: string }> = [];
  const releaseRequests: Array<{ checkpointIntentId: string; path: string }> = [];
  const resumeRequests: RuntimeStartRequest[] = [];
  let capabilitiesDigest = "";
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
        releaseRequests.push({ checkpointIntentId: release[1]!, path: url });
        respondJson(response, 200, { released: true });
        return;
      }
      const parsed = RuntimeStartRequestSchema.parse(body);
      resumeRequests.push(parsed);
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

describe("Checkpoint 默认端到端路径（A06）", () => {
  let temporaryRoots: string[] = [];
  const envKeys = [
    "SNOWHARNESS_WORKSPACE_HOST_URL",
    "SNOWHARNESS_WORKSPACE_HOST_ROOT",
    "SNOWHARNESS_SNAPSHOT_STORAGE_ROOT",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();
  const stubs: CheckpointRuntimeStub[] = [];
  let rpc: Awaited<ReturnType<typeof listenWorkspaceHostRpc>> | null = null;

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
      revision: {
        environmentType: "sandbox",
        filesystemPolicyJson: {},
        networkPolicyJson: {},
        resourceLimitsJson: {},
        secretPolicyJson: {},
        executionTarget: { imageDigest: `sha256:${"1".repeat(64)}` },
        requiredCapabilities: {},
        createdByType: "service",
        createdById: "test-service",
      },
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
    // 快照真的落在 `SNOWHARNESS_SNAPSHOT_STORAGE_ROOT` 指向的根里……
    await expect(readFile(path.join(ctx.storageRoot, row!.manifestRef), "utf8")).resolves.toContain(
      "state.txt",
    );
    // ……而不是恰好回退到 Broker 自己的默认存储。
    await expect(
      readFile(path.join(ctx.brokerStorageRoot, row!.manifestRef), "utf8"),
    ).rejects.toThrow();
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
    });
    const preparedEvidence = { kind: "a06-resume", attemptId: nextAttempt.id };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: nextAttempt.id,
        evidence: preparedEvidence,
        digest: protocolDigest(preparedEvidence),
      }),
    );
    const nextLease = await seedPreparedEnvironmentLease({
      tenantId: TENANT_ID,
      invocationId: ctx.invocationId,
      attemptId: nextAttempt.id,
      revision: (await getEnvironmentRevisionById(TENANT_ID, ctx.environmentRevisionId))!,
      workspaceBindingId: ctx.workspaceBindingId,
      recoveryAnchorDigest: anchorDigest,
    });

    // 生产组合层解析执行资源（与请求内联调度同源，无测试覆盖）。
    const bindingRow = (await db
      .select()
      .from(executionBindingTable)
      .where(eq(executionBindingTable.invocationId, ctx.invocationId))
      .limit(1))![0]!;
    const resources = await resolveExecutionResources({
      tenantId: TENANT_ID,
      binding: bindingRow,
      purpose: "resume",
    });
    expect(resources.workspace).toBeTruthy();
    expect(resources.workspace?.binding.id).toBe(ctx.workspaceBindingId);

    const invocation = (await readGate(ctx.invocationId))!;
    const started = await startRuntimeInvocation({
      tenantId: TENANT_ID,
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
    });
    // 远端收到的就是本次恢复锚点（不是重新算的另一个）。
    expect(ctx.stub.resumeRequests).toHaveLength(1);
    expect(ctx.stub.resumeRequests[0]?.recovery).toMatchObject({ kind: "resume", anchorDigest });

    // ⑥：恢复目录 = `prepare()` 给出的候选运行目录，落在受管写根内、控制面外。
    const canonicalExpected = path.join(
      await realpath(ctx.writerRoot),
      ".snow-runs",
      nextAttempt.id,
      `workspace:${nextAttempt.id}`,
    );
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
});
