/**
 * R07：Environment PreparedEvidence 契约。
 *
 * 恢复工程包被省略的验证形状（repairs/06-environment.md §3）：
 * - Revision ID 与 semanticDigest；
 * - 实际运行 targetDigest（由真实实例配置派生，不是 Revision 声明值）；
 * - 受管 Verifier 身份及可回读检查凭据；
 * - 每项执行策略的实际验证结果；
 * - 当前 Candidate Attempt、WorkspaceBinding、恢复 Anchor；
 * - verifiedAt / expiresAt（Prepared 最长 60 秒）；
 * - 资源 Manifest 与确切 Lease 关联。
 *
 * 硬约束：生产写入不允许 `evidence ?? {verified:true}` 默认成功。
 * 本模块的 `build` 要求所有字段显式提供（缺一即抛），`assert` 拒绝任何不满足项。
 */
import { createHash } from "node:crypto";
import { EnvironmentComplianceError } from "@/lib/environment/environment-errors";

/** Prepared 证据最长有效 60 秒（repairs/06-environment.md §3）。 */
export const ENVIRONMENT_PREPARED_TTL_MS = 60_000 as const;

export const ENVIRONMENT_POLICY_NAMES = [
  "executionTarget",
  "filesystemPolicy",
  "networkPolicy",
  "resourceLimits",
  "secretPolicy",
  "processIsolation",
] as const;
export type EnvironmentPolicyName = (typeof ENVIRONMENT_POLICY_NAMES)[number];

export interface EnvironmentPolicyCheck {
  policy: EnvironmentPolicyName;
  /** Revision 声明的策略（期望值）。 */
  required: unknown;
  /** 真实回读到的实际值。 */
  actual: unknown;
  satisfied: boolean;
  /** 可回读检查凭据：具体 inspect 字段引用 + 摘要。 */
  check: { kind: string; ref: string; digest: string };
}

export interface EnvironmentInstanceIdentity {
  workerRef: string;
  deviceId: string | null;
  hostIdentity: string;
  storageIdentity: string;
  backendKind: "container" | "host_agent";
}

export interface EnvironmentResourceManifestEntry {
  kind: string;
  ref: string;
  identity: string;
}

export interface EnvironmentPreparedEvidence {
  schemaVersion: 1;
  revisionId: string;
  semanticDigest: string;
  /** 实际运行目标 digest。 */
  actualTargetDigest: string;
  verifier: { kind: string; ref: string; digest: string };
  policyChecks: EnvironmentPolicyCheck[];
  instance: EnvironmentInstanceIdentity;
  candidate: {
    attemptId: string;
    workspaceBindingId: string;
    recoveryAnchorDigest: string | null;
  };
  resourceManifest: {
    operationId: string;
    resources: EnvironmentResourceManifestEntry[];
    [key: string]: unknown;
  };
  verifiedAt: string;
  expiresAt: string;
}

export interface BuildEnvironmentPreparedEvidenceInput {
  revisionId: string;
  semanticDigest: string;
  actualTargetDigest: string;
  verifier: { kind: string; ref: string; digest: string };
  policyChecks: EnvironmentPolicyCheck[];
  instance: EnvironmentInstanceIdentity;
  candidate: {
    attemptId: string;
    workspaceBindingId: string;
    recoveryAnchorDigest: string | null;
  };
  resourceManifest: EnvironmentPreparedEvidence["resourceManifest"];
  verifiedAt: Date;
  expiresAt: Date;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EnvironmentComplianceError(`PreparedEvidence.${label} 必填`);
  }
  return value.trim();
}

function requireDigest(value: unknown, label: string): string {
  const text = requireNonEmpty(value, label);
  if (!DIGEST_PATTERN.test(text)) {
    throw new EnvironmentComplianceError(`PreparedEvidence.${label} 必须是 sha256:<64hex>`);
  }
  return text;
}

/**
 * 构造 Prepared 证据。**所有字段必须显式提供**——没有默认值、没有 `verified:true` 兜底。
 */
