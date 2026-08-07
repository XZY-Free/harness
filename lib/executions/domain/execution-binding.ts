import { createHash } from "node:crypto";
import type { RouteControlPlaneEvidence } from "@/lib/routes/domain/route-resolution-policy";

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export interface ExecutionBindingControlPlaneEvidence extends RouteControlPlaneEvidence {
 routeRevisionId: string;
 routeActivationId: string;
 routeContentDigest: string;
 /** §07: Resolver 输入摘要 — 冻结解析时刻的请求参数 Digest。 */
 resolutionInputDigest: string;
}

export interface ExecutionBindingConfigInput {
 agentRevisionId: string;
 runtimeRevisionId: string;
 deploymentRouteId: string;
 modelProvider: string;
 modelId: string;
 modelRevisionRef: string | null;
 initialEnvironmentLeaseId: string | null;
 workspaceBindingId: string | null;
 policyRevisionId: string | null;
 contextCheckpointId: string | null;
 environmentDefinitionRevisionId: string | null;
 controlPlaneEvidence: ExecutionBindingControlPlaneEvidence;
 /** Projection 版本号 — Binding 用此检测 Projection 滞后。第三批新增。 */
 projectionVersionNo?: number;
}

export interface ExecutionBinding
 extends Omit<ExecutionBindingConfigInput, "controlPlaneEvidence">,
 ExecutionBindingControlPlaneEvidence {
 invocationId: string;
 tenantId: string;
 configHash: string;
 boundAt: Date;
}

export class ExecutionBindingEvidenceError extends Error {
 constructor(message: string) {
 super(`ExecutionBinding 控制面证据无效：${message}`);
 this.name = "ExecutionBindingEvidenceError";
 }
}

export class ExecutionBindingAlreadyExistsError extends Error {
 constructor(invocationId: string) {
 super(`Invocation ${invocationId} 已存在 ExecutionBinding`);
 this.name = "ExecutionBindingAlreadyExistsError";
 }
}

export function computeExecutionBindingConfigHash(input: ExecutionBindingConfigInput): string {
 assertExecutionBindingEvidence(input.controlPlaneEvidence);
 if (typeof input.projectionVersionNo !== "number" || input.projectionVersionNo < 0) {
 throw new ExecutionBindingEvidenceError("projectionVersionNo 必须为非负整数");
 }
 const canonical = JSON.stringify(
 sortKeys({
 ...input,
 controlPlaneEvidence: {
 ...input.controlPlaneEvidence,
 agentAttestationIds: [...input.controlPlaneEvidence.agentAttestationIds].sort(),
 runtimeAttestationIds: [...input.controlPlaneEvidence.runtimeAttestationIds].sort(),
 },
 }),
 );
 return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function assertExecutionBindingEvidence(
 evidence: ExecutionBindingControlPlaneEvidence,
): void {
 const identifiers = [
 evidence.routeRevisionId,
 evidence.routeActivationId,
 evidence.agentPublicationRecordId,
 evidence.runtimePublicationRecordId,
 evidence.conformanceRunId,
 ];
 if (identifiers.some((value) => !value)) {
 throw new ExecutionBindingEvidenceError("缺少 Route、Publication 或 Conformance 引用");
 }
 const digests = [
 evidence.routeContentDigest,
 evidence.agentArtifactDigest,
 evidence.runtimeArtifactDigest,
 evidence.runtimeConfigDigest,
 evidence.capabilityManifestDigest,
 evidence.resolutionInputDigest,
 ];
 if (digests.some((value) => !SHA256.test(value))) {
 throw new ExecutionBindingEvidenceError("Digest 格式非法");
 }
 if (!validIds(evidence.agentAttestationIds) || !validIds(evidence.runtimeAttestationIds)) {
 throw new ExecutionBindingEvidenceError("Attestation 引用不能为空或重复");
 }
}

function validIds(values: string[]): boolean {
 return (
 values.length > 0 &&
 values.every((value) => Boolean(value)) &&
 new Set(values).size === values.length
 );
}

function sortKeys(value: unknown): unknown {
 if (value === null || typeof value !== "object") return value;
 if (Array.isArray(value)) return value.map(sortKeys);
 const result: Record<string, unknown> = {};
 for (const key of Object.keys(value as Record<string, unknown>).sort()) {
 result[key] = sortKeys((value as Record<string, unknown>)[key]);
 }
 return result;
}
