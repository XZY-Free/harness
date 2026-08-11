import {
 EXECUTION_BINDING_AUTHORITY_LOCK_ORDER,
 toExecutionBinding,
 validateFrozenPublicationAuthority,
} from "@/lib/executions/persistence/mysql-execution-binding-store";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type BindingRow = Parameters<typeof toExecutionBinding>[0];

const bindingRow: BindingRow = {
 invocationId: "invocation-1",
 tenantId: "tenant-1",
 agentRevisionId: "agent-revision-1",
 runtimeRevisionId: "runtime-revision-1",
 deploymentRouteId: "route-1",
 modelProvider: "provider",
 modelId: "model",
 modelRevisionRef: null,
 initialEnvironmentLeaseId: null,
 workspaceBindingId: null,
 policyRevisionId: null,
 contextCheckpointId: null,
 routeRevisionId: "route-revision-1",
 routeActivationId: "route-activation-1",
 routeContentDigest: `sha256:${"1".repeat(64)}`,
 agentArtifactDigest: `sha256:${"2".repeat(64)}`,
 runtimeArtifactDigest: `sha256:${"3".repeat(64)}`,
 runtimeConfigDigest: `sha256:${"4".repeat(64)}`,
 capabilityManifestDigest: `sha256:${"5".repeat(64)}`,
 agentAttestationIds: ["agent-attestation-1"],
 runtimeAttestationIds: ["runtime-attestation-1"],
 agentPublicationRecordId: "agent-publication-1",
 runtimePublicationRecordId: "runtime-publication-1",
 conformanceRunId: "conformance-run-1",
 resolutionInputDigest: `sha256:${"6".repeat(64)}`,
 projectionVersionNo: 0,
 environmentDefinitionRevisionId: null,
 configHash: `sha256:${"7".repeat(64)}`,
 boundAt: new Date("2026-08-11T00:00:00.000Z"),
};

describe("toExecutionBinding", () => {
 it("projectionVersionNo=0 是合法的冻结版本", () => {
 expect(toExecutionBinding(bindingRow).projectionVersionNo).toBe(0);
 });

 it("回读缺失 resolutionInputDigest 时 fail-closed", () => {
 expect(() =>
 toExecutionBinding({ ...bindingRow, resolutionInputDigest: "" }),
 ).toThrow(/证据字段不完整/);
 });

 it("回读 projectionVersionNo 不是非负整数时 fail-closed", () => {
 expect(() =>
 toExecutionBinding({ ...bindingRow, projectionVersionNo: 1.5 }),
 ).toThrow(/证据字段不完整/);
 expect(() =>
 toExecutionBinding({ ...bindingRow, projectionVersionNo: -1 }),
 ).toThrow(/证据字段不完整/);
 });
});

describe("ExecutionBinding authority final validation", () => {
 it("公开固定的串行锁序并禁止旧 Route authority", () => {
 expect(EXECUTION_BINDING_AUTHORITY_LOCK_ORDER).toEqual([
 "Invocation",
 "DeploymentRoute+DeploymentRouteSet",
 "RouteActivation",
 "RouteRevision",
 "Agent",
 "AgentRevision",
 "Runtime",
 "RuntimeRevision",
 "AgentPublicationRecord",
 "AgentWithdrawalRecord",
 "RuntimePublicationRecord",
 "RuntimeWithdrawalRecord",
 "AgentArtifactAttestation",
 "AgentAttestationRevocation",
 "RuntimeArtifactAttestation",
 "RuntimeAttestationRevocation",
 "RuntimeConformanceRun",
 "RuntimeConformanceCaseResult",
 "PolicyRevision",
 "RouteEligibilityProjection",
 ]);

 const source = readFileSync(new URL("./mysql-execution-binding-store.ts", import.meta.url), "utf8");
 expect(source).not.toContain("activeRouteRevisionId");
 expect(source).not.toContain("Promise.all(");
 });

 it("只接受租户、主体、修订、证明全集和 ConformanceRun 精确一致的冻结 Publication", () => {
 const base = {
 publication: {
 id: "publication-1",
 tenantId: "tenant-1",
 subjectType: "runtime_revision" as const,
 subjectRevisionId: "runtime-revision-1",
 attestationIds: ["attestation-b", "attestation-a"],
 conformanceRunId: "conformance-run-1",
 },
 withdrawal: null,
 expected: {
 publicationRecordId: "publication-1",
 tenantId: "tenant-1",
 subjectType: "runtime_revision" as const,
 subjectRevisionId: "runtime-revision-1",
 attestationIds: ["attestation-a", "attestation-b"],
 conformanceRunId: "conformance-run-1",
 },
 };

 expect(() => validateFrozenPublicationAuthority(base)).not.toThrow();
 expect(() =>
 validateFrozenPublicationAuthority({
 ...base,
 publication: { ...base.publication, tenantId: "other-tenant" },
 }),
 ).toThrow(/Publication/);
 expect(() =>
 validateFrozenPublicationAuthority({
 ...base,
 publication: { ...base.publication, attestationIds: ["attestation-a"] },
 }),
 ).toThrow(/Attestation/);
 expect(() =>
 validateFrozenPublicationAuthority({
 ...base,
 publication: { ...base.publication, conformanceRunId: "other-run" },
 }),
 ).toThrow(/ConformanceRun/);
 expect(() =>
 validateFrozenPublicationAuthority({
 ...base,
 withdrawal: { id: "withdrawal-1" },
 }),
 ).toThrow(/撤回/);
 });

 it("拒绝空、重复或非精确全集的 Attestation IDs", () => {
 const input = {
 publication: {
 id: "publication-1",
 tenantId: "tenant-1",
 subjectType: "agent_revision" as const,
 subjectRevisionId: "agent-revision-1",
 attestationIds: ["attestation-1"],
 conformanceRunId: null,
 },
 withdrawal: null,
 expected: {
 publicationRecordId: "publication-1",
 tenantId: "tenant-1",
 subjectType: "agent_revision" as const,
 subjectRevisionId: "agent-revision-1",
 attestationIds: ["attestation-1"],
 conformanceRunId: null,
 },
 };

 expect(() =>
 validateFrozenPublicationAuthority({
 ...input,
 expected: { ...input.expected, attestationIds: [] },
 }),
 ).toThrow(/Attestation/);
 expect(() =>
 validateFrozenPublicationAuthority({
 ...input,
 publication: { ...input.publication, attestationIds: ["attestation-1", "attestation-1"] },
 }),
 ).toThrow(/Attestation/);
 });
});
