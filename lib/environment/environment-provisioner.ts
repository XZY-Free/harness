/**
 * R07：EnvironmentProvisioner——Revision → 实际实例 → 符合性证据 → Lease → 清理。
 *
 * 修复要点（repairs/06-environment.md）：
 * - §1 执行与 Provision **仅**从 Binding 指定的 EnvironmentDefinitionRevision 读取。
 *   本模块入参带 `revisionId`，与传入 revision 的 id 逐字比对；Definition 的
 *   current/default 不进入本模块（不读取、不 fallback）。
 * - §1 同一 Attempt Transport Retry 查找并复用既有 EnvironmentLease（同 tenant /
 *   Invocation / Attempt / Revision / 稳定 resource identity）；
 *   只有真正更换基础设施尝试（新 Attempt / Redispatch）才新建 Lease。
 * - §2 实例化调用真实 Backend（container/host_agent），产出可核验实例事实；
 *   `EnvironmentComplianceFailed` 时在执行前 fail closed。
 * - §3 生产写入不允许 `evidence ?? {verified:true}` 默认成功。
 * - §5 失败清理登记稳定 operation/manifest 归属 + 持久重试；控制面 `released`
 *   只在真实释放回执之后写。
 */
import {
  EnvironmentComplianceError,
  EnvironmentInstanceOperationError,
} from "@/lib/environment/environment-errors";
import {
  type EnvironmentInstanceBackend,
  type EnvironmentInstanceFacts,
  type EnvironmentInstanceRequest,
  createDefaultEnvironmentInstanceBackend,
  managedContainerName,
} from "@/lib/environment/environment-instance-backend";
import {
  type EnvironmentInstanceSpec,
  normalizeEnvironmentInstanceSpec,
} from "@/lib/environment/environment-instance-spec";
import {
  claimEnvironmentLeaseCleanup,
  completeEnvironmentLeaseCleanup,
  createEnvironmentLease,
  findReusableEnvironmentLease,
  getEnvironmentLeaseById,
  listEnvironmentLeasesDueForCleanup,
  prepareEnvironmentLease,
  recordEnvironmentLeaseCleanupFailure,
  scheduleEnvironmentLeaseCleanup,
} from "@/lib/environment/environment-lease-store";
import {
  ENVIRONMENT_PREPARED_TTL_MS,
  buildEnvironmentPreparedEvidence,
  environmentPreparedEvidenceDigest,
} from "@/lib/environment/environment-prepared-evidence";
import type { EnvironmentLease } from "@/lib/persistence/schema/environment";
import type { EnvironmentDefinitionRevision } from "@/lib/persistence/schema/environment-definition-revision";

export interface EnvironmentProvisionInput {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  /** Binding 冻结的 Revision id（权威来源）。 */
  revisionId: string;
  revision: EnvironmentDefinitionRevision;
  workspaceBindingId: string;
  /** 受管写根（来自 WorkspaceBinding，不来自 Revision）。 */
  workspaceRoot?: string | null;
  /** 恢复水位（Prepared 证据 Anchor）。 */
  recoveryAnchorDigest?: string | null;
  now?: Date;
}

export interface EnvironmentRevalidateInput {
  tenantId: string;
  lease: EnvironmentLease;
  revisionId: string;
  revision: EnvironmentDefinitionRevision;
  workspaceBindingId: string;
  workspaceRoot?: string | null;
  recoveryAnchorDigest?: string | null;
  now?: Date;
}

export interface EnvironmentProvisioner {
  /** 真实实例化并核验；失败时登记持久清理工作后 fail closed。 */
  provision(input: EnvironmentProvisionInput): Promise<EnvironmentLease>;
  /** 复验既有实例（Resume / takeover 前）。 */
  revalidate(input: EnvironmentRevalidateInput): Promise<EnvironmentLease>;
  /** 真实释放该 Lease 的资源；失败保持 `releasing` 等待 Worker 重试。 */
  cleanup(input: {
    tenantId: string;
    leaseId: string;
    reasonCode: string;
    now?: Date;
  }): Promise<{ state: "released" | "pending_retry"; cleanupCount: number }>;
}

