import { runtimeConformanceConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import { createDSSEConformanceVerifier } from "@/lib/runtime/conformance/runtime-conformance-verifier";
import { RunnerSigningIdentityRegistry } from "@/lib/runtime/domain/runner-signing-identity";
import { mysqlRuntimeConformanceRunStore } from "@/lib/runtime/persistence/mysql-runtime-conformance-run-store";
import {
  runtimeConformanceCaseResult,
  runtimeConformanceRun,
} from "@/lib/runtime/persistence/runtime-conformance-run-record";
import { createRecordRuntimeConformanceRun } from "@/lib/runtime/provisioning/record-runtime-conformance-run";
import { and, desc, eq } from "drizzle-orm";

/** 从唯一的正式配置构建 RunnerSigningIdentityRegistry。 */
function buildRegistry(): RunnerSigningIdentityRegistry {
  return new RunnerSigningIdentityRegistry(runtimeConformanceConfig.runnerSigningIdentities);
}

type RecordRuntimeConformanceRunCommand = Parameters<
  ReturnType<typeof createRecordRuntimeConformanceRun>
>[0];

/**
 * 每次录入时从正式配置构建 verifier，避免模块加载阶段冻结尚未加载的环境配置。
 * instrumentation 会先加载环境文件再接收请求；缺失或非法配置仍构建空注册表并拒绝验签。
 */
export function recordRuntimeConformanceRun(command: RecordRuntimeConformanceRunCommand) {
  return createRecordRuntimeConformanceRun({
    store: mysqlRuntimeConformanceRunStore,
    verifier: createDSSEConformanceVerifier({ runnerIdentityRegistry: buildRegistry() }),
  })(command);
}

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

export async function getRuntimeConformanceRunById(tenantId: string, runId: string) {
  const [run] = await db
    .select()
    .from(runtimeConformanceRun)
    .where(and(eq(runtimeConformanceRun.tenantId, tenantId), eq(runtimeConformanceRun.id, runId)))
    .limit(1);
  return run ?? null;
}

export async function listRuntimeConformanceCaseResults(runId: string) {
  return db
    .select()
    .from(runtimeConformanceCaseResult)
    .where(eq(runtimeConformanceCaseResult.runId, runId));
}
