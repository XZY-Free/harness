import { toExecutionBinding } from "@/lib/executions/persistence/mysql-execution-binding-store";
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
