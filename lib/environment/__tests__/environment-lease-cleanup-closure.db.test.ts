/**
 * A08：环境资源**终态清理与后台回收闭环**（审查报告 cceffbb3 §A08）。
 *
 * 三条缺陷分别编码为可执行回归，全部走真实 MySQL + 真实 docker 容器，不注入替身：
 *
 * 1. **8.1 逻辑收口不等于实际资源释放**（A08-01/02/03）：正常终态、Owner 失权接管、
 *    Owner 失联收口都必须在该出口**登记持久清理工作**，并且只登记（`releasing` +
 *    `releasedAt` 仍为空）——真实容器此刻**仍然在运行**。只有清理 Worker 用真实
 *    `docker rm` 并回读确认之后，控制面才允许写 `released`。三条用例末尾都断言
 *    `docker inspect` 从"存在"变成"不存在"。
 * 2. **8.2 清理领取不是条件领取**（A08-04/05）：两个清理进程并发领取同一 Lease 时只能有
 *    一个真的执行释放；旧领取者的迟到完成/失败不得覆盖新领取者的结论。
 * 3. **8.3 释放扫描的饥饿条件**：见 `lib/workspace/__tests__/workspace-writer-release.integration.test.ts`
 *    的 `WFENCE-08`（扫描候选集与批次公平性属于 Workspace 侧）。
 *
 * 若本机没有 docker 或候选镜像，`makeFixture` 直接抛错——这些用例**不允许静默跳过**。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createEnvironmentDefinition,
  getEnvironmentRevisionById,
} from "@/lib/environment/environment-definition-store";
import {
  type EnvironmentInstanceBackend,
  createContainerEnvironmentBackend,
} from "@/lib/environment/environment-instance-backend";
import {
  activateEnvironmentLease,
  claimEnvironmentLeaseCleanup,
  completeEnvironmentLeaseCleanup,
  getEnvironmentLeaseById,
  recordEnvironmentLeaseCleanupFailure,
  scheduleEnvironmentLeaseCleanup,
  scheduleEnvironmentLeaseCleanupForPreparationClaim,
} from "@/lib/environment/environment-lease-store";
import {
  createEnvironmentProvisioner,
  runDueEnvironmentLeaseCleanups,
  runEnvironmentLeaseCleanup,
} from "@/lib/environment/environment-provisioner";
import type { EnvironmentRevisionInput } from "@/lib/environment/environment-revision";
import {
  ATTEMPT_PREPARATION_LEASE_MS,
  claimAttemptPreparation,
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { acquireExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import {
  attemptPreparationClaimForTest,
  executionSourceForTest,
  markAttemptPreparedForTestInTransaction,
} from "@/lib/executions/test-support/preparation-fixtures";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import type { EnvironmentDefinitionRevision } from "@/lib/persistence/schema/environment-definition-revision";
import {
  executionOwnershipTable,
  invocationAttemptTable,
} from "@/lib/persistence/schema/executions";
import { markInvocationLost, readObservedOwner } from "@/lib/runtime/application/runtime-recovery";
import {
  handOffSupervisorGeneration,
  hostedRuntimeApplicationService,
} from "@/lib/runtime/application/runtime-resume";
import {
  dockerInfo,
  inspectContainer,
  inspectImage,
  listContainersByLabel,
  removeContainer,
} from "@/lib/runtime/container/docker-cli";
import { claimRuntimeSessionSupervisorInTransaction } from "@/lib/runtime/persistence/runtime-session-store";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TENANT_ID = DEFAULT_TENANT_ID;
const TENANT_LABEL = "snow-harness.environment.tenantId";
const MEMORY_BYTES = 128 * 1024 * 1024;

/** 本地优先镜像候选（与 R07 一致的共享目录语义）。 */
const IMAGE_CANDIDATES = [
  "debian:bookworm-slim",
  "node:24-alpine",
  "alpine/socat:latest",
  "mysql:8.0",
] as const;

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
  // 失败路径也不能留下真实资源：按租户标签兜底清理。
  if (dockerReady) {
    for (const name of await listContainersByLabel(TENANT_LABEL, TENANT_ID)) {
      await removeContainer(name);
    }
  }
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

