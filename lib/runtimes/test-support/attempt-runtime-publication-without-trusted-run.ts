import { randomUUID } from "node:crypto";
import type { RuntimeRevisionRow } from "@/lib/persistence/schema/control-plane";
import { publishRuntimeRevisionThroughControlPlane } from "@/lib/runtimes/application/publish-runtime-revision-service";

/**
 * 测试受信 Conformance Run 缺失时的 fail-closed 行为。
 *
 * @deprecated 新发布合同要求 attestationId + conformanceRunId 必填。
 * 此入口仅用于验证缺少必填证明时抛出正确错误类型。
 */
export async function publishRuntimeRevision(
  tenantId: string,
  revisionId: string,
  runtimeExpectedVersionNo: number,
  _conformanceResults: unknown[],
  _options?: {
    adapterDigest?: string | null;
    testEnvironment?: string | null;
    evidenceRef?: string | null;
  },
): Promise<RuntimeRevisionRow> {
  const result = await publishRuntimeRevisionThroughControlPlane({
    tenantId,
    revisionId,
    runtimeExpectedVersionNo,
    conformanceRunId: "test-missing-conformance-run-id",
    attestationId: "test-missing-attestation-id",
    actor: {
      tenantId,
      actorType: "system",
      actorId: "test-support",
    },
    requestId: `test-runtime-publish:${randomUUID()}`,
    idempotencyKey: `test-runtime-publish:${revisionId}`,
  });
  return result.revision as RuntimeRevisionRow;
}
