/**
 * R07 真实验收：Environment 实例化的**实际**成功与失败。
 *
 * 层：real MySQL（testcontainers）+ real docker（受管容器）。
 *
 * 每个用例都必须落到"真实回读"上：
 * - 容器配置来自 `docker inspect`（不是 Provider 自报）；
 * - Lease/operation 归属来自真实 MySQL（Invocation/Attempt 都是真实行，满足外键）；
 * - 清理来自真实 `docker rm` + 回读确认。
 *
 * 若本机没有 docker 或候选镜像，`makeFixture` 直接抛错——这些用例**不允许静默跳过**，
 * 因为 repairs/06-environment.md 的验收要求就是"实际 MANAGED 成功与失败"。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createEnvironmentDefinition,
  createEnvironmentRevision,
  getEnvironmentDefinitionById,
  getEnvironmentRevisionById,
} from "@/lib/environment/environment-definition-store";
import {
  EnvironmentComplianceError,
  EnvironmentInstanceOperationError,
} from "@/lib/environment/environment-errors";
import {
  type EnvironmentInstanceBackend,
  type EnvironmentInstanceFacts,
  type EnvironmentInstanceRequest,
  createContainerEnvironmentBackend,
  managedContainerName,
} from "@/lib/environment/environment-instance-backend";
import { normalizeEnvironmentInstanceSpec } from "@/lib/environment/environment-instance-spec";
import {
  activateEnvironmentLease,
  createEnvironmentLease,
  getEnvironmentLeaseByAttempt,
  getEnvironmentLeaseById,
  listEnvironmentLeasesByInvocation,
  prepareEnvironmentLease,
  scheduleEnvironmentLeaseCleanup,
} from "@/lib/environment/environment-lease-store";
import {
  ENVIRONMENT_POLICY_NAMES,
  ENVIRONMENT_PREPARED_TTL_MS,
  type EnvironmentPreparedEvidence,
} from "@/lib/environment/environment-prepared-evidence";
import {
  type EnvironmentProvisioner,
  createEnvironmentProvisioner,
  environmentOperationId,
  runDueEnvironmentLeaseCleanups,
} from "@/lib/environment/environment-provisioner";
import type { EnvironmentRevisionInput } from "@/lib/environment/environment-revision";
import { createAttempt } from "@/lib/executions/persistence/attempt-store";
import { acquireExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import {
  TEST_RUNTIME_REVISION_ID,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import type { EnvironmentDefinitionRevision } from "@/lib/persistence/schema/environment-definition-revision";
import {
  dockerInfo,
  inspectContainer,
  inspectImage,
  listContainersByLabel,
  removeContainer,
} from "@/lib/runtime/container/docker-cli";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TENANT_ID = DEFAULT_TENANT_ID;
const REVISION_LABEL = "snow-harness.environment.revisionId";
const TENANT_LABEL = "snow-harness.environment.tenantId";

/** 本地优先镜像候选（macOS/Linux 的 Docker 默认共享 /private 与 /tmp）。 */
const IMAGE_CANDIDATES = [
  "debian:bookworm-slim",
  "node:24-alpine",
  "alpine/socat:latest",
  "mysql:8.0",
] as const;

/** ENV-01 的固定资源声明（回读时必须逐项相等）。 */
const MEMORY_BYTES = 128 * 1024 * 1024;
const NANO_CPUS = 500_000_000;
const PIDS_LIMIT = 64;
const OPEN_FILES_LIMIT = 128;

let dockerReady = false;
let resolvedImage: string | null = null;
let resolvedImageDigest = "";
const temporaryRoots: string[] = [];

beforeAll(async () => {
  dockerReady = await dockerInfo();
  if (!dockerReady) return;
  for (const candidate of IMAGE_CANDIDATES) {
    const inspected = await inspectImage(candidate);
    if (inspected) {
      resolvedImage = candidate;
      resolvedImageDigest = inspected.Id;
      break;
    }
  }
});

