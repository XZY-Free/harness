/**
 * ⚠️ 仅 test-support：构造"已核验"的 Environment PreparedEvidence。
 *
 * 用途边界（repairs/06-environment.md §3）：
 * - 只供**不验证实例化**的测试（Workspace/Checkpoint/DB 语义）建立前置事实。
 * - 生产写入路径**禁止**使用本模块——生产必须经 `createEnvironmentProvisioner` 的
 *   真实 Backend 回读产生证据（不允许 `evidence ?? {verified:true}` 默认成功）。
 * - 本模块仍要求调用方显式提供全部关键事实（revision、digest、attempt、binding），
 *   只是把"实际策略核验结果"按 Revision 声明为满足——这只在测试语境下成立。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  createEnvironmentLease,
  prepareEnvironmentLease,
} from "@/lib/environment/environment-lease-store";
import {
  ENVIRONMENT_PREPARED_TTL_MS,
  buildEnvironmentPreparedEvidence,
} from "@/lib/environment/environment-prepared-evidence";
import type { EnvironmentLease } from "@/lib/persistence/schema/environment";
import type { EnvironmentDefinitionRevision } from "@/lib/persistence/schema/environment-definition-revision";

function digestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export async function seedPreparedEnvironmentLease(input: {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  revision: EnvironmentDefinitionRevision;
  workspaceBindingId: string;
  /** 复用已存在的 Lease（如"准备失败后 Lease 状态"断言场景）。 */
  lease?: EnvironmentLease;
  recoveryAnchorDigest?: string | null;
  capabilitiesJson?: unknown;
  workerRef?: string;
  hostIdentity?: string;
  storageIdentity?: string;
  /**
   * A05：本次完成所依据的准备 claim。用于验证"迟到的旧完成不得提交证据"：
   * 提供时 `prepareEnvironmentLease` 会在事务内复核准备槽归属。
   */
  preparationClaim?: { attemptId: string; preparationClaimId: string };
  now?: Date;
}): Promise<EnvironmentLease> {
  const now = input.now ?? new Date();
  const operationId = `test-env-instance:${input.attemptId}:${input.revision.id}`;
  const workerRef = input.workerRef ?? `test-worker:${randomUUID()}`;
  const hostIdentity = input.hostIdentity ?? `test-host:${randomUUID()}`;
  const storageIdentity = input.storageIdentity ?? `test-storage:${randomUUID()}`;
  const lease =
    input.lease ??
    (await createEnvironmentLease({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      attemptId: input.attemptId,
      environmentDefinitionRevisionId: input.revision.id,
      resourceManifest: {
        operationId,
        workspaceBindingId: input.workspaceBindingId,
        revisionId: input.revision.id,
        revisionSemanticDigest: input.revision.semanticDigest,
        recoveryAnchorDigest: input.recoveryAnchorDigest ?? null,
        backendKind: "container",
        resources: [{ kind: "container", ref: workerRef, identity: digestOf(workerRef) }],
      },
    }));
  const evidence = buildEnvironmentPreparedEvidence({
    revisionId: input.revision.id,
    semanticDigest: input.revision.semanticDigest,
    actualTargetDigest: digestOf({
      kind: "test-support-instance",
      revisionId: input.revision.id,
      operationId,
    }),
    verifier: { kind: "test_support", ref: operationId, digest: digestOf({ operationId }) },
    policyChecks: (
      ["executionTarget", "filesystemPolicy", "networkPolicy", "resourceLimits"] as const
    ).map((policy) => ({
      policy,
      required: { fixture: policy },
      actual: { fixture: policy, satisfied: true },
      satisfied: true,
      check: {
        kind: "test_support",
        ref: `${operationId}:${policy}`,
        digest: digestOf({ operationId, policy }),
      },
    })),
    instance: {
      workerRef,
      deviceId: null,
      hostIdentity,
      storageIdentity,
      backendKind: "container",
    },
    candidate: {
      attemptId: input.attemptId,
      workspaceBindingId: input.workspaceBindingId,
      recoveryAnchorDigest: input.recoveryAnchorDigest ?? null,
    },
    resourceManifest: {
      operationId,
      resources: [{ kind: "container", ref: workerRef, identity: digestOf(workerRef) }],
      backendKind: "container",
    },
    verifiedAt: now,
    expiresAt: new Date(now.getTime() + ENVIRONMENT_PREPARED_TTL_MS),
  });
  return prepareEnvironmentLease({
    tenantId: input.tenantId,
    leaseId: lease.id,
    capabilitiesJson: input.capabilitiesJson ?? input.revision.requiredCapabilities,
    evidence,
    preparationClaim: input.preparationClaim,
    now,
  });
}

/** 测试用：激活既有已 Prepared 的 Lease（补齐 Current Ownership 复核上下文）。 */
export async function activateSeededEnvironmentLease(input: {
  tenantId: string;
  lease: EnvironmentLease;
  ownershipId: string;
  recoveryAnchorDigest?: string | null;
  now?: Date;
}): Promise<EnvironmentLease> {
  const { activateEnvironmentLease } = await import("@/lib/environment/environment-lease-store");
  return activateEnvironmentLease({
    tenantId: input.tenantId,
    leaseId: input.lease.id,
    ownershipId: input.ownershipId,
    attemptId: input.lease.attemptId,
    invocationId: input.lease.invocationId,
    environmentDefinitionRevisionId: input.lease.environmentDefinitionRevisionId,
    recoveryAnchorDigest: input.recoveryAnchorDigest ?? null,
    now: input.now,
  });
}