export function buildEnvironmentPreparedEvidence(
  input: BuildEnvironmentPreparedEvidenceInput,
): EnvironmentPreparedEvidence {
  const revisionId = requireNonEmpty(input.revisionId, "revisionId");
  const semanticDigest = requireDigest(input.semanticDigest, "semanticDigest");
  const actualTargetDigest = requireDigest(input.actualTargetDigest, "actualTargetDigest");
  const verifier = {
    kind: requireNonEmpty(input.verifier?.kind, "verifier.kind"),
    ref: requireNonEmpty(input.verifier?.ref, "verifier.ref"),
    digest: requireDigest(input.verifier?.digest, "verifier.digest"),
  };
  if (!Array.isArray(input.policyChecks) || input.policyChecks.length === 0) {
    throw new EnvironmentComplianceError("PreparedEvidence.policyChecks 不能为空");
  }
  const policyChecks: EnvironmentPolicyCheck[] = input.policyChecks.map((check) => {
    if (!ENVIRONMENT_POLICY_NAMES.includes(check.policy)) {
      throw new EnvironmentComplianceError(`未知策略名：${String(check.policy)}`);
    }
    if (check.actual === undefined) {
      throw new EnvironmentComplianceError(
        `策略 ${check.policy} 缺少实际回读值（不允许多态 undefined 的自报通过）`,
      );
    }
    return {
      policy: check.policy,
      required: check.required,
      actual: check.actual,
      satisfied: check.satisfied,
      check: {
        kind: requireNonEmpty(check.check?.kind, `policyChecks.${check.policy}.check.kind`),
        ref: requireNonEmpty(check.check?.ref, `policyChecks.${check.policy}.check.ref`),
        digest: requireDigest(check.check?.digest, `policyChecks.${check.policy}.check.digest`),
      },
    };
  });
  const instance: EnvironmentInstanceIdentity = {
    workerRef: requireNonEmpty(input.instance?.workerRef, "instance.workerRef"),
    deviceId: input.instance?.deviceId ?? null,
    hostIdentity: requireNonEmpty(input.instance?.hostIdentity, "instance.hostIdentity"),
    storageIdentity: requireNonEmpty(input.instance?.storageIdentity, "instance.storageIdentity"),
    backendKind: input.instance?.backendKind === "host_agent" ? "host_agent" : "container",
  };
  const candidate = {
    attemptId: requireNonEmpty(input.candidate?.attemptId, "candidate.attemptId"),
    workspaceBindingId: requireNonEmpty(
      input.candidate?.workspaceBindingId,
      "candidate.workspaceBindingId",
    ),
    recoveryAnchorDigest: input.candidate?.recoveryAnchorDigest ?? null,
  };
  const operationId = requireNonEmpty(
    input.resourceManifest?.operationId,
    "resourceManifest.operationId",
  );
  const resources = input.resourceManifest?.resources;
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new EnvironmentComplianceError("PreparedEvidence.resourceManifest.resources 不能为空");
  }
  const resourceManifest = {
    ...input.resourceManifest,
    operationId,
    resources: resources.map((entry) => ({
      kind: requireNonEmpty(entry?.kind, "resourceManifest.resources[].kind"),
      ref: requireNonEmpty(entry?.ref, "resourceManifest.resources[].ref"),
      identity: requireNonEmpty(entry?.identity, "resourceManifest.resources[].identity"),
    })),
  };
  const verifiedAtMs = input.verifiedAt instanceof Date ? input.verifiedAt.getTime() : Number.NaN;
  const expiresAtMs = input.expiresAt instanceof Date ? input.expiresAt.getTime() : Number.NaN;
  if (!Number.isFinite(verifiedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new EnvironmentComplianceError("PreparedEvidence verifiedAt/expiresAt 必须是有效时间");
  }
  if (expiresAtMs <= verifiedAtMs) {
    throw new EnvironmentComplianceError("PreparedEvidence.expiresAt 必须晚于 verifiedAt");
  }
  if (expiresAtMs - verifiedAtMs > ENVIRONMENT_PREPARED_TTL_MS) {
    throw new EnvironmentComplianceError(
      `PreparedEvidence 有效期不得超过 ${ENVIRONMENT_PREPARED_TTL_MS / 1000} 秒`,
    );
  }
  return {
    schemaVersion: 1,
    revisionId,
    semanticDigest,
    actualTargetDigest,
    verifier,
    policyChecks,
    instance,
    candidate,
    resourceManifest,
    verifiedAt: new Date(verifiedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Prepared 证据摘要。
 *
 * 必须对**规范化**后的结构取摘要：MySQL `JSON` 列在存取时会重排对象键序，
 * 直接 `JSON.stringify` 会让"写入时的摘要"与"回读后的摘要"不一致，
 * 从而把完好的证据误判为被篡改（`Lease.preparedDigest 与 preparedEvidence 不一致`）。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key]);
    return sorted;
  }
  return value;
}

