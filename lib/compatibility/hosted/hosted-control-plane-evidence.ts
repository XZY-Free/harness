import type { ArtifactKind } from "@/lib/artifacts/domain/artifact";
import type {
  BuilderKeyRegistry,
  ManagedArtifactStore,
} from "@/lib/artifacts/domain/artifact-attestation";
import type { RuntimeConformanceReport } from "@/lib/runtimes/domain/runtime-conformance-run";
import { configuredHostedControlPlaneEvidenceProvider } from "./configured-hosted-control-plane-evidence";

export interface HostedArtifactEvidence {
  artifactDigest: string;
  artifactRef: string;
  signatureBundleRef: string;
  sbomRef: string;
  provenanceRef: string;
  builderIdentity: string;
  managedStore: ManagedArtifactStore;
  builderKeys: BuilderKeyRegistry;
}

export interface HostedRuntimeConformanceInput {
  tenantId: string;
  runtimeRevisionId: string;
  /** Runner 必须按此键返回同一个不可变 runId 和报告，供并发/断线重试收敛。 */
  idempotencyKey: string;
  runtimeArtifactDigest: string;
  runtimeConfigDigest: string;
  protocolContractRevision: string;
}

export interface HostedControlPlaneEvidenceProvider {
  /** 返回受管制品引用和平台信任锚；验证结果仍由 Artifact 应用服务决定。 */
  loadArtifactEvidence(input: {
    tenantId: string;
    artifactType: Extract<ArtifactKind, "agent_revision" | "runtime_revision">;
  }): Promise<HostedArtifactEvidence>;
  /** 调用可信 Runner，返回与 draft RuntimeRevision 精确绑定且幂等的签名报告。 */
  runRuntimeConformance(input: HostedRuntimeConformanceInput): Promise<{
    report: RuntimeConformanceReport;
    signature: string;
  }>;
}

let provider: HostedControlPlaneEvidenceProvider | null = null;

export function getHostedControlPlaneEvidenceProvider(): HostedControlPlaneEvidenceProvider {
  return provider ?? configuredHostedControlPlaneEvidenceProvider;
}

/** 覆盖默认配置驱动的证据服务；用于测试或宿主应用显式装配。 */
export function setHostedControlPlaneEvidenceProvider(
  next: HostedControlPlaneEvidenceProvider,
): void {
  provider = next;
}

/** 清除覆盖，恢复配置驱动的默认服务。 */
export function resetHostedControlPlaneEvidenceProvider(): void {
  provider = null;
}