/** 资源 Manifest 里放稳定 operation 与候选归属（Crash 后按 operation 回读）。 */
export function environmentOperationId(input: {
  environmentDefinitionRevisionId: string;
  attemptId: string;
}): string {
  return `env-instance:${input.attemptId}:${input.environmentDefinitionRevisionId}`;
}

function workspaceBindingIdOf(lease: EnvironmentLease): string | null {
  const manifest = (lease.resourceManifest ?? {}) as Record<string, unknown>;
  return typeof manifest.workspaceBindingId === "string" ? manifest.workspaceBindingId : null;
}

function resourceManifestPatchOf(lease: EnvironmentLease) {
  const manifest = (lease.resourceManifest ?? {}) as Record<string, unknown>;
  return {
    operationId: typeof manifest.operationId === "string" ? manifest.operationId : null,
    resources: Array.isArray(manifest.resources) ? manifest.resources : undefined,
  };
}

/**
 * 真实执行一次清理：认领 → Backend 真实释放 → 写终态或记录失败。
 *
 * 幂等：Lease 已终态 / 已被他人认领 / 未到重试时间 → 直接返回当前状态。
 */
export async function runEnvironmentLeaseCleanup(input: {
  tenantId: string;
  leaseId: string;
  backend: EnvironmentInstanceBackend;
  owner: string;
  now?: Date;
}): Promise<{ state: "released" | "pending_retry" | "not_due"; cleanupCount: number }> {
  const now = input.now ?? new Date();
  const claimed = await claimEnvironmentLeaseCleanup({
    tenantId: input.tenantId,
    leaseId: input.leaseId,
    owner: input.owner,
    now,
  });
  if (!claimed) {
    const current = await getEnvironmentLeaseById(input.tenantId, input.leaseId);
    if (!current) return { state: "not_due", cleanupCount: 0 };
    if (current.leaseState === "released") {
      return { state: "released", cleanupCount: current.cleanupCount };
    }
    return { state: "not_due", cleanupCount: current.cleanupCount };
  }
  const manifest = (claimed.resourceManifest ?? {}) as Record<string, unknown>;
  const operationId =
    typeof manifest.operationId === "string"
      ? manifest.operationId
      : environmentOperationId({
          environmentDefinitionRevisionId: claimed.environmentDefinitionRevisionId,
          attemptId: claimed.attemptId,
        });
  const resources = Array.isArray(manifest.resources)
    ? (manifest.resources as Array<{ kind: string; ref: string; identity: string }>)
    : undefined;
  try {
    const receipt = await input.backend.release({
      tenantId: input.tenantId,
      leaseId: claimed.id,
      operationId,
      ...(resources ? { resources } : {}),
    });
    if (!receipt.released) {
      throw new EnvironmentInstanceOperationError(
        `Backend 释放未成功：${receipt.detail}`,
        "release",
      );
    }
    const released = await completeEnvironmentLeaseCleanup({
      tenantId: input.tenantId,
      leaseId: claimed.id,
      releasedAt: new Date(),
    });
    return { state: "released", cleanupCount: released?.cleanupCount ?? claimed.cleanupCount + 1 };
  } catch (error) {
    const failed = await recordEnvironmentLeaseCleanupFailure({
      tenantId: input.tenantId,
      leaseId: claimed.id,
      errorCode: error instanceof Error ? error.name : "EnvironmentCleanupFailed",
      now: new Date(),
    });
    return {
      state: "pending_retry",
      cleanupCount: failed?.cleanupCount ?? claimed.cleanupCount + 1,
    };
  }
}

/**
 * 清理 Worker 入口：扫描到期的 `releasing` Lease 并真实释放（跨 Attempt/Owner 丢失/
 * Invocation terminal 的持久清理工作都在这里兑现）。
 */
export async function runDueEnvironmentLeaseCleanups(input: {
  backend: EnvironmentInstanceBackend;
  owner: string;
  limit?: number;
  now?: Date;
}): Promise<{ scanned: number; released: number; pendingRetry: number }> {
  const now = input.now ?? new Date();
  const due = await listEnvironmentLeasesDueForCleanup({ now, limit: input.limit });
  let released = 0;
  let pendingRetry = 0;
  for (const lease of due) {
    const outcome = await runEnvironmentLeaseCleanup({
      tenantId: lease.tenantId,
      leaseId: lease.id,
      backend: input.backend,
      owner: input.owner,
      now,
    });
    if (outcome.state === "released") released += 1;
    else if (outcome.state === "pending_retry") pendingRetry += 1;
  }
  return { scanned: due.length, released, pendingRetry };
}

