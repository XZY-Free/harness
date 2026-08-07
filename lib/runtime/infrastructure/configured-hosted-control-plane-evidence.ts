import type {
 BuilderKeyRegistry,
 ManagedArtifactStore,
 ProvenanceDocument,
} from "@/lib/artifacts/domain/artifact-attestation";
import { hostedControlPlaneConfig } from "@/lib/config";
import type {
 HostedControlPlaneEvidenceProvider,
 HostedRuntimeConformanceInput,
} from "@/lib/runtime/domain/hosted-control-plane-evidence";
import { setDefaultHostedControlPlaneEvidenceProvider } from "@/lib/runtime/domain/hosted-control-plane-evidence";

export interface HostedEvidenceServiceConfig {
 readonly endpoint: string;
 readonly token: string;
 readonly builderKeys: BuilderKeyRegistry;
 readonly timeoutMs: number;
}

export function createConfiguredHostedControlPlaneEvidenceProvider(dependencies: {
 config: HostedEvidenceServiceConfig;
 fetchImpl?: typeof fetch;
}): HostedControlPlaneEvidenceProvider {
 const fetchImpl = dependencies.fetchImpl ?? fetch;
 const managedStore = createHttpManagedArtifactStore(dependencies.config, fetchImpl);

 return {
 async loadArtifactEvidence(input) {
 assertConfigured(dependencies.config);
 const payload = await requestJson(
 dependencies.config,
 fetchImpl,
 "/v1/hosted-artifacts:resolve",
 {
 tenant_id: input.tenantId,
 artifact_type: input.artifactType,
 },
 );
 return {
 artifactDigest: requireString(payload, "artifact_digest"),
 artifactRef: requireString(payload, "artifact_ref"),
 dsseEnvelopeRef: requireString(payload, "dsse_envelope_ref"),
 sbomRef: requireString(payload, "sbom_ref"),
 provenanceRef: requireString(payload, "provenance_ref"),
 builderIdentity: requireString(payload, "builder_identity"),
 managedStore,
 builderKeys: dependencies.config.builderKeys,
 };
 },

 async runRuntimeConformance(input) {
 assertConfigured(dependencies.config);
 const payload = await requestJson(
 dependencies.config,
 fetchImpl,
 "/v1/runtime-conformance-runs",
 conformanceRequest(input),
 input.idempotencyKey,
 );
 const dsseEnvelope = payload.dsse_envelope;
 if (typeof dsseEnvelope !== "string" || !dsseEnvelope) {
 throw new Error("Hosted 证据服务返回的 DSSE Envelope 非法");
 }
 return { dsseEnvelope };
 },
 };
}

export const configuredHostedControlPlaneEvidenceProvider =
 createConfiguredHostedControlPlaneEvidenceProvider({
 config: hostedControlPlaneConfig,
 });

setDefaultHostedControlPlaneEvidenceProvider(configuredHostedControlPlaneEvidenceProvider);

function createHttpManagedArtifactStore(
 config: HostedEvidenceServiceConfig,
 fetchImpl: typeof fetch,
): ManagedArtifactStore {
 async function readDocument(ref: string, documentType: string): Promise<Record<string, unknown>> {
 assertConfigured(config);
 const payload = await requestJson(config, fetchImpl, "/v1/managed-artifacts:read", {
 ref,
 document_type: documentType,
 });
 const document = payload.document;
 if (!document || typeof document !== "object" || Array.isArray(document)) {
 throw new Error(`Hosted 证据服务返回的 ${documentType} 文档非法`);
 }
 return document as Record<string, unknown>;
 }

 return {
 async readDsseEnvelope(ref): Promise<Buffer> {
 const document = await readDocument(ref, "dsse_envelope");
 const envelopeJson = JSON.stringify(document);
 return Buffer.from(envelopeJson, "utf-8");
 },
 async readSbom(ref): Promise<unknown> {
 const document = await readDocument(ref, "sbom");
 if (!document || typeof document !== "object") {
 throw new Error("Hosted 证据服务返回的 SBOM 文档非法");
 }
 return document;
 },
 async readProvenance(ref): Promise<ProvenanceDocument> {
 const document = await readDocument(ref, "provenance");
 return {
 sourceRevision: requireString(document, "sourceRevision"),
 buildPipeline: requireString(document, "buildPipeline"),
 dependencyLockFile: requireString(document, "dependencyLockFile"),
 buildTime: requireString(document, "buildTime"),
 };
 },
 };
}

async function requestJson(
 config: HostedEvidenceServiceConfig,
 fetchImpl: typeof fetch,
 path: string,
 body: Record<string, unknown>,
 idempotencyKey?: string,
): Promise<Record<string, unknown>> {
 assertConfigured(config);
 const headers = new Headers({
 authorization: `Bearer ${config.token}`,
 "content-type": "application/json",
 });
 if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
 const response = await fetchImpl(`${config.endpoint}${path}`, {
 method: "POST",
 headers,
 body: JSON.stringify(body),
 signal: AbortSignal.timeout(config.timeoutMs),
 });
 if (!response.ok) {
 throw new Error(`Hosted 证据服务请求失败 (${response.status})`);
 }
 const payload = (await response.json()) as unknown;
 if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
 throw new Error("Hosted 证据服务返回非法 JSON");
 }
 return payload as Record<string, unknown>;
}

function assertConfigured(config: HostedEvidenceServiceConfig): void {
 let endpoint: URL;
 try {
 endpoint = new URL(config.endpoint);
 } catch {
 throw new Error("Hosted 控制面证据源未配置：服务地址无效");
 }
 const builderKeys = Object.values(config.builderKeys);
 if (
 !config.token ||
 !builderKeys.length ||
 builderKeys.some((key) => typeof key !== "string" || !key)
 ) {
 throw new Error("Hosted 控制面证据源未配置：Token 或 Builder 信任锚缺失");
 }
 if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost") {
 throw new Error("Hosted 控制面证据源必须使用 HTTPS");
 }
}

function requireString(source: Record<string, unknown>, field: string): string {
 const value = source[field];
 if (typeof value !== "string" || !value) {
 throw new Error(`Hosted 证据服务响应缺少 ${field}`);
 }
 return value;
}

function conformanceRequest(input: HostedRuntimeConformanceInput): Record<string, unknown> {
 return {
 tenant_id: input.tenantId,
 runtime_revision_id: input.runtimeRevisionId,
 runtime_artifact_digest: input.runtimeArtifactDigest,
 runtime_config_digest: input.runtimeConfigDigest,
 protocol_contract_revision: input.protocolContractRevision,
 };
}
