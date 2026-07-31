/**
 * V11 控制面 schema：ArtifactAttestation（制品证明）。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §8.2、
 *         ../v11-agentkit-platform/14-production-operations-security-and-retention.md §4.1-4.2、
 *         ../v11-agentkit-platform/11-api-and-event-boundaries.md §6（artifact-attestations:verify）、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W04。
 *
 * ArtifactAttestation 保存制品供应链验证记录：digest、签名/SBOM/provenance 引用、builder 身份、
 * 验证结论与策略修订。验证服务独立读取签名/SBOM/provenance（调用方不能自报 verified）。
 *
 * 关键约束：
 * - UNIQUE(tenantId, artifactType, artifactRevisionId, artifactDigest, signatureBundleRef)：
 *   同一制品 digest 可多份证明（不同签名 bundle）。
 * - verification_state ∈ {verified, failed}：verified 才允许发布/路由引用。
 * - signature_bundle_ref / sbom_ref / provenance_ref 必须是受管对象引用，不接受任意公网 URL。
 * - artifact_digest 必须是 sha256:<hex> 格式，不接受可变 tag 作为历史依据。
 * - builder_identity 必须在租户或平台允许的 builder 白名单中。
 * - 验证失败也持久化记录（安全摘要 + AuditEvent），不泄露内部漏洞细节给无权调用者。
 *
 * 多态引用：通过 (artifactType, artifactRevisionId) 引用 AgentRevision/RuntimeRevision/Skill/Tool/Policy。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/v11/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  datetime,
  index,
  json,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── Artifact Type ─────────────────────────────────────────

/**
 * 制品类型（多态引用目标）。
 * - agent_revision：AgentRevision（agent_artifact_ref 制品）。
 * - runtime_revision：RuntimeRevision（runtime_artifact_ref 制品）。
 * - skill_package：Skill 内容包（阶段 6 接入）。
 * - tool_provider：Tool Provider Adapter（阶段 6 接入）。
 * - policy_bundle：Policy 修订包（阶段 11 接入）。
 */