interface ManagedFixture {
  backend: EnvironmentInstanceBackend;
  provisioner: ReturnType<typeof createEnvironmentProvisioner>;
  workspaceRoot: string;
  revision: EnvironmentDefinitionRevision;
  /**
   * 真实建出「容器 + Prepared Lease + 已激活 Writer 的 Current Ownership」。
   *
   * 不伪造任何 lease/ownership 事实：Provision 走真实 Backend（`docker run` + `docker inspect`），
   * Acquire 走真实执行权仓储（含 Prepared 证据复核），激活走 `activateEnvironmentLease`。
   */
  seedManagedAuthority(): Promise<{
    invocationId: string;
    attemptId: string;
    ownershipId: string;
    sessionBindingId: string;
    leaseId: string;
    containerName: string;
    authority: Awaited<ReturnType<typeof acquireTestRuntimeAuthority>>["authority"];
  }>;
}

async function makeFixture(): Promise<ManagedFixture> {
  if (!dockerReady) {
    throw new Error("A08 验收需要真实 docker（`docker info` 退出 0）：本用例不允许静默跳过。");
  }
  if (!resolvedImage) {
    throw new Error(`A08 验收需要本地具备候选镜像之一：${IMAGE_CANDIDATES.join(", ")}。`);
  }
  const image = resolvedImage;
  const imageDigest = resolvedImageDigest;
  const root = await mkdtemp(path.join(tmpdir(), "snow-env-cleanup-"));
  temporaryRoots.push(root);
  const controlRoot = path.join(root, "environment-control");
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(controlRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const backend = createContainerEnvironmentBackend({ controlRoot });
  const provisioner = createEnvironmentProvisioner({ backend });

  const revisionInput: EnvironmentRevisionInput = {
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
      pidsLimit: 64,
      openFilesLimit: 128,
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
  };

  const definition = await createEnvironmentDefinition({
    tenantId: TENANT_ID,
    environmentKey: `env-cleanup-${randomUUID().slice(0, 8)}`,
    displayName: "A08 清理闭环环境",
    revision: revisionInput,
  });
  const revision = await getEnvironmentRevisionById(
    TENANT_ID,
    definition.currentRevisionId as string,
  );
  if (!revision) throw new Error("EnvironmentRevision 创建后回查失败");

  return {
    backend,
    provisioner,
    workspaceRoot,
    revision,
    async seedManagedAuthority() {
      const seeded = await seedPreparedRuntimeAttempt({
        environmentDefinitionRevisionId: revision.id,
      });
      const preparationClaim = await attemptPreparationClaimForTest(seeded.attempt.id);
      const lease = await provisioner.provision({
        tenantId: TENANT_ID,
        invocationId: seeded.invocation.id,
        attemptId: seeded.attempt.id,
        revisionId: revision.id,
        revision,
        workspaceBindingId: seeded.workspace.id,
        workspaceRoot,
        preparationClaim,
      });
      if (!lease.preparedEvidence || !lease.preparedDigest) {
        throw new Error("EnvironmentLease 缺少 Prepared 证据");
      }
      const authority = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: seeded.invocation.id,
        attemptId: seeded.attempt.id,
        runtimeRevisionId: seeded.binding.runtimeRevisionId,
        environmentLeaseId: lease.id,
      });
      await activateEnvironmentLease({
        tenantId: TENANT_ID,
        leaseId: lease.id,
        ownershipId: authority.ownership.id,
        attemptId: seeded.attempt.id,
        invocationId: seeded.invocation.id,
        environmentDefinitionRevisionId: revision.id,
        recoveryAnchorDigest: null,
      });
      const activated = await getEnvironmentLeaseById(TENANT_ID, lease.id);
      if (!activated) throw new Error("EnvironmentLease 激活后回查失败");
      const evidence = activated.preparedEvidence as { instance?: { workerRef?: string } } | null;
      const containerName = evidence?.instance?.workerRef;
      if (!containerName) throw new Error("Prepared 证据缺少容器名（workerRef）");
      return {
        invocationId: seeded.invocation.id,
        attemptId: seeded.attempt.id,
        ownershipId: authority.ownership.id,
        sessionBindingId: authority.session.id,
        leaseId: lease.id,
        containerName,
        authority: authority.authority,
      };
    },
  };
}

