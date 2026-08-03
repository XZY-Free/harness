import type { ArtifactKind } from "@/lib/artifacts/domain/artifact";
import type {
  BuilderKeyRegistry,
  ManagedArtifactStore,
} from "@/lib/artifacts/domain/artifact-attestation";
import type { RuntimeConformanceReport } from "@/lib/runtimes/domain/runtime-conformance-run";

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

class MissingHostedControlPlaneEvidenceProvider implements HostedControlPlaneEvidenceProvider {
  async loadArtifactEvidence(): Promise<never> {
    throw new Error("Hosted 控制面证据源未配置");
  }

  async runRuntimeConformance(): Promise<never> {
    throw new Error("Hosted 控制面证据源未配置");
  }
}

const missingProvider = new MissingHostedControlPlaneEvidenceProvider();
let provider: HostedControlPlaneEvidenceProvider | null = null;

export function getHostedControlPlaneEvidenceProvider(): HostedControlPlaneEvidenceProvider {
  return provider ?? missingProvider;
}

/** 应用启动装配可信制品存储和独立 Conformance Runner；未装配时保持 fail-closed。 */
export function setHostedControlPlaneEvidenceProvider(
  next: HostedControlPlaneEvidenceProvider,
): void {
  provider = next;
}

/** 仅用于测试隔离和进程关闭。 */
export function resetHostedControlPlaneEvidenceProvider(): void {
  provider = null;
}
