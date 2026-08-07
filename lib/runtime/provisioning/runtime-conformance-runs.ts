import { runtimeConformanceConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import { createRecordRuntimeConformanceRun } from "@/lib/runtime/provisioning/record-runtime-conformance-run";
import { mysqlRuntimeConformanceRunStore } from "@/lib/runtime/persistence/mysql-runtime-conformance-run-store";
import {
 runtimeConformanceCaseResult,
 runtimeConformanceRun,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import { createDSSEConformanceVerifier } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import {
 RunnerSigningIdentityRegistry,
 createRegistryFromLegacyConfig,
} from "@/lib/runtime/domain/runner-signing-identity";
import { and, desc, eq } from "drizzle-orm";

/**
 * 从配置构建 RunnerSigningIdentityRegistry。
 * 优先使用精确绑定，否则从旧配置推导。
 */
function buildRegistry(): RunnerSigningIdentityRegistry {
 const identities = runtimeConformanceConfig.runnerSigningIdentities;
 if (identities) {
  return new RunnerSigningIdentityRegistry(identities);
 }
 return createRegistryFromLegacyConfig({
  trustedRunnerKeys: runtimeConformanceConfig.trustedRunnerKeys,
  allowedRunnerIdentities: runtimeConformanceConfig.allowedRunnerIdentities,
 });
}

const record = createRecordRuntimeConformanceRun({
 store: mysqlRuntimeConformanceRunStore,
 verifier: createDSSEConformanceVerifier({ runnerIdentityRegistry: buildRegistry() }),
});

export const recordRuntimeConformanceRun = record;

export async function listRuntimeConformanceRuns(tenantId: string, runtimeRevisionId: string) {
 return db
 .select()
 .from(runtimeConformanceRun)
 .where(
 and(
 eq(runtimeConformanceRun.tenantId, tenantId),
 eq(runtimeConformanceRun.runtimeRevisionId, runtimeRevisionId),
 ),
 )
 .orderBy(desc(runtimeConformanceRun.completedAt));
}

export async function listRuntimeConformanceCaseResults(runId: string) {
 return db
 .select()
 .from(runtimeConformanceCaseResult)
 .where(eq(runtimeConformanceCaseResult.runId, runId));
}