/** 把仍 active 的代际置为已过期（必须满足 `leaseExpiresAt > acquiredAt` 的形状约束）。 */
async function expireOwnershipLease(ownershipId: string): Promise<void> {
  const [owner] = await db
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, TENANT_ID),
        eq(executionOwnershipTable.id, ownershipId),
      ),
    )
    .limit(1);
  if (!owner) throw new Error(`ExecutionOwnership 不存在（id=${ownershipId}）`);
  await db
    .update(executionOwnershipTable)
    .set({
      leaseExpiresAt: new Date(owner.acquiredAt.getTime() + 1),
      lastHeartbeatAt: owner.acquiredAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(executionOwnershipTable.tenantId, TENANT_ID),
        eq(executionOwnershipTable.id, ownershipId),
      ),
    );
}

describe("A08 环境资源终态清理与回收闭环", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  it("A08-01: 正常终态出口只登记清理（容器仍在），真实释放后才写 released", async () => {
    const fixture = await makeFixture();
    const seeded = await fixture.seedManagedAuthority();
    expect(await inspectContainer(seeded.containerName)).not.toBeNull();

    // 正式生命周期出口：真实 Hosted Cancel（与 Ingress 终态共用同一收口实现）。
    await hostedRuntimeApplicationService.cancel({
      tenantId: TENANT_ID,
      invocationId: seeded.invocationId,
      idempotencyKey: `cancel:${randomUUID()}`,
      authority: seeded.authority,
      reason: "user_cancelled",
    });

    const afterExit = await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId);
    // 出口只能登记：进入非终态的 releasing，**不得**声明物理已释放。
    expect(afterExit?.leaseState).toBe("releasing");
    expect(afterExit?.releasedAt).toBeNull();
    // 真实资源此刻仍然存在 —— 这正是"逻辑收口 ≠ 实际释放"的可证伪表述。
    expect(await inspectContainer(seeded.containerName)).not.toBeNull();

    // 清理 Worker 用真实 Backend 释放（docker rm + 回读确认）后才写 released。
    const sweep = await runDueEnvironmentLeaseCleanups({
      backend: fixture.backend,
      owner: "cleanup-worker:1",
    });
    expect(sweep.released).toBe(1);
    const released = await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId);
    expect(released?.leaseState).toBe("released");
    expect(released?.releasedAt).not.toBeNull();
    expect(await inspectContainer(seeded.containerName)).toBeNull();
  }, 60_000);

  it("N07-T1/N07-T3: MANAGED 主动交接登记旧 Lease，释放失败及进程退出后由原 Worker 真实重试", async () => {
    const fixture = await makeFixture();
    const seeded = await fixture.seedManagedAuthority();
    const claimId = randomUUID();
    const now = new Date();
    const claim = await db.transaction((tx) =>
      claimRuntimeSessionSupervisorInTransaction(tx, {
        tenantId: TENANT_ID,
        id: seeded.sessionBindingId,
        claimId,
        instanceId: `worker-instance:${randomUUID()}`,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        now,
      }),
    );
    expect(claim.claimed).toBe(true);
    await handOffSupervisorGeneration({
      tenantId: TENANT_ID,
      invocationId: seeded.invocationId,
      ownershipId: seeded.ownershipId,
      attemptId: seeded.attemptId,
      leaseEpoch: Number(seeded.authority.leaseEpoch),
      sessionBindingId: seeded.sessionBindingId,
      claimId,
    });
    const retiring = await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId);
    expect(retiring?.leaseState).toBe("releasing");
    expect(retiring?.releasedAt).toBeNull();
    expect(await inspectContainer(seeded.containerName)).not.toBeNull();

    let releaseCalls = 0;
    const failOnceBackend: EnvironmentInstanceBackend = {
      ...fixture.backend,
      async release(input) {
        releaseCalls += 1;
        if (releaseCalls === 1) throw new Error("simulated backend release interruption");
        return fixture.backend.release(input);
      },
    };
    const first = await runEnvironmentLeaseCleanup({
      tenantId: TENANT_ID,
      leaseId: seeded.leaseId,
      backend: failOnceBackend,
      owner: "cleanup-worker:n07:first-process",
    });
    expect(first.state).toBe("pending_retry");
    const pending = await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId);
    expect(pending?.leaseState).toBe("releasing");
    expect(await inspectContainer(seeded.containerName)).not.toBeNull();

    const second = await runEnvironmentLeaseCleanup({
      tenantId: TENANT_ID,
      leaseId: seeded.leaseId,
      backend: failOnceBackend,
      owner: "cleanup-worker:n07:replacement-process",
      now: new Date((pending?.nextCleanupAt?.getTime() ?? Date.now()) + 1),
    });
    expect(second.state).toBe("released");
    expect(releaseCalls).toBe(2);
    expect((await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId))?.leaseState).toBe("released");
    expect(await inspectContainer(seeded.containerName)).toBeNull();
  }, 60_000);

  it("N05-T1/N05-T2: 旧 create 错误不清继任者，当前准备者失败则持久重试到真实 released", async () => {
    const fixture = await makeFixture();
    const seeded = await fixture.seedManagedAuthority();
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
      })
      .where(eq(invocationAttemptTable.id, seeded.attemptId));
    const intentKey = `n05-create:${seeded.attemptId}`;
    const source = executionSourceForTest({
      tenantId: TENANT_ID,
      invocationId: seeded.invocationId,
      attemptId: seeded.attemptId,
      sourceOperationKey: intentKey,
    });
    const t0 = new Date();
    const first = await claimAttemptPreparation({
      source,
      claimId: "n05-worker-1",
      now: t0,
    });
    if (!first.claim) throw new Error("W1 未取得准备领取");
    const second = await claimAttemptPreparation({
      source,
      claimId: "n05-worker-2",
      now: new Date(t0.getTime() + ATTEMPT_PREPARATION_LEASE_MS + 1),
    });
    expect(second.disposition).toBe("claimed");

    const cleanup = await scheduleEnvironmentLeaseCleanupForPreparationClaim({
      claim: first.claim,
      leaseId: seeded.leaseId,
      errorCode: "OrdinaryCreateError",
    });
    expect(cleanup.outcome).toBe("not_claimed");
    expect((await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId))?.leaseState).toBe("active");

    let releaseCalls = 0;
    const countingBackend: EnvironmentInstanceBackend = {
      ...fixture.backend,
      async release(input) {
        releaseCalls += 1;
        return fixture.backend.release(input);
      },
    };
    const sweep = await runDueEnvironmentLeaseCleanups({
      backend: countingBackend,
      owner: "cleanup-worker:n05-stale",
    });
    expect(sweep.scanned).toBe(0);
    expect(releaseCalls).toBe(0);
    expect(await inspectContainer(seeded.containerName)).not.toBeNull();

    if (!second.claim) throw new Error("W2 未取得准备领取");
    const scheduled = await scheduleEnvironmentLeaseCleanupForPreparationClaim({
      claim: second.claim,
      leaseId: seeded.leaseId,
      errorCode: "CurrentCreateError",
    });
    expect(scheduled.outcome).toBe("scheduled");
    let failCurrentOnce = true;
    const failOnceBackend: EnvironmentInstanceBackend = {
      ...fixture.backend,
      async release(input) {
        releaseCalls += 1;
        if (failCurrentOnce) {
          failCurrentOnce = false;
          throw new Error("simulated current cleanup interruption");
        }
        return fixture.backend.release(input);
      },
    };
    const failed = await runEnvironmentLeaseCleanup({
      tenantId: TENANT_ID,
      leaseId: seeded.leaseId,
      backend: failOnceBackend,
      owner: "cleanup-worker:n05:first",
    });
    expect(failed.state).toBe("pending_retry");
    const pending = await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId);
    expect(pending?.leaseState).toBe("releasing");
    const retried = await runEnvironmentLeaseCleanup({
      tenantId: TENANT_ID,
      leaseId: seeded.leaseId,
      backend: failOnceBackend,
      owner: "cleanup-worker:n05:retry",
      now: new Date((pending?.nextCleanupAt?.getTime() ?? Date.now()) + 1),
    });
    expect(retried.state).toBe("released");
    expect((await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId))?.leaseState).toBe("released");
    expect(await inspectContainer(seeded.containerName)).toBeNull();
  }, 60_000);

  it("A08-02: Owner 失权接管出口登记旧 Lease 的清理，而不是写成 lost", async () => {
    const fixture = await makeFixture();
    const seeded = await fixture.seedManagedAuthority();

    // 旧代际过期 → 新 Attempt 正式接管（走真实 acquire 的 takeover 分支）。
    await expireOwnershipLease(seeded.ownershipId);
    const attempt2 = await createAttempt({
      tenantId: TENANT_ID,
      invocationId: seeded.invocationId,
    });
    const evidence = {
      kind: "a08-takeover",
      invocationId: seeded.invocationId,
      attemptId: attempt2.id,
    };
    await db.transaction((tx) =>
      markAttemptPreparedForTestInTransaction(tx, {
        attemptId: attempt2.id,
        evidence,
        digest: protocolDigest(evidence),
      }),
    );
    const takeover = await acquireExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: seeded.invocationId,
      attemptId: attempt2.id,
      runtimeRevisionId: seeded.authority.runtimeRevisionId,
      acquiredByType: "service",
      acquiredById: "a08-takeover",
    });
    expect(takeover.takeover).toBe(true);

    const afterTakeover = await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId);
    expect(afterTakeover?.leaseState).toBe("releasing");
    expect(afterTakeover?.releasedAt).toBeNull();
    expect(await inspectContainer(seeded.containerName)).not.toBeNull();

    const sweep = await runDueEnvironmentLeaseCleanups({
      backend: fixture.backend,
      owner: "cleanup-worker:2",
    });
    expect(sweep.released).toBe(1);
    expect((await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId))?.leaseState).toBe("released");
    expect(await inspectContainer(seeded.containerName)).toBeNull();
  }, 60_000);

  it("A08-03: Owner 失联收口（markInvocationLost）登记该 Attempt 的真实清理", async () => {
    const fixture = await makeFixture();
    const seeded = await fixture.seedManagedAuthority();

    await expireOwnershipLease(seeded.ownershipId);
    const observed = await readObservedOwner({
      tenantId: TENANT_ID,
      invocationId: seeded.invocationId,
    });
    expect(observed?.ownershipId).toBe(seeded.ownershipId);

    const outcome = await markInvocationLost({
      tenantId: TENANT_ID,
      invocationId: seeded.invocationId,
      reasonCode: "heartbeat_stale",
      observedOwner: observed,
    });
    expect(outcome.outcome).toBe("lost");

    const afterLost = await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId);
    expect(afterLost?.leaseState).toBe("releasing");
    expect(afterLost?.releasedAt).toBeNull();
    expect(await inspectContainer(seeded.containerName)).not.toBeNull();

    const sweep = await runDueEnvironmentLeaseCleanups({
      backend: fixture.backend,
      owner: "cleanup-worker:3",
    });
    expect(sweep.released).toBe(1);
    expect((await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId))?.leaseState).toBe("released");
    expect(await inspectContainer(seeded.containerName)).toBeNull();
  }, 60_000);

  it("A08-04: 两个清理进程并发领取同一 Lease，只有一个真的执行释放", async () => {
    const fixture = await makeFixture();
    const seeded = await fixture.seedManagedAuthority();
    await scheduleEnvironmentLeaseCleanup({
      tenantId: TENANT_ID,
      leaseId: seeded.leaseId,
      errorCode: "A08ConcurrentClaim",
      immediate: true,
    });

    let releaseCalls = 0;
    const counting: EnvironmentInstanceBackend = {
      kind: fixture.backend.kind,
      create: (input) => fixture.backend.create(input),
      inspect: (input) => fixture.backend.inspect(input),
      queryOperation: (operationId) => fixture.backend.queryOperation(operationId),
      async release(input) {
        releaseCalls += 1;
        return fixture.backend.release(input);
      },
    };

    const WORKERS = 6;
    // 预热连接池：6 条并发 `SELECT SLEEP` 各自占住一条连接，保证随后的 6 个清理进程
    // 真的在不同连接上**同时**发起领取。否则连接池懒建会让请求在时间上错开，
    // 竞争窗口被自然串行化，用例就退化成"看起来本来就只有一个执行者"。
    await Promise.all(Array.from({ length: WORKERS }, () => db.execute(sql`SELECT SLEEP(0.05)`)));

    const outcomes = await Promise.all(
      Array.from({ length: WORKERS }, (_, index) =>
        runEnvironmentLeaseCleanup({
          tenantId: TENANT_ID,
          leaseId: seeded.leaseId,
          backend: counting,
          owner: `cleanup-worker:${index}`,
        }),
      ),
    );

    // 关键不变量：真实释放**只发生一次**。
    // 修复前（读用 `db`、写用另一条 `db.update`，两步不共享事务、写回不复核 due/state）
    // 同一时刻真的发生 6 次物理释放（实测 `releaseCalls === 6`）：6 个 Worker 都读到
    // "可领取"，并且都按 id 无条件写回了自己的领取结论。
    expect(releaseCalls).toBe(1);
    const finalState = await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId);
    expect(finalState?.leaseState).toBe("released");
    // 只有一次真实释放被记账：多次执行过的话 cleanupCount 会大于 1。
    expect(finalState?.cleanupCount).toBe(1);
    // 落败者要么当场判定"轮不到我"（`not_due`），要么在赢家写完之后才读回（看到
    // `released`）—— 两种都不允许上报自己完成过物理释放，更不允许记成失败重试。
    expect(outcomes.filter((outcome) => outcome.state === "pending_retry")).toHaveLength(0);
    expect(await inspectContainer(seeded.containerName)).toBeNull();
  }, 60_000);

  it("A08-05: 旧领取者的迟到完成/失败不得覆盖新领取者的结论", async () => {
    const fixture = await makeFixture();
    const seeded = await fixture.seedManagedAuthority();
    await scheduleEnvironmentLeaseCleanup({
      tenantId: TENANT_ID,
      leaseId: seeded.leaseId,
      errorCode: "A08LateClaim",
      immediate: true,
    });

    const t0 = new Date();
    const first = await claimEnvironmentLeaseCleanup({
      tenantId: TENANT_ID,
      leaseId: seeded.leaseId,
      owner: "cleanup-worker:A",
      now: t0,
    });
    if (!first) throw new Error("第一轮领取失败");

    // A 的领取过期后 B 接管（时间由参数推进，不依赖 sleep）。
    const afterExpiry = new Date(first.claim.leaseExpiresAt.getTime() + 1);
    const second = await claimEnvironmentLeaseCleanup({
      tenantId: TENANT_ID,
      leaseId: seeded.leaseId,
      owner: "cleanup-worker:B",
      now: afterExpiry,
    });
    if (!second) throw new Error("第二轮领取失败");
    expect(second.claim.owner).toBe("cleanup-worker:B");

    // A 迟到"完成"：令牌已不属于它 → 不得把 Lease 写成 released。
    const lateComplete = await completeEnvironmentLeaseCleanup({
      claim: first.claim,
      releasedAt: afterExpiry,
    });
    expect(lateComplete.outcome).toBe("not_claimed");
    const afterLateComplete = await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId);
    expect(afterLateComplete?.leaseState).toBe("releasing");
    expect(afterLateComplete?.cleanupLeaseOwner).toBe("cleanup-worker:B");

    // A 迟到"失败"：同样不得抹掉 B 的领取与重试时机。
    const lateFailure = await recordEnvironmentLeaseCleanupFailure({
      claim: first.claim,
      errorCode: "A08LateFailure",
      now: afterExpiry,
    });
    expect(lateFailure.outcome).toBe("not_claimed");
    const afterLateFailure = await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId);
    expect(afterLateFailure?.cleanupLeaseOwner).toBe("cleanup-worker:B");
    expect(afterLateFailure?.lastErrorCode).not.toBe("A08LateFailure");
    expect(afterLateFailure?.versionNo).toBe(afterLateComplete?.versionNo);

    // B 的结论照常成立。
    const completed = await completeEnvironmentLeaseCleanup({
      claim: second.claim,
      releasedAt: afterExpiry,
    });
    expect(completed.outcome).toBe("released");
    expect((await getEnvironmentLeaseById(TENANT_ID, seeded.leaseId))?.leaseState).toBe("released");

    // 本用例没有走真实 Backend.release，残留容器由这里显式收掉。
    await removeContainer(seeded.containerName);
  }, 60_000);
});