afterAll(async () => {
  // 残留容器一律按标签清理（测试失败时也不能留下真实资源）。
  if (dockerReady) {
    for (const name of await listContainersByLabel(TENANT_LABEL, TENANT_ID)) {
      await removeContainer(name);
    }
  }
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

interface EnvironmentCandidate {
  invocationId: string;
  attemptId: string;
  workspaceBindingId: string;
}

interface EnvironmentFixture {
  controlRoot: string;
  workspaceRoot: string;
  backend: EnvironmentInstanceBackend;
  provisioner: EnvironmentProvisioner;
  revisionInput(overrides?: Partial<EnvironmentRevisionInput>): EnvironmentRevisionInput;
  /** 建一个 EnvironmentDefinition，返回冻结 Revision。 */
  createManagedRevision(
    overrides?: Partial<EnvironmentRevisionInput>,
  ): Promise<{ definitionId: string; revision: EnvironmentDefinitionRevision }>;
  /** 真实 Invocation + 真实 Attempt + 真实 WorkspaceBinding（满足 EnvironmentLease 外键）。 */
  seedCandidate(environmentDefinitionRevisionId?: string): Promise<EnvironmentCandidate>;
  /** 同一 Invocation 的第二个真实 Attempt（正式 Redispatch）。 */
  seedAttempt(tenantId: string, invocationId: string): Promise<string>;
  /** 按冻结 Revision 真实实例化一次（断言聚焦在调用方）。 */
  provisionFor(input: {
    revision: EnvironmentDefinitionRevision;
    candidate: EnvironmentCandidate;
    /** Binding 冻结的 Revision id；省略时等于 `revision.id`。 */
    revisionId?: string;
    workspaceBindingId?: string;
    now?: Date;
    invocationId?: string;
    attemptId?: string;
  }): ReturnType<EnvironmentProvisioner["provision"]>;
}

async function makeFixture(): Promise<EnvironmentFixture> {
  if (!dockerReady) {
    throw new Error("R07 合规验收需要真实 docker（`docker info` 退出 0）：本用例不允许静默跳过。");
  }
  if (!resolvedImage) {
    throw new Error(`R07 合规验收需要本地具备候选镜像之一：${IMAGE_CANDIDATES.join(", ")}。`);
  }
  const image = resolvedImage;
  const imageDigest = resolvedImageDigest;
  const root = await mkdtemp(path.join(tmpdir(), "snow-env-compliance-"));
  temporaryRoots.push(root);
  const controlRoot = path.join(root, "environment-control");
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(controlRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const backend = createContainerEnvironmentBackend({ controlRoot });
  const provisioner = createEnvironmentProvisioner({ backend });

  const revisionInput = (
    overrides: Partial<EnvironmentRevisionInput> = {},
  ): EnvironmentRevisionInput => ({
    environmentType: "sandbox",
    filesystemPolicyJson: {
      readOnlyRootfs: true,
      workspaceMountPath: "/workspace",
      workspaceMountReadOnly: false,
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
      image,
      imageDigest,
      entrypoint: ["/bin/sh"],
      args: ["-c", "sleep 900"],
      workdir: "/workspace",
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
    ...overrides,
  });

  return {
    controlRoot,
    workspaceRoot,
    backend,
    provisioner,
    revisionInput,
    async createManagedRevision(overrides) {
      const definition = await createEnvironmentDefinition({
        tenantId: TENANT_ID,
        environmentKey: `env-${randomUUID().slice(0, 8)}`,
        displayName: "R07 合规环境",
        revision: revisionInput(overrides),
      });
      const revision = await getEnvironmentRevisionById(
        TENANT_ID,
        definition.currentRevisionId as string,
      );
      if (!revision) throw new Error("EnvironmentRevision 创建后回查失败");
      return { definitionId: definition.id, revision };
    },
    async seedCandidate(environmentDefinitionRevisionId) {
      const seeded = await seedPreparedRuntimeAttempt(
        environmentDefinitionRevisionId ? { environmentDefinitionRevisionId } : {},
      );
      return {
        invocationId: seeded.invocation.id,
        attemptId: seeded.attempt.id,
        workspaceBindingId: seeded.workspace.id,
      };
    },
    async seedAttempt(tenantId, invocationId) {
      const attempt = await createAttempt({ tenantId, invocationId });
      return attempt.id;
    },
    provisionFor(input) {
      return provisioner.provision({
        tenantId: TENANT_ID,
        invocationId: input.invocationId ?? input.candidate.invocationId,
        attemptId: input.attemptId ?? input.candidate.attemptId,
        revisionId: input.revisionId ?? input.revision.id,
        revision: input.revision,
        workspaceBindingId: input.workspaceBindingId ?? input.candidate.workspaceBindingId,
        workspaceRoot,
        ...(input.now ? { now: input.now } : {}),
      });
    },
  };
}

function preparedEvidenceOf(lease: { preparedEvidence: unknown }): EnvironmentPreparedEvidence {
  const evidence = lease.preparedEvidence as EnvironmentPreparedEvidence | null;
  if (!evidence) throw new Error("Lease 缺少 preparedEvidence");
  return evidence;
}

function operationIdOf(lease: { resourceManifest: unknown }): string {
  const manifest = (lease.resourceManifest ?? {}) as Record<string, unknown>;
  const operationId = manifest.operationId;
  if (typeof operationId !== "string") throw new Error("Lease 缺少 operationId");
  return operationId;
}

/** 包一层 Backend，让前 N 次 `release` 真实失败（模拟清理 Worker 第一次失败）。 */
function backendWithFailingRelease(
  inner: EnvironmentInstanceBackend,
  failures: number,
): EnvironmentInstanceBackend {
  let remaining = failures;
  return {
    kind: inner.kind,
    create: (input) => inner.create(input),
    inspect: (input) => inner.inspect(input),
    queryOperation: (operationId) => inner.queryOperation(operationId),
    async release(input) {
      if (remaining > 0) {
        remaining -= 1;
        throw new EnvironmentInstanceOperationError(
          "注入的释放失败（模拟清理 Worker 第一次失败）",
          "release",
        );
      }
      return inner.release(input);
    },
  };
}

describe("R07 真实 Environment 实例化与合规", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  it("ENV-01: 真实 MANAGED Provider 按冻结 Revision 施加镜像/入口/资源/文件/网络策略，并以真实回读作为受管证据", async () => {
    const fixture = await makeFixture();
    const { revision } = await fixture.createManagedRevision();
    const candidate = await fixture.seedCandidate();

    const lease = await fixture.provisionFor({ revision, candidate });

    // Lease 语义：prepared 只说明实例准备好，与 Writer 激活无关。
    expect(lease.leaseState).toBe("allocated");
    expect(lease.readinessState).toBe("prepared");
    expect(lease.activationOwnershipId).toBeNull();
    expect(lease.preparedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const evidence = preparedEvidenceOf(lease);
    expect(evidence.revisionId).toBe(revision.id);
    expect(evidence.semanticDigest).toBe(revision.semanticDigest);
    expect(evidence.candidate.attemptId).toBe(candidate.attemptId);
    expect(evidence.candidate.workspaceBindingId).toBe(candidate.workspaceBindingId);
    expect(evidence.actualTargetDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.instance.backendKind).toBe("container");
    // 受管容器的存储身份 = 固定的镜像身份（71 字符，等于 storageIdentity 列宽）。
    expect(evidence.instance.storageIdentity).toBe(resolvedImageDigest);
    expect(evidence.verifier.kind).toBe("docker_inspect");
    expect(evidence.verifier.ref).toBe(evidence.instance.workerRef);

    // 六项策略全部有实际回读值 + 可回读检查凭据，且都 satisfied。
    expect(evidence.policyChecks.map((entry) => entry.policy).sort()).toEqual(
      [...ENVIRONMENT_POLICY_NAMES].sort(),
    );
    for (const entry of evidence.policyChecks) {
      expect(entry.actual).toBeDefined();
      expect(entry.satisfied).toBe(true);
      expect(entry.check.kind).toBe("instance_probe");
      expect(entry.check.ref).toContain("docker inspect");
      expect(entry.check.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    // 受管 operation 归属（Write-Ahead）：Crash 后可按 operationId 回读。
    const operationId = operationIdOf(lease);
    const operation = await fixture.backend.queryOperation(operationId);
    expect(operation).not.toBeNull();
    expect(operation).toMatchObject({
      state: "created",
      leaseId: lease.id,
      revisionId: revision.id,
      backendKind: "container",
    });
    expect(operation?.resources).toEqual([
      { kind: "container", ref: evidence.instance.workerRef, identity: resolvedImageDigest },
    ]);

    // 真实回读：镜像/入口/资源/文件/网络/进程隔离逐项来自 docker inspect。
    const name = evidence.instance.workerRef;
    const inspected = await inspectContainer(name);
    expect(inspected).not.toBeNull();
    expect(inspected?.State.Running).toBe(true);
    expect(inspected?.Image).toBe(resolvedImageDigest);
    expect(inspected?.Config.Entrypoint).toEqual(["/bin/sh"]);
    expect(inspected?.Config.Cmd).toEqual(["-c", "sleep 900"]);
    expect(inspected?.Config.WorkingDir).toBe("/workspace");
    expect(inspected?.Config.Labels?.[REVISION_LABEL]).toBe(revision.id);
    expect(inspected?.HostConfig.Memory).toBe(MEMORY_BYTES);
    expect(inspected?.HostConfig.NanoCpus).toBe(NANO_CPUS);
    expect(inspected?.HostConfig.PidsLimit).toBe(PIDS_LIMIT);
    expect(inspected?.HostConfig.Ulimits?.find((entry) => entry.Name === "nofile")).toMatchObject({
      Soft: OPEN_FILES_LIMIT,
      Hard: OPEN_FILES_LIMIT,
    });
    expect(inspected?.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspected?.HostConfig.NetworkMode).toBe("none");
    expect(inspected?.HostConfig.Privileged).toBe(false);
    expect(inspected?.HostConfig.PidMode).toBe("");
    expect(inspected?.Mounts.map((mount) => mount.Destination)).toEqual(["/workspace"]);
    expect(inspected?.Mounts[0]?.RW).toBe(true);
  });

  it("ENV-02: Provider 声称能力满足但实际策略不满足 → 不进入 prepared/ready、不 Start，且不留无主资源", async () => {
    const fixture = await makeFixture();
    // (a) 声明 requiredCapabilities.networkIsolation=true，但 Revision 选的是 open 网络：
    // 实际回读能力 networkIsolation=false，控制面必须拒绝承认这次准备。
    const { revision } = await fixture.createManagedRevision({
      networkPolicyJson: { mode: "open" },
      requiredCapabilities: {
        containerized: true,
        processIsolation: true,
        networkIsolation: true,
      },
    });
    const candidate = await fixture.seedCandidate();

    await expect(fixture.provisionFor({ revision, candidate })).rejects.toBeInstanceOf(
      EnvironmentComplianceError,
    );

    const blocked = await getEnvironmentLeaseByAttempt(
      TENANT_ID,
      candidate.invocationId,
      candidate.attemptId,
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.readinessState).not.toBe("prepared");
    expect(blocked?.readinessState).not.toBe("ready");
    expect(blocked?.preparedEvidence).toBeNull();
    // 不 Start：未 prepared 的 Lease 无法被激活交接。
    await expect(
      activateEnvironmentLease({
        tenantId: TENANT_ID,
        leaseId: blocked?.id as string,
        ownershipId: randomUUID(),
        attemptId: candidate.attemptId,
        invocationId: candidate.invocationId,
        environmentDefinitionRevisionId: revision.id,
      }),
    ).rejects.toThrow();

    // 真实资源已被登记归属并被真实释放：不留无主容器。
    const operationId = environmentOperationId({
      environmentDefinitionRevisionId: revision.id,
      attemptId: candidate.attemptId,
    });
    const operation = await fixture.backend.queryOperation(operationId);
    expect(operation).not.toBeNull();
    expect(operation?.state).toBe("released");
    expect(await inspectContainer(managedContainerName(operationId))).toBeNull();

    // (b) 自报证据不被接受：`evidence ?? {verified:true}` 的默认成功路径必须已消失。
    const { revision: lenient } = await fixture.createManagedRevision({ requiredCapabilities: {} });
    const lenientCandidate = await fixture.seedCandidate();
    const lenientLease = await createEnvironmentLease({
      tenantId: TENANT_ID,
      invocationId: lenientCandidate.invocationId,
      attemptId: lenientCandidate.attemptId,
      environmentDefinitionRevisionId: lenient.id,
      // 归属已登记：本段要证明的是"自报证据不被接受"，不能因为缺归属而误判通过。
      resourceManifest: {
        operationId: environmentOperationId({
          environmentDefinitionRevisionId: lenient.id,
          attemptId: lenientCandidate.attemptId,
        }),
        workspaceBindingId: lenientCandidate.workspaceBindingId,
        revisionId: lenient.id,
        revisionSemanticDigest: lenient.semanticDigest,
        recoveryAnchorDigest: null,
        backendKind: "container",
        resources: [],
      },
    });
    await expect(
      prepareEnvironmentLease({
        tenantId: TENANT_ID,
        leaseId: lenientLease.id,
        capabilitiesJson: { verified: true, containerized: true },
        evidence: { verified: true } as never,
      }),
    ).rejects.toThrow(/PreparedEvidence|符合性证据/);
    const afterSelfReport = await getEnvironmentLeaseById(TENANT_ID, lenientLease.id);
    expect(afterSelfReport?.readinessState).toBe("unresolved");
    expect(afterSelfReport?.leaseState).toBe("allocated");
  });

  it("ENV-03: 同 Attempt 网络重试复用同一 Lease 与同一真实资源；正式新 Attempt 才新建 Lease 但实现同一 Revision", async () => {
    const fixture = await makeFixture();
    const { revision } = await fixture.createManagedRevision();
    // MANAGED 执行要求 Binding 冻结 EnvironmentDefinitionRevision（Acquire 会逐项复验），
    // 因此夹具的候选 Attempt 也必须来自一份声明了该 Revision 的真实 Binding。
    const candidate = await fixture.seedCandidate(revision.id);

    const first = await fixture.provisionFor({ revision, candidate });
    const firstName = preparedEvidenceOf(first).instance.workerRef;
    const firstContainer = await inspectContainer(firstName);
    expect(firstContainer).not.toBeNull();

    // 同 Attempt Transport Retry：同一 Lease、同一容器、同一 operation。
    const retried = await fixture.provisionFor({ revision, candidate });
    expect(retried.id).toBe(first.id);
    expect(preparedEvidenceOf(retried).instance.workerRef).toBe(firstName);
    expect(operationIdOf(retried)).toBe(operationIdOf(first));
    expect((await inspectContainer(firstName))?.Id).toBe(firstContainer?.Id);
    expect(await listEnvironmentLeasesByInvocation(TENANT_ID, candidate.invocationId)).toHaveLength(
      1,
    );

    // 同 Attempt 的重试也可能发生在 **activation 之后**：入口进程在 Runtime Transport 调用处
    // 死亡（Owner 已激活、Lease 已 ready、Session 已冻结启动意图），后台 lane 按持久事实重投。
    // 此时"复用同一 Lease / 同一资源"必须同样成立：把 `ready` 排除在复用之外会走进
    // create → prepare 分支，先真实创建出第二份实例，再被 Lease 状态机（只接受
    // unresolved/preparing）判成终态失败 —— 一次合法的重投变成不可恢复的失败。
    const ownership = await acquireExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: candidate.invocationId,
      attemptId: candidate.attemptId,
      runtimeRevisionId: TEST_RUNTIME_REVISION_ID,
      environmentLeaseId: first.id,
      acquiredByType: "service",
      acquiredById: "test-runtime",
    });
    const activated = await activateEnvironmentLease({
      tenantId: TENANT_ID,
      leaseId: first.id,
      ownershipId: ownership.ownership.id,
      attemptId: candidate.attemptId,
      invocationId: candidate.invocationId,
      environmentDefinitionRevisionId: revision.id,
    });
    expect(activated.readinessState).toBe("ready");

    const retriedAfterActivation = await fixture.provisionFor({ revision, candidate });
    expect(retriedAfterActivation.id).toBe(first.id);
    expect(retriedAfterActivation.readinessState).toBe("ready");
    expect(preparedEvidenceOf(retriedAfterActivation).instance.workerRef).toBe(firstName);
    // 没有重新实例化，也没有重写 Prepared 证据（Prepared 事实保持同一份）。
    expect(retriedAfterActivation.preparedDigest).toBe(first.preparedDigest);
    expect((await inspectContainer(firstName))?.Id).toBe(firstContainer?.Id);
    expect(await listEnvironmentLeasesByInvocation(TENANT_ID, candidate.invocationId)).toHaveLength(
      1,
    );

    // 正式新 Attempt（Redispatch）：新 Lease + 新真实资源，但实现同一冻结 Revision。
    const attemptB = await fixture.seedAttempt(TENANT_ID, candidate.invocationId);
    const redispatched = await fixture.provisionFor({ revision, candidate, attemptId: attemptB });
    expect(redispatched.id).not.toBe(first.id);
    expect(redispatched.environmentDefinitionRevisionId).toBe(revision.id);
    expect(first.environmentDefinitionRevisionId).toBe(revision.id);
    const secondName = preparedEvidenceOf(redispatched).instance.workerRef;
    expect(secondName).not.toBe(firstName);
    expect(operationIdOf(redispatched)).not.toBe(operationIdOf(first));
    expect(await inspectContainer(secondName)).not.toBeNull();
    // 两个 Lease 实现的是同一 Revision 的同一实际目标。
    expect(preparedEvidenceOf(redispatched).actualTargetDigest).toBe(
      preparedEvidenceOf(first).actualTargetDigest,
    );
    expect(await listEnvironmentLeasesByInvocation(TENANT_ID, candidate.invocationId)).toHaveLength(
      2,
    );
  });

  it("ENV-04: 过期 / 换 Revision / 换 Workspace / 恢复水位变化 → Acquire 与 activation 复验拒绝旧准备证据", async () => {
    const fixture = await makeFixture();
    const { revision } = await fixture.createManagedRevision();
    const other = await fixture.createManagedRevision({
      resourceLimitsJson: {
        memoryBytes: 64 * 1024 * 1024,
        cpus: 0.25,
        pidsLimit: 32,
        openFilesLimit: 64,
      },
    });
    const candidate = await fixture.seedCandidate();
    const base = new Date();

    const lease = await fixture.provisionFor({ revision, candidate, now: base });

    // (a) 超过 Prepared 有效期（≤60s）：activation 复验拒绝。
    await expect(
      activateEnvironmentLease({
        tenantId: TENANT_ID,
        leaseId: lease.id,
        ownershipId: randomUUID(),
        attemptId: candidate.attemptId,
        invocationId: candidate.invocationId,
        environmentDefinitionRevisionId: revision.id,
        now: new Date(base.getTime() + ENVIRONMENT_PREPARED_TTL_MS + 1_000),
      }),
    ).rejects.toThrow(/过期/);

    // (b) 换 Revision：Lease 引用其他 EnvironmentRevision。
    await expect(
      activateEnvironmentLease({
        tenantId: TENANT_ID,
        leaseId: lease.id,
        ownershipId: randomUUID(),
        attemptId: candidate.attemptId,
        invocationId: candidate.invocationId,
        environmentDefinitionRevisionId: other.revision.id,
        now: base,
      }),
    ).rejects.toThrow(/其他 EnvironmentRevision/);

    // (c) 恢复水位（Anchor）变化：旧准备证据失效。
    await expect(
      activateEnvironmentLease({
        tenantId: TENANT_ID,
        leaseId: lease.id,
        ownershipId: randomUUID(),
        attemptId: candidate.attemptId,
        invocationId: candidate.invocationId,
        environmentDefinitionRevisionId: revision.id,
        recoveryAnchorDigest: protocolDigest({ anchor: "changed" }),
        now: base,
      }),
    ).rejects.toThrow(/恢复 Anchor/);

    // (d) 换 WorkspaceBinding：Provisioner 复验拒绝。
    await expect(
      fixture.provisioner.revalidate({
        tenantId: TENANT_ID,
        lease,
        revisionId: revision.id,
        revision,
        workspaceBindingId: randomUUID(),
        workspaceRoot: fixture.workspaceRoot,
        now: base,
      }),
    ).rejects.toThrow(/其他 WorkspaceBinding/);

    // (e) Acquire 路径同样复验：真实 ExecutionBinding(MANAGED→R1) + 真实 Attempt。
    const okCandidate = await fixture.seedCandidate(revision.id);
    const okLease = await fixture.provisionFor({ revision, candidate: okCandidate });
    // 另一条真实候选：ExecutionBinding 冻结的 Workspace 与准备证据绑定的 Workspace 不同
    //（Prepare 之后 Workspace 换了）→ 事务内复验必须拒绝。
    const rebound = await fixture.seedCandidate(revision.id);
    const misboundLease = await fixture.provisionFor({
      revision,
      candidate: rebound,
      workspaceBindingId: randomUUID(),
    });
    expect(misboundLease.readinessState).toBe("prepared");
    await expect(
      acquireExecutionOwnership({
        tenantId: TENANT_ID,
        invocationId: rebound.invocationId,
        attemptId: rebound.attemptId,
        runtimeRevisionId: TEST_RUNTIME_REVISION_ID,
        environmentLeaseId: misboundLease.id,
        acquiredByType: "service",
        acquiredById: "test-runtime",
      }),
    ).rejects.toThrow(/其他 WorkspaceBinding/);

    // 同一 Attempt 的合法证据仍可通过（证明上面的拒绝来自证据本身而非总是失败）。
    const acquired = await acquireExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: okCandidate.invocationId,
      attemptId: okCandidate.attemptId,
      runtimeRevisionId: TEST_RUNTIME_REVISION_ID,
      environmentLeaseId: okLease.id,
      acquiredByType: "service",
      acquiredById: "test-runtime",
    });
    expect(acquired.ownership.environmentLeaseId).toBe(okLease.id);
  });

  it("ENV-05: Default 已改为 R2，旧 Binding 冻结 R1 的 Redispatch 只实例化 R1；R1 不可用时 fail closed", async () => {
    const fixture = await makeFixture();
    const { definitionId, revision: r1 } = await fixture.createManagedRevision();
    const r2 = await createEnvironmentRevision(
      TENANT_ID,
      definitionId,
      fixture.revisionInput({
        resourceLimitsJson: {
          memoryBytes: 256 * 1024 * 1024,
          cpus: 1,
          pidsLimit: 32,
          openFilesLimit: 64,
        },
      }),
    );
    const definition = await getEnvironmentDefinitionById(TENANT_ID, definitionId);
    expect(definition?.currentRevisionId).toBe(r2.id);

    const candidate = await fixture.seedCandidate();
    const lease = await fixture.provisionFor({ revision: r1, candidate });

    // 只实例化 R1：真实容器配置是 R1 的值，不是 Default R2 的值。
    const name = preparedEvidenceOf(lease).instance.workerRef;
    const inspected = await inspectContainer(name);
    expect(inspected).not.toBeNull();
    expect(inspected?.HostConfig.Memory).toBe(MEMORY_BYTES);
    expect(inspected?.HostConfig.NanoCpus).toBe(NANO_CPUS);
    expect(inspected?.Config.Labels?.[REVISION_LABEL]).toBe(r1.id);
    expect(await listContainersByLabel(REVISION_LABEL, r2.id)).toEqual([]);

    // 传入非冻结 Revision → 拒绝（执行只从 Binding 冻结的那一份读取）。
    await expect(
      fixture.provisionFor({ revision: r2, revisionId: r1.id, candidate }),
    ).rejects.toThrow(/冻结/);

    // R1 在受管 Host 上不可用（镜像不存在）→ fail closed，不静默改用 Default R2。
    const badDefinition = await createEnvironmentDefinition({
      tenantId: TENANT_ID,
      environmentKey: `env-absent-${randomUUID().slice(0, 8)}`,
      displayName: "缺失镜像环境",
      revision: fixture.revisionInput({
        executionTarget: {
          kind: "container",
          image: "snowharness/absent-runtime:fixed",
          imageDigest: `sha256:${"a".repeat(64)}`,
          entrypoint: ["/bin/sh"],
          args: ["-c", "sleep 5"],
        },
      }),
    });
    const rAbsent = await getEnvironmentRevisionById(
      TENANT_ID,
      badDefinition.currentRevisionId as string,
    );
    const absentCandidate = await fixture.seedCandidate();
    await expect(
      fixture.provisionFor({
        revision: rAbsent as EnvironmentDefinitionRevision,
        candidate: absentCandidate,
      }),
    ).rejects.toBeInstanceOf(EnvironmentComplianceError);

    const absentLease = await getEnvironmentLeaseByAttempt(
      TENANT_ID,
      absentCandidate.invocationId,
      absentCandidate.attemptId,
    );
    expect(absentLease).not.toBeNull();
    expect(absentLease?.readinessState).not.toBe("prepared");
    expect(absentLease?.readinessState).not.toBe("ready");
    await expect(
      activateEnvironmentLease({
        tenantId: TENANT_ID,
        leaseId: absentLease?.id as string,
        ownershipId: randomUUID(),
        attemptId: absentCandidate.attemptId,
        invocationId: absentCandidate.invocationId,
        environmentDefinitionRevisionId: rAbsent?.id as string,
      }),
    ).rejects.toThrow();
    // 没有回退去实例化 Default R2。
    expect(await listContainersByLabel(REVISION_LABEL, r2.id)).toEqual([]);
  });

  it("ENV-06: Provision 过程中 Crash + 清理第一次失败 → 归属可回读、Worker 重试真实清理，不泄漏也不误删他人资源", async () => {
    const fixture = await makeFixture();
    const { revision } = await fixture.createManagedRevision();
    const candidate = await fixture.seedCandidate();

    // 模拟 Crash：Create 了真实资源，但控制面还没写下 prepared（进程在事务前死掉）。
    const spec = normalizeEnvironmentInstanceSpec(revision);
    const operationId = environmentOperationId({
      environmentDefinitionRevisionId: revision.id,
      attemptId: candidate.attemptId,
    });
    const lease = await createEnvironmentLease({
      tenantId: TENANT_ID,
      invocationId: candidate.invocationId,
      attemptId: candidate.attemptId,
      environmentDefinitionRevisionId: revision.id,
      resourceManifest: {
        operationId,
        workspaceBindingId: candidate.workspaceBindingId,
        revisionId: revision.id,
        revisionSemanticDigest: revision.semanticDigest,
        backendKind: "container",
      },
    });
    const request: EnvironmentInstanceRequest = {
      tenantId: TENANT_ID,
      invocationId: candidate.invocationId,
      attemptId: candidate.attemptId,
      leaseId: lease.id,
      operationId,
      spec,
      workspaceRoot: fixture.workspaceRoot,
      recoveryAnchorDigest: null,
      workspaceBindingId: candidate.workspaceBindingId,
    };
    const facts: EnvironmentInstanceFacts = await fixture.backend.create(request);
    const name = facts.identity.workerRef;
    expect(await inspectContainer(name)).not.toBeNull();

    // 归属可回读（Crash 后按稳定 operation 找到已创建资源）。
    const operation = await fixture.backend.queryOperation(operationId);
    expect(operation).toMatchObject({ state: "created", leaseId: lease.id });
    expect(operation?.resources[0]).toMatchObject({ kind: "container", ref: name });

    // 恢复方登记持久清理工作（第一次立即尝试）。
    await scheduleEnvironmentLeaseCleanup({
      tenantId: TENANT_ID,
      leaseId: lease.id,
      errorCode: "ProvisionCrashed",
      immediate: true,
      resourceManifestPatch: {
        operationId,
        workspaceBindingId: candidate.workspaceBindingId,
        resources: facts.resources,
      },
    });

    // 另一份真实资源（别人的 Lease）：清理 A 时绝不能被误删。
    const bystander = await fixture.provisionFor({
      revision,
      candidate: await fixture.seedCandidate(),
    });
    const bystanderName = preparedEvidenceOf(bystander).instance.workerRef;

    // 第一次清理真实失败 → 保持 releasing + 退避重试，容器仍在。
    const failing = backendWithFailingRelease(fixture.backend, 1);
    const firstSweep = await runDueEnvironmentLeaseCleanups({
      backend: failing,
      owner: "cleanup-worker-1",
    });
    expect(firstSweep.released).toBe(0);
    expect(firstSweep.pendingRetry).toBe(1);
    const afterFailure = await getEnvironmentLeaseById(TENANT_ID, lease.id);
    expect(afterFailure?.leaseState).toBe("releasing");
    expect(afterFailure?.cleanupCount).toBe(1);
    expect(afterFailure?.nextCleanupAt).not.toBeNull();
    expect(await inspectContainer(name)).not.toBeNull();

    // Worker 到点重试 → 真实释放，控制面才写 released。
    const retryAt = new Date((afterFailure?.nextCleanupAt as Date).getTime() + 1);
    const retried = await runDueEnvironmentLeaseCleanups({
      backend: fixture.backend,
      owner: "cleanup-worker-2",
      now: retryAt,
    });
    expect(retried.released).toBe(1);
    const released = await getEnvironmentLeaseById(TENANT_ID, lease.id);
    expect(released?.leaseState).toBe("released");
    expect(await inspectContainer(name)).toBeNull();
    expect((await fixture.backend.queryOperation(operationId))?.state).toBe("released");

    // 别人的资源未被触碰。
    expect(await inspectContainer(bystanderName)).not.toBeNull();
    const bystanderLease = await getEnvironmentLeaseById(TENANT_ID, bystander.id);
    expect(bystanderLease?.leaseState).toBe("allocated");
    expect(bystanderLease?.readinessState).toBe("prepared");
  });
});
