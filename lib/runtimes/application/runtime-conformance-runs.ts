import { runtimeConformanceConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import { createRecordRuntimeConformanceRun } from "@/lib/runtimes/application/record-runtime-conformance-run";
import { mysqlRuntimeConformanceRunStore } from "@/lib/runtimes/persistence/mysql-runtime-conformance-run-store";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtimes/persistence/runtime-conformance-run-record";
import { createDSSEConformanceVerifier } from "@/lib/runtimes/verification/runtime-conformance-verifier";
import { and, desc, eq } from "drizzle-orm";

/** §4.8: 从 DB 读取已存储的 DSSE Envelope（runnerSignature 字段）。 */
async function readConformanceEnvelopeFromDb(runId: string): Promise<Buffer> {
  const [run] = await db
    .select({ runnerSignature: runtimeConformanceRun.runnerSignature })
    .from(runtimeConformanceRun)
    .where(eq(runtimeConformanceRun.id, runId))
    .limit(1);
  if (!run) throw new Error(`ConformanceRun 不存在: ${runId}`);
  return Buffer.from(run.runnerSignature, "utf-8");
}

const record = createRecordRuntimeConformanceRun({
  store: mysqlRuntimeConformanceRunStore,
  verifier: createDSSEConformanceVerifier({
    allowedRunnerIdentities: runtimeConformanceConfig.allowedRunnerIdentities ?? [],
    readConformanceEnvelope: readConformanceEnvelopeFromDb,
  }),
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
