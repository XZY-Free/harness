import { randomUUID } from "node:crypto";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { seedAgentContractSnapshot } from "@/lib/agents/test-support/seed-agent-contract-snapshot";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { publicationRecord } from "@/lib/publications/persistence/publication-record";
import { PUBLICATION_CONFORMANCE_CASES } from "@/lib/runtime/domain/runtime-conformance-contract";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeRuntimeRevisionEligibility,
  loadRuntimeRevisionAdminProjection,
  projectRuntime,
} from "./runtime-admin-projection";

describe("runtime admin projection", () => {
  it("投影真实 Runtime 生命周期与版本", () => {
    expect(
      projectRuntime({
        id: "runtime-1",
        tenantId: "tenant-1",
        runtimeKey: "hosted",
        displayName: "Hosted",
        runtimeKind: "hosted",
        ownerUserId: "user-1",
        lifecycleState: "enabled",
        currentRevisionId: "revision-1",
        versionNo: 3,
        createdAt: new Date("2026-08-11T00:00:00.000Z"),
        updatedAt: new Date("2026-08-11T00:01:00.000Z"),
        deletedAt: null,
      }),
    ).toMatchObject({
      tenant_id: "tenant-1",
      kind: "hosted",
      lifecycle_state: "enabled",
      version_no: 3,
    });
  });

  it("只有冻结 Publication 证据和 Conformance 全部有效时可执行", () => {
    const base = {
      runtimeLifecycleState: "enabled",
      revisionState: "published",
      runtimeEvidenceKind: "hosted_artifact" as const,
      artifactId: "artifact-1",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      publicationAttestationIds: ["attestation-1"],
      verifiedActiveAttestationIds: ["attestation-1"],
      publicationConformanceRunId: "run-1",
      validConformanceRunId: "run-1",
      hasPublication: true,
      hasWithdrawal: false,
    };
    expect(computeRuntimeRevisionEligibility(base)).toEqual({
      executionEligible: true,
      ineligibilityReasons: [],
    });
    expect(
      computeRuntimeRevisionEligibility({ ...base, validConformanceRunId: "run-2" }),
    ).toMatchObject({ executionEligible: false });
  });
});

// ─── 02 专项：Candidate 与 Publication-bound Conformance 分离 ──