export const ARTIFACT_TYPES = [
  "agent_revision",
  "runtime_revision",
  "skill_package",
  "tool_provider",
  "policy_bundle",
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

// ─── Verification State ────────────────────────────────────

/**
 * 验证状态。
 * - verified：签名、SBOM、provenance 全部校验通过，可被发布/路由引用。
 * - failed：任一校验失败；记录 failureCode 分类原因，不泄露内部漏洞细节。
 */
export const VERIFICATION_STATES = ["verified", "failed"] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

// ─── Failure Code ──────────────────────────────────────────

/**
 * 验证失败分类码（持久化到 failure_code 字段，供审计与运维查询；不向无权调用者返回细节）。
 * - unknown_artifact_type：artifact_type 不在允许枚举内。
 * - digest_format_invalid：artifact_digest 非 sha256:hex 格式。
 * - signature_ref_not_managed / sbom_ref_not_managed / provenance_ref_not_managed：引用非受管对象。
 * - builder_not_allowed：builder identity 不在白名单。
 * - signature_bundle_unreadable / sbom_unreadable / provenance_unreadable：受管存储读取失败。
 * - signature_algorithm_unsupported：签名算法非 ed25519。
 * - builder_key_mismatch：签名 bundle 公钥与 builder 白名单不一致。
 * - signature_invalid：ed25519 验签失败。
 * - sbom_blocked_vulnerability：SBOM 命中阻断漏洞（critical/high）。
 * - sbom_blocked_license：SBOM 命中阻断许可证（GPL/AGPL 系列）。
 * - provenance_missing_field：provenance 缺少必填字段。
 * - provenance_buildtime_invalid：provenance buildTime 非有效时间。
 */
export const ATTESTATION_FAILURE_CODES = [
  "unknown_artifact_type",
  "digest_format_invalid",
  "signature_ref_not_managed",
  "sbom_ref_not_managed",
  "provenance_ref_not_managed",
  "builder_not_allowed",
  "signature_bundle_unreadable",
  "sbom_unreadable",
  "provenance_unreadable",
  "signature_algorithm_unsupported",
  "builder_key_mismatch",
  "signature_invalid",
  "sbom_blocked_vulnerability",
  "sbom_blocked_license",
  "provenance_missing_field",
  "provenance_buildtime_invalid",
  "attestation_revoked",
] as const;
export type AttestationFailureCode = (typeof ATTESTATION_FAILURE_CODES)[number];

// ─── ArtifactAttestation ───────────────────────────────────

export const v11ArtifactAttestation = mysqlTable(
  "V11ArtifactAttestation",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 制品类型（多态引用 discriminator）。 */
    artifactType: varchar("artifactType", { length: 32 }).notNull(),
    /** 目标修订 id（多态外键 → AgentRevision/RuntimeRevision/Skill/Tool/Policy）。 */
    artifactRevisionId: varchar("artifactRevisionId", { length: 36 }).notNull(),
    /** 制品内容 digest，sha256:<hex> 格式；不接受可变 tag。 */
    artifactDigest: varchar("artifactDigest", { length: 128 }).notNull(),
    /** 签名 bundle 受管对象引用（非公网 URL）。 */
    signatureBundleRef: varchar("signatureBundleRef", { length: 512 }).notNull(),
    /** SBOM 受管对象引用。 */
    sbomRef: varchar("sbomRef", { length: 512 }).notNull(),
    /** provenance 受管对象引用。 */
    provenanceRef: varchar("provenanceRef", { length: 512 }).notNull(),
    /** 签名 builder 身份（必须在白名单），如 builder:company-agent-runtime。 */
    builderIdentity: varchar("builderIdentity", { length: 256 }).notNull(),
    /** 验证结论：verified 或 failed。 */
    verificationState: varchar("verificationState", { length: 32 }).notNull(),
    /** 验证所用策略修订 id（可选；本地白名单 fallback 时为 null）。 */
    policyRevisionId: varchar("policyRevisionId", { length: 36 }),
    /** provenance 来源 revision（git commit sha 等）；S12-W04 持久化以便 MySQL 可查询。 */
    sourceRevision: varchar("sourceRevision", { length: 128 }),
    /** provenance 构建流水线标识。 */
    buildPipeline: varchar("buildPipeline", { length: 256 }),
    /** 依赖锁文件 hash（sha256:<hex>）。 */
    dependencyLockFileHash: varchar("dependencyLockFileHash", { length: 128 }),
    /** provenance 构建时间。 */
    buildTime: datetime("buildTime", { mode: "date", fsp: 3 }),
    /** 扫描摘要 JSON：命中漏洞/许可证计数等（不存原文漏洞细节）。 */
    scanSummaryJson: json("scanSummaryJson"),
    /** 验证失败分类码（仅 verification_state=failed 时非 null）。 */
    failureCode: varchar("failureCode", { length: 64 }),
    /** 验证完成时间（无论成功失败都写）。 */
    verifiedAt: datetime("verifiedAt", { mode: "date", fsp: 3 }),
    /** 撤销时间（null 表示未撤销；撤销后阻止新 Invocation/发布/路由）。 */
    revokedAt: datetime("revokedAt", { mode: "date", fsp: 3 }),
    /** 撤销操作者（userIdentityId / serviceId）。 */
    revokedBy: varchar("revokedBy", { length: 128 }),
    /** 撤销原因。 */
    revocationReason: text("revocationReason"),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantTypeRevDigestSigUq: uniqueIndex(
      "V11ArtifactAttestation_tenant_type_rev_digest_sig_uq",
    ).on(t.tenantId, t.artifactType, t.artifactRevisionId, t.artifactDigest, t.signatureBundleRef),
    tenantTypeRevStateIdx: index("V11ArtifactAttestation_tenant_type_rev_state_idx").on(
      t.tenantId,
      t.artifactType,
      t.artifactRevisionId,
      t.verificationState,
    ),
    tenantDigestIdx: index("V11ArtifactAttestation_tenant_digest_idx").on(
      t.tenantId,
      t.artifactDigest,
    ),
    tenantRevokedIdx: index("V11ArtifactAttestation_tenant_revoked_idx").on(
      t.tenantId,
      t.revokedAt,
    ),
  }),
);

export type V11ArtifactAttestation = InferSelectModel<typeof v11ArtifactAttestation>;
export type NewV11ArtifactAttestation = InferInsertModel<typeof v11ArtifactAttestation>;
