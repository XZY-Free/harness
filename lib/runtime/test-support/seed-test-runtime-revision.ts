import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { eq } from "drizzle-orm";

/** 为测试 Session 补齐真实、同租户的 RuntimeRevision 外键目标。 */
export async function ensureTestRuntimeRevision(
  tenantId: string,
  runtimeRevisionId: string,
): Promise<void> {
  const [existing] = await db
    .select({ tenantId: runtimeRevisionTable.tenantId })
    .from(runtimeRevisionTable)
    .where(eq(runtimeRevisionTable.id, runtimeRevisionId))
    .limit(1);
  if (existing) {
    if (existing.tenantId !== tenantId) throw new Error("测试 RuntimeRevision 属于另一 Tenant");
    return;
  }
  const runtimeId = randomUUID();
  await db.insert(runtimeTable).values({
    id: runtimeId,
    tenantId,
    runtimeKey: `fixture-${runtimeRevisionId}`,
    displayName: "测试 Runtime",
    runtimeKind: "hosted",
    ownerUserId: "test-user",
    lifecycleState: "enabled",
  });
  await db.insert(runtimeRevisionTable).values({
    id: runtimeRevisionId,
    tenantId,
    runtimeId,
    revisionNo: 1,
    protocolType: "harness_runtime_protocol",
    protocolVersion: 3,
    protocolContractDigest: protocolDigest({ contract: "test" }),
    runtimeEvidenceKind: "hosted_artifact",
    runtimeTargetDigest: protocolDigest({ target: runtimeRevisionId }),
    endpointRef: "https://runtime.example.invalid",
    runtimeArtifactRef: "oci://registry.example.invalid/runtime:test",
    runtimeCapabilitiesJson: ["event_stream"],
    identityMode: "managed",
    networkZone: "internal",
    configHash: protocolDigest({ config: runtimeRevisionId }),
    createdBy: "test-service",
    revisionState: "published",
    publishedAt: new Date(),
  });
}