function assertRevisionFrozen(input: {
  revisionId: string;
  revision: EnvironmentDefinitionRevision;
}): void {
  if (input.revision.id !== input.revisionId) {
    throw new EnvironmentComplianceError(
      "Provision 只接受 Binding 冻结的 Revision（传入 revisionId 与 revision.id 不一致）",
    );
  }
}

async function provisionWithBackend(input: {
  backend: EnvironmentInstanceBackend;
  tenantId: string;
  invocationId: string;
  attemptId: string;
  spec: EnvironmentInstanceSpec;
  workspaceBindingId: string;
  workspaceRoot: string | null;
  recoveryAnchorDigest: string | null;
  now: Date;
}): Promise<EnvironmentLease> {
  // §1：同 Attempt 复用既有 Lease（不重复创建真实资源）。
  const existing = await findReusableEnvironmentLease(
    input.tenantId,
    input.invocationId,
    input.attemptId,
  );
  if (existing && existing.environmentDefinitionRevisionId !== input.spec.revisionId) {
    throw new EnvironmentComplianceError("既有 EnvironmentLease 引用了其他 Revision");
  }
  const operationId =
    resourceManifestPatchOf(existing ?? ({} as EnvironmentLease)).operationId ??
    environmentOperationId({
      environmentDefinitionRevisionId: input.spec.revisionId,
      attemptId: input.attemptId,
    });
  const lease =
    existing ??
    (await createEnvironmentLease({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      attemptId: input.attemptId,
      environmentDefinitionRevisionId: input.spec.revisionId,
      resourceManifest: {
        operationId,
        workspaceBindingId: input.workspaceBindingId,
        workspaceRoot: input.workspaceRoot,
        revisionId: input.spec.revisionId,
        revisionSemanticDigest: input.spec.semanticDigest,
        recoveryAnchorDigest: input.recoveryAnchorDigest,
        backendKind: input.backend.kind,
        resources: [],
      },
    }));
  if (existing && existing.readinessState === "prepared") {
    // 已 prepared：Transport Retry 只需确认实例仍在（真实回读），不重复建资源。
    const facts = await input.backend.inspect(requestFor(input, lease, operationId, input.spec));
    assertPreparedInstanceMatches(lease, facts);
    return (await getEnvironmentLeaseById(input.tenantId, lease.id)) ?? lease;
  }
  const request = requestFor(input, lease, operationId, input.spec);
  let facts: EnvironmentInstanceFacts;
  try {
    facts = await input.backend.create(request);
  } catch (error) {
    // 真实资源可能已创建一部分：登记持久清理工作（归属 + 重试），不吞掉错误。
    await scheduleEnvironmentLeaseCleanup({
      tenantId: input.tenantId,
      leaseId: lease.id,
      errorCode:
        error instanceof EnvironmentComplianceError
          ? "EnvironmentComplianceFailed"
          : error instanceof Error
            ? error.name
            : "EnvironmentInstanceFailed",
      now: input.now,
      immediate: true,
      resourceManifestPatch: {
        operationId,
        workspaceBindingId: input.workspaceBindingId,
        resources: [
          {
            kind: input.backend.kind === "container" ? "container" : "host_agent_artifact",
            // 真实容器名由稳定 operationId 派生：创建可能失败在容器已存在之后。
            ref:
              input.backend.kind === "container" ? managedContainerName(operationId) : operationId,
            identity: "unverified",
          },
        ],
      },
    });
    await runEnvironmentLeaseCleanup({
      tenantId: input.tenantId,
      leaseId: lease.id,
      backend: input.backend,
      owner: `provision:${input.attemptId}`,
      now: input.now,
    }).catch(() => undefined);
    throw error instanceof EnvironmentComplianceError
      ? error
      : new EnvironmentComplianceError(
          error instanceof Error ? error.message : "Environment 实例化失败",
        );
  }
  const expiresAt = new Date(input.now.getTime() + ENVIRONMENT_PREPARED_TTL_MS);
  try {
    const evidence = buildEnvironmentPreparedEvidence({
      revisionId: input.spec.revisionId,
      semanticDigest: input.spec.semanticDigest,
      actualTargetDigest: facts.actualTargetDigest,
      verifier: facts.verifier,
      policyChecks: facts.policyChecks,
      instance: facts.identity,
      candidate: {
        attemptId: input.attemptId,
        workspaceBindingId: input.workspaceBindingId,
        recoveryAnchorDigest: input.recoveryAnchorDigest,
      },
      resourceManifest: {
        operationId,
        resources: facts.resources,
        backendKind: input.backend.kind,
        targetDigest: facts.actualTargetDigest,
      },
      verifiedAt: input.now,
      expiresAt,
    });
    return await prepareEnvironmentLease({
      tenantId: input.tenantId,
      leaseId: lease.id,
      capabilitiesJson: facts.capabilities,
      evidence,
      now: input.now,
    });
  } catch (error) {
    // 真实资源已经建立，但控制面拒绝承认（能力不满足 / 证据自洽失败 / Lease 状态非法）：
    // 必须登记归属并尝试真实释放，不能留下无主容器。
    await scheduleEnvironmentLeaseCleanup({
      tenantId: input.tenantId,
      leaseId: lease.id,
      errorCode:
        error instanceof EnvironmentComplianceError
          ? "EnvironmentComplianceFailed"
          : error instanceof Error
            ? error.name
            : "EnvironmentPrepareFailed",
      now: input.now,
      immediate: true,
      resourceManifestPatch: {
        operationId,
        workspaceBindingId: input.workspaceBindingId,
        resources: facts.resources,
      },
    });
    await runEnvironmentLeaseCleanup({
      tenantId: input.tenantId,
      leaseId: lease.id,
      backend: input.backend,
      owner: `provision:${input.attemptId}`,
      now: input.now,
    }).catch(() => undefined);
    throw error instanceof EnvironmentComplianceError
      ? error
      : new EnvironmentComplianceError(
          error instanceof Error ? error.message : "Environment 实例未被控制面承认",
        );
  }
}

