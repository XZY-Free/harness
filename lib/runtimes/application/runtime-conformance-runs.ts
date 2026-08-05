import { runtimeConformanceConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import { createRecordRuntimeConformanceRun } from "@/lib/runtimes/application/record-runtime-conformance-run";
import { mysqlRuntimeConformanceRunStore } from "@/lib/runtimes/persistence/mysql-runtime-conformance-run-store";
import { createLegacyHMACConformanceVerifier } from "@/lib/runtimes/verification/runtime-conformance-verifier";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import { and, desc, eq } from "drizzle-orm";

const record = createRecordRuntimeConformanceRun({
  store: mysqlRuntimeConformanceRunStore,
  verifier: createLegacyHMACConformanceVerifier({ allowNewHmacReports: true }),
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
