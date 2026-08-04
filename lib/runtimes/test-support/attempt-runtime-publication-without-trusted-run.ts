import { randomUUID } from "node:crypto";
import type { RuntimeRevisionRow } from "@/lib/persistence/schema/control-plane";
import { publishRuntimeRevisionThroughControlPlane } from "@/lib/runtimes/application/publish-runtime-revision-service";
import type { ConformanceCaseResult } from "@/lib/runtimes/domain/runtime-revision-publication-policy";

/** 测试受信 Conformance Run 缺失时的 fail-closed 行为。 */
export async function publishRuntimeRevision(
  tenantId: string,
  revisionId: string,
  runtimeExpectedVersionNo: number,
  _conformanceResults: ConformanceCaseResult[],
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