function requestFor(
  input: {
    tenantId: string;
    invocationId: string;
    attemptId: string;
    workspaceRoot: string | null;
    recoveryAnchorDigest: string | null;
    workspaceBindingId: string;
  },
  lease: EnvironmentLease,
  operationId: string,
  spec: EnvironmentInstanceSpec,
): EnvironmentInstanceRequest {
  return {
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    leaseId: lease.id,
    operationId,
    spec,
    workspaceRoot: input.workspaceRoot,
    recoveryAnchorDigest: input.recoveryAnchorDigest,
    workspaceBindingId: input.workspaceBindingId,
  };
}

function assertPreparedInstanceMatches(
  lease: EnvironmentLease,
  facts: EnvironmentInstanceFacts,
): void {
  const prepared = lease.preparedEvidence as { actualTargetDigest?: string } | null;
  if (!prepared?.actualTargetDigest) {
    throw new EnvironmentComplianceError("Lease 缺少已核验的实际目标摘要");
  }
  if (prepared.actualTargetDigest !== facts.actualTargetDigest) {
    throw new EnvironmentComplianceError("既有实例的实际配置已变化（targetDigest 不一致）");
  }
  const failed = facts.policyChecks.filter((check) => !check.satisfied);
  if (failed.length > 0) {
    throw new EnvironmentComplianceError(
      `既有实例不再满足策略：${failed.map((check) => check.policy).join(", ")}`,
    );
  }
}

