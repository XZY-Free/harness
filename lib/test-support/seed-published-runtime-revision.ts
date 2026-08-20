/**
 * 可复用的 hosted Runtime + published RuntimeRevision 装配。
 *
 * 从 `seed-dispatchable-turn.ts` 抽出，供 vitest 夹具与 e2e 正式链引导共用
 * （§22 禁止"为了迁移先复制一套代码"）。
 *
 * 发布链全部走正式服务：真实 DSSE Artifact Attestation → 正式验签落库 →
 * 正式 DSSE Conformance 验签 → `createPublishRuntimeRevision`。
 */
import { computeArtifactDigest } from "@/lib/artifacts/domain/artifact-attestation";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import {
  createDraftRuntimeRevision,
  getRuntimeRevisionById,
} from "@/lib/runtime/persistence/runtime-revision-queries";
import { createVerifiedAttestation } from "@/lib/test-support/create-verified-attestation";
import { publishTrustedRuntimeRevisionForTest } from "@/lib/test-support/publish-trusted-runtime-revision";

/**
 * 建出 enabled hosted Runtime 与其 published RuntimeRevision。
 *
 * @param capabilities Runtime 声明的能力集（需覆盖 Agent 的 interface requirements）。
 * @param contentSuffix 用于隔离并发用例的内容后缀。
 */
export async function seedPublishedRuntimeRevision(
  tenantId: string,
  ownerId: string,
  runtimeKey: string,
  capabilities: string[],
  contentSuffix: string,
) {
  const runtime = await createRuntime({
    tenantId,
    runtimeKey,
    displayName: `Runtime ${runtimeKey}`,
    runtimeKind: "hosted",
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });

  const artifactContent = `runtime-content-${contentSuffix}`;
  const artifactDigest = computeArtifactDigest(artifactContent);

  const revision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "a2a",
    endpointRef: `https://runtime-${contentSuffix}.internal`,
    runtimeArtifactRef: `oci://registry/runtime@${artifactDigest}`,
    runtimeCapabilitiesJson: capabilities,
    identityMode: "managed",
    networkZone: "internal",
    configHash: `sha256:config_${contentSuffix}`,
    createdBy: ownerId,
  });

  const attestation = await createVerifiedAttestation(
    tenantId,
    "runtime_revision",
    revision.id,
    artifactContent,
  );
  await publishTrustedRuntimeRevisionForTest({
    tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: 1,
    attestationId: attestation.id,
  });

  const publishedRevision = await getRuntimeRevisionById(revision.id);
  if (!publishedRevision) throw new Error("测试 RuntimeRevision 发布后无法回读");
  return { runtime, revision: publishedRevision, attestation };
}
