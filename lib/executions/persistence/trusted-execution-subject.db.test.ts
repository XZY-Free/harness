import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { mysqlExecutionBindingStore } from "@/lib/executions/persistence/mysql-execution-binding-store";
import {
  TEST_EXECUTION_BINDING_EVIDENCE,
  createExecutionBinding,
} from "@/lib/executions/test-support/create-unverified-execution-binding";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import { recoverTrustedExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { beforeEach, describe, expect, it } from "vitest";

describe("ExecutionBinding trusted execution subject", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  async function seedInvocation(id: string) {
    await db.insert(invocationTable).values({
      id,
      tenantId: DEFAULT_TENANT_ID,
      jobId: id,
      invocationSequence: 1,
      invocationKind: "job",
      executionState: "queued",
    });
  }

  it.each([
    ["user", "employee-42", "authenticated_user"],
    ["service", "job-scheduler", "trusted_service"],
  ] as const)("persists and recovers %s subject", async (subjectType, subjectId, source) => {
    const invocationId = randomUUID();
    await seedInvocation(invocationId);
    const binding = await createExecutionBinding({
      invocationId,
      tenantId: DEFAULT_TENANT_ID,
      runtimeRevisionId: "runtime-revision-test",
      deploymentRouteId: "deployment-route-test",
      modelProvider: "test",
      modelId: "test-model",
      controlPlaneEvidence: TEST_EXECUTION_BINDING_EVIDENCE,
      projectionVersionNo: 1,
      executionSubject: { tenantId: DEFAULT_TENANT_ID, subjectType, subjectId },
    });

    expect(binding).toMatchObject({
      executionSubjectType: subjectType,
      executionSubjectId: subjectId,
      executionSubjectSource: source,
    });
    expect(recoverTrustedExecutionSubject(binding, DEFAULT_TENANT_ID)).toEqual({
      tenantId: DEFAULT_TENANT_ID,
      subjectType,
      subjectId,
    });
  });

  it("fresh schema rejects a binding with no subject", async () => {
    const invocationId = randomUUID();
    await seedInvocation(invocationId);
    await expect(
      db.insert(executionBindingTable).values({
        invocationId,
        tenantId: DEFAULT_TENANT_ID,
        runtimeRevisionId: "runtime-revision-test",
        deploymentRouteId: "deployment-route-test",
        modelProvider: "test",
        modelId: "test-model",
        policyRevisionId: "policy-revision-test",
        policyRulesDigest: `sha256:${"a".repeat(64)}`,
        governanceConfigRevisionId: "governance-revision-test",
        governanceConfigDigest: `sha256:${"b".repeat(64)}`,
        routeRevisionId: "route-revision-test",
        routeActivationId: "route-activation-test",
        routeContentDigest: `sha256:${"c".repeat(64)}`,
        runtimeArtifactId: "runtime-artifact-test",
        runtimeArtifactDigest: `sha256:${"d".repeat(64)}`,
        runtimeEvidenceKind: "hosted_artifact",
        runtimeConfigDigest: `sha256:${"e".repeat(64)}`,
        runtimeTargetDigest: `sha256:${"f".repeat(64)}`,
        capabilityManifestDigest: `sha256:${"1".repeat(64)}`,
        runtimeAttestationIds: ["attestation-test"],
        runtimePublicationRecordId: "publication-test",
        conformanceRunId: "conformance-test",
        resolutionInputDigest: `sha256:${"2".repeat(64)}`,
        projectionVersionNo: 1,
        capabilityCatalogJson: {},
        capabilityCatalogDigest: `sha256:${"3".repeat(64)}`,
        capabilityCatalogVersion: "1",
        capabilityCatalogSourceRefs: ["test"],
        capabilityCatalogCreatedAt: new Date(),
        configHash: `sha256:${"4".repeat(64)}`,
      } as never),
    ).rejects.toThrow();
  });

  it("production repository exposes create only and cannot rewrite a frozen subject", () => {
    expect(Object.keys(mysqlExecutionBindingStore)).toEqual(["create"]);
  });
});