export function createEnvironmentProvisioner(dependencies: {
  backend: EnvironmentInstanceBackend;
}): EnvironmentProvisioner {
  const backend = dependencies.backend;
  return {
    async provision(input) {
      assertRevisionFrozen(input);
      const now = input.now ?? new Date();
      const spec = normalizeEnvironmentInstanceSpec(input.revision);
      if (spec.backendKind !== backend.kind) {
        throw new EnvironmentComplianceError(
          `Revision 声明的 backendKind=${spec.backendKind} 与受管 Backend=${backend.kind} 不匹配`,
        );
      }
      return provisionWithBackend({
        backend,
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        attemptId: input.attemptId,
        spec,
        workspaceBindingId: input.workspaceBindingId,
        workspaceRoot: input.workspaceRoot ?? null,
        recoveryAnchorDigest: input.recoveryAnchorDigest ?? null,
        now,
      });
    },

    async revalidate(input) {
      assertRevisionFrozen(input);
      const now = input.now ?? new Date();
      if (input.lease.tenantId !== input.tenantId) {
        throw new EnvironmentComplianceError("EnvironmentLease 不属于当前租户");
      }
      if (input.lease.environmentDefinitionRevisionId !== input.revision.id) {
        throw new EnvironmentComplianceError("EnvironmentLease 与冻结 Revision 不匹配");
      }
      if (!["prepared", "ready"].includes(input.lease.readinessState)) {
        throw new EnvironmentComplianceError("EnvironmentLease 不是可恢复的受管实例");
      }
      if (!["allocated", "active"].includes(input.lease.leaseState)) {
        throw new EnvironmentComplianceError("EnvironmentLease 已非活跃");
      }
      const boundWorkspace = workspaceBindingIdOf(input.lease);
      if (boundWorkspace && boundWorkspace !== input.workspaceBindingId) {
        throw new EnvironmentComplianceError("EnvironmentLease 属于其他 WorkspaceBinding");
      }
      const spec = normalizeEnvironmentInstanceSpec(input.revision);
      const manifest = (input.lease.resourceManifest ?? {}) as Record<string, unknown>;
      const operationId =
        typeof manifest.operationId === "string"
          ? manifest.operationId
          : environmentOperationId({
              environmentDefinitionRevisionId: input.revision.id,
              attemptId: input.lease.attemptId,
            });
      const facts = await backend.inspect(
        requestFor(
          {
            tenantId: input.tenantId,
            invocationId: input.lease.invocationId,
            attemptId: input.lease.attemptId,
            workspaceRoot: input.workspaceRoot ?? null,
            recoveryAnchorDigest: input.recoveryAnchorDigest ?? null,
            workspaceBindingId: input.workspaceBindingId,
          },
          input.lease,
          operationId,
          spec,
        ),
      );
      assertPreparedInstanceMatches(input.lease, facts);
      return (await getEnvironmentLeaseById(input.tenantId, input.lease.id)) ?? input.lease;
    },

    async cleanup(input) {
      const now = input.now ?? new Date();
      const lease = await getEnvironmentLeaseById(input.tenantId, input.leaseId);
      if (!lease) return { state: "released", cleanupCount: 0 };
      if (lease.leaseState === "released") {
        return { state: "released", cleanupCount: lease.cleanupCount };
      }
      await scheduleEnvironmentLeaseCleanup({
        tenantId: input.tenantId,
        leaseId: input.leaseId,
        errorCode: input.reasonCode,
        now,
        immediate: true,
      });
      const outcome = await runEnvironmentLeaseCleanup({
        tenantId: input.tenantId,
        leaseId: input.leaseId,
        backend,
        owner: `cleanup:${input.reasonCode}`,
        now,
      });
      return {
        state: outcome.state === "released" ? "released" : "pending_retry",
        cleanupCount: outcome.cleanupCount,
      };
    },
  };
}

/** 供诊断/测试读取：Prepared 证据摘要函数。 */
export { environmentPreparedEvidenceDigest };

/**
 * 生产默认组装：按平台 runtimeType 选择真实 Backend。
 *
 * 修复"默认组装没有真实 Provider"（R07 §2）：默认路径现在能真正实例化并核验；
 * 无法落实 Revision 声明策略时仍在执行前 fail closed。
 */
export function createDefaultEnvironmentProvisioner(input?: {
  runtimeType?: "host" | "container";
  controlRoot?: string;
}): EnvironmentProvisioner {
  return createEnvironmentProvisioner({
    backend: createDefaultEnvironmentInstanceBackend({
      runtimeType: input?.runtimeType ?? "container",
      ...(input?.controlRoot ? { controlRoot: input.controlRoot } : {}),
    }),
  });
}