export function environmentPreparedEvidenceDigest(evidence: unknown): string {
  const canonical = JSON.stringify(canonicalize(evidence) ?? null);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export interface AssertEnvironmentPreparedEvidenceContext {
  revisionId: string;
  semanticDigest: string;
  attemptId: string;
  workspaceBindingId: string;
  recoveryAnchorDigest?: string | null;
  now: Date;
}

function readEvidence(value: unknown): EnvironmentPreparedEvidence {
  if (!value || typeof value !== "object") {
    throw new EnvironmentComplianceError("生产写入必须提供实际实例符合性证据（PreparedEvidence）");
  }
  const raw = value as Partial<EnvironmentPreparedEvidence>;
  if (raw.schemaVersion !== 1) {
    throw new EnvironmentComplianceError("PreparedEvidence.schemaVersion 不支持");
  }
  return raw as EnvironmentPreparedEvidence;
}

function readCheckTime(value: unknown, label: string): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new EnvironmentComplianceError(`PreparedEvidence.${label} 不是有效时间`);
  }
  return parsed;
}

/**
 * 复核 Prepared 证据：不满足即抛 `EnvironmentComplianceFailed`。
 *
 * 覆盖（ENV-04）：Revision 变更、Workspace 绑定变更、恢复水位（Anchor）变更、已过有效期。
 * 调用方不得用先前读到的 row 绕过——这里对 `now` 与冻结上下文逐项复验。
 */
export function assertEnvironmentPreparedEvidence(
  value: unknown,
  context: AssertEnvironmentPreparedEvidenceContext,
): EnvironmentPreparedEvidence {
  const evidence = readEvidence(value);
  if (evidence.revisionId !== context.revisionId) {
    throw new EnvironmentComplianceError("PreparedEvidence 与冻结 Revision 不匹配");
  }
  if (evidence.semanticDigest !== context.semanticDigest) {
    throw new EnvironmentComplianceError("PreparedEvidence semanticDigest 与 Revision 不一致");
  }
  if (evidence.candidate.attemptId !== context.attemptId) {
    throw new EnvironmentComplianceError("PreparedEvidence 属于其他 Attempt");
  }
  if (evidence.candidate.workspaceBindingId !== context.workspaceBindingId) {
    throw new EnvironmentComplianceError("PreparedEvidence 属于其他 WorkspaceBinding");
  }
  const expectedAnchor = context.recoveryAnchorDigest ?? null;
  if ((evidence.candidate.recoveryAnchorDigest ?? null) !== expectedAnchor) {
    throw new EnvironmentComplianceError("恢复 Anchor 已变化，Prepared 证据失效");
  }
  const verifiedAt = readCheckTime(evidence.verifiedAt, "verifiedAt");
  const expiresAt = readCheckTime(evidence.expiresAt, "expiresAt");
  if (expiresAt - verifiedAt > ENVIRONMENT_PREPARED_TTL_MS) {
    throw new EnvironmentComplianceError("PreparedEvidence 有效期超过 60 秒上限");
  }
  if (context.now.getTime() > expiresAt) {
    throw new EnvironmentComplianceError("PreparedEvidence 已过期");
  }
  const unsatisfied = evidence.policyChecks.filter((check) => !check.satisfied);
  if (unsatisfied.length > 0) {
    throw new EnvironmentComplianceError(
      `实际策略未满足：${unsatisfied.map((check) => check.policy).join(", ")}`,
    );
  }
  if (!DIGEST_PATTERN.test(evidence.actualTargetDigest)) {
    throw new EnvironmentComplianceError("PreparedEvidence.actualTargetDigest 非法");
  }
  return evidence;
}

/**
 * 当前 Ownership 事务内的激活复验：Lease 上冻结的准备证据必须仍指向
 * "本 Attempt / 本 Revision / 本 Workspace / 本恢复水位"，且未过期。
 *
 * 与 `assertEnvironmentPreparedEvidence` 的区别：入参是已落在 Lease 行上的
 * `preparedEvidence`（JSON）与 `preparedDigest`，用于 activation 前复核。
 */
export function assertLeasePreparedEvidence(input: {
  preparedEvidence: unknown;
  preparedDigest: string | null;
  revisionId: string;
  semanticDigest: string;
  attemptId: string;
  workspaceBindingId: string;
  recoveryAnchorDigest?: string | null;
  now: Date;
}): EnvironmentPreparedEvidence {
  const evidence = assertEnvironmentPreparedEvidence(input.preparedEvidence, {
    revisionId: input.revisionId,
    semanticDigest: input.semanticDigest,
    attemptId: input.attemptId,
    workspaceBindingId: input.workspaceBindingId,
    recoveryAnchorDigest: input.recoveryAnchorDigest,
    now: input.now,
  });
  const expectedDigest = environmentPreparedEvidenceDigest(evidence);
  if (input.preparedDigest !== expectedDigest) {
    throw new EnvironmentComplianceError("Lease.preparedDigest 与 preparedEvidence 不一致");
  }
  return evidence;
}