describe("loadRuntimeRevisionAdminProjection conformance 语义分离", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterEach(async () => {
    await resetDatabase(db);
  });

  interface SeededRevision {
    tenantId: string;
    revisionId: string;
    runtimeTargetDigest: string;
    configHash: string;
    protocolContractRevision: string;
  }

  async function seedExternalRevision(): Promise<SeededRevision> {
    const tenant = await ensureDefaultTenant();
    const runtimeId = randomUUID();
    const revisionId = randomUUID();
    const runtimeTargetDigest = `sha256:${"b".repeat(64)}`;
    const configHash = `sha256:${"c".repeat(64)}`;
    await db.insert(runtimeTable).values({
      id: runtimeId,
      tenantId: tenant.id,
      runtimeKey: `runtime-${revisionId}`,
      displayName: "Runtime",
      runtimeKind: "external",
      ownerUserId: randomUUID(),
      lifecycleState: "enabled",
      currentRevisionId: revisionId,
      versionNo: 1,
    });
    await db.insert(runtimeRevisionTable).values({
      id: revisionId,
      runtimeId,
      revisionNo: 1,
      protocolType: "harness_runtime_protocol",
      protocolContractRevision: "harness-runtime-protocol@1",
      runtimeEvidenceKind: "external_endpoint",
      runtimeTargetDigest,
      endpointRef: `https://runtime.example.test/${revisionId}`,
      runtimeCapabilitiesJson: [],
      identityMode: "none",
      networkZone: "external",
      configHash,
      revisionState: "draft",
      createdBy: "projection-test",
    });
    return {
      tenantId: tenant.id,
      revisionId,
      runtimeTargetDigest,
      configHash,
      protocolContractRevision: "harness-runtime-protocol@1",
    };
  }

  /** 直插一条 Run（含 6 个全部 passed 的 Case），绑定与时间可控。 */
  async function seedConformanceRun(
    revision: SeededRevision,
    options: {
      runId: string;
      overallResult?: "passed" | "failed";
      targetDigest?: string;
      completedAt: Date;
      recordedAt: Date;
    },
  ): Promise<void> {
    await db.insert(runtimeConformanceRun).values({
      id: options.runId,
      tenantId: revision.tenantId,
      runtimeRevisionId: revision.revisionId,
      runtimeTargetDigest: options.targetDigest ?? revision.runtimeTargetDigest,
      runtimeConfigDigest: revision.configHash,
      protocolContractRevision: revision.protocolContractRevision,
      suiteRevision: "runtime-conformance@1",
      runnerArtifactDigest: `sha256:${"1".repeat(64)}`,
      runnerIdentity: "test-runner",
      testEnvironmentRevision: "test-env@1",
      startedAt: new Date(options.completedAt.getTime() - 1000),
      completedAt: options.completedAt,
      overallResult: options.overallResult ?? "passed",
      evidenceManifestDigest: `sha256:${randomUUID().replace(/-/g, "")}`,
      envelopeDigest: `sha256:${randomUUID().replace(/-/g, "")}`,
      envelopeJson: "{}",
      payloadDigest: `sha256:${randomUUID().replace(/-/g, "")}`,
      signingKeyId: "key-1",
      verificationEngine: "dsse",
      verificationEngineVersion: "1",
      predicateType: "predicate",
      verifiedAt: options.completedAt,
      idempotencyKey: `idem-${options.runId}`,
      requestId: `req-${options.runId}`,
      recordedAt: options.recordedAt,
    });
    await db.insert(runtimeConformanceCaseResult).values(
      PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({
        id: randomUUID(),
        runId: options.runId,
        caseId,
        passed: true,
        reason: null,
        evidenceDigest: `sha256:${randomUUID().replace(/-/g, "")}`,
      })),
    );
  }

  async function seedPublication(
    revision: SeededRevision,
    conformanceRunId: string,
  ): Promise<void> {
    await db.insert(publicationRecord).values({
      id: randomUUID(),
      tenantId: revision.tenantId,
      subjectType: "runtime_revision",
      subjectRevisionId: revision.revisionId,
      evidenceSetDigest: `sha256:${randomUUID().replace(/-/g, "")}`,
      attestationIds: [],
      conformanceRunId,
      approvals: [],
      publishedByType: "user",
      publishedBy: "projection-test",
      publishedAt: new Date(),
      idempotencyKey: `idem-pub-${randomUUID()}`,
    });
  }

  it("draft external revision + passed exact Run：latest_valid=该 Run；publication=null", async () => {
    const revision = await seedExternalRevision();
    await seedConformanceRun(revision, {
      runId: "run-candidate-1",
      completedAt: new Date("2026-08-27T00:00:00.000Z"),
      recordedAt: new Date("2026-08-27T00:00:01.000Z"),
    });
    const projection = await loadRuntimeRevisionAdminProjection(
      revision.tenantId,
      revision.revisionId,
    );
    expect(projection?.latest_valid_conformance_run_id).toBe("run-candidate-1");
    expect(projection?.latest_valid_conformance_overall_result).toBe("passed");
    expect(projection?.publication_conformance_run_id).toBeNull();
  });

  it("latest Run failed、前一条 passed：选择前一条 valid passed", async () => {
    const revision = await seedExternalRevision();
    await seedConformanceRun(revision, {
      runId: "run-passed-early",
      completedAt: new Date("2026-08-27T00:00:00.000Z"),
      recordedAt: new Date("2026-08-27T00:00:01.000Z"),
    });
    await seedConformanceRun(revision, {
      runId: "run-failed-later",
      overallResult: "failed",
      completedAt: new Date("2026-08-27T01:00:00.000Z"),
      recordedAt: new Date("2026-08-27T01:00:01.000Z"),
    });
    const projection = await loadRuntimeRevisionAdminProjection(
      revision.tenantId,
      revision.revisionId,
    );
    expect(projection?.latest_valid_conformance_run_id).toBe("run-passed-early");
  });

  it("passed 但 runtimeTargetDigest 不匹配：不可作为 latest_valid", async () => {
    const revision = await seedExternalRevision();
    await seedConformanceRun(revision, {
      runId: "run-digest-mismatch",
      targetDigest: `sha256:${"9".repeat(64)}`,
      completedAt: new Date("2026-08-27T00:00:00.000Z"),
      recordedAt: new Date("2026-08-27T00:00:01.000Z"),
    });
    const projection = await loadRuntimeRevisionAdminProjection(
      revision.tenantId,
      revision.revisionId,
    );
    expect(projection?.latest_valid_conformance_run_id).toBeNull();
  });

  it("published Revision：Publication 绑定 Run A 后又出现 Run B，publication 仍 A，eligibility 按 A", async () => {
    const revision = await seedExternalRevision();
    await seedConformanceRun(revision, {
      runId: "run-a",
      completedAt: new Date("2026-08-27T00:00:00.000Z"),
      recordedAt: new Date("2026-08-27T00:00:01.000Z"),
    });
    await seedPublication(revision, "run-a");
    // 发布后 draft 阶段出现更新的 passed Run B（不影响执行 Authority）。
    await seedConformanceRun(revision, {
      runId: "run-b",
      completedAt: new Date("2026-08-27T02:00:00.000Z"),
      recordedAt: new Date("2026-08-27T02:00:01.000Z"),
    });
    const projection = await loadRuntimeRevisionAdminProjection(
      revision.tenantId,
      revision.revisionId,
    );
    expect(projection?.latest_valid_conformance_run_id).toBe("run-b");
    expect(projection?.publication_conformance_run_id).toBe("run-a");
    // eligibility 只认 Publication 绑定的 run-a（publication_conformance_evidence_mismatch 不出现）。
    expect(projection?.ineligibility_reasons).not.toContain(
      "publication_conformance_evidence_mismatch",
    );
  });
});
