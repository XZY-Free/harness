/**
 * Job admission lane（R01 §3 第 2 行、R01 §4）。
 *
 * 事实源：
 * - docs/topic02/nexharness-topic02-closure/repairs/01-production.md §2/§3/§4
 *
 * 规则：
 * - `Job queued 无 Invocation` 是**已持久**的可发现状态：初始 API 进程可能在任意提交点
 *   死亡，因此后续工作不能只能依赖那条 HTTP 栈继续运行。
 * - 幂等：Job 根锁下建立唯一 Invocation/Binding；重复调度返回已冻结关联，绝不新建第二条。
 * - 不追随 current：已存在 Invocation 时**不再重新解析** Route/Runtime/Environment。
 * - 解析失败写明确的可重试事实（Job 保持 queued，仍在扫描窗口内），不静默吞掉。
 * - 解析在事务外进行，提交时由唯一 Binding Authority 在同租户/Revision/Publication/
 *   Route/Policy/Projection 全部复验（R01 §2）。
 */
import { aiConfig } from "@/lib/config";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { recordEnvironmentSelectionFirstApplied } from "@/lib/environment/environment-selection";
import { resolveBindingGovernance } from "@/lib/executions/application/resolve-binding-governance";
import {
  type JobBindingCommandFields,
  type JobCapabilityCatalogBuilder,
  createJobInvocation,
} from "@/lib/job/job-execution";
import type { Thread } from "@/lib/persistence/schema/conversation";
import type { EnvironmentChangeRequest } from "@/lib/persistence/schema/environment";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { type Job, jobTable } from "@/lib/persistence/schema/job";
import { canonicalRouteResolver } from "@/lib/runtime/application/execution-resources";
import {
  resolveEnvironmentRevisionForInvocation,
  resolveThreadWorkspaceFacts,
} from "@/lib/runtime/application/thread-execution-context";
import { buildProductionCapabilityCatalogForJob } from "@/lib/runtime/harness-loop/build-production-capability-catalog";
import {
  type ModelInfo,
  extractModelInfo,
  resolveExecutionPlan,
} from "@/lib/runtime/resolve-execution-plan";
import {
  type ExecutionSubject,
  freezeTrustedExecutionSubject,
} from "@/lib/runtime/transport/execution-subject";
import { createNoPlatformWorkspaceBinding } from "@/lib/workspace/workspace-binding-store";
import { and, asc, eq, notExists, sql } from "drizzle-orm";

export type JobAdmissionSkipReason =
  | "not_queued"
  | "already_admitted"
  | "no_effective_route"
  | "route_configuration_invalid";

export type JobAdmissionOutcome =
  | { outcome: "admitted"; jobId: string; invocationId: string; created: boolean }
  | { outcome: "skipped"; jobId: string; reason: JobAdmissionSkipReason };

/** 候选扫描：只取 ID，领取/建立时在自己的事务里按对象所属根重验状态。 */
export async function scanQueuedJobsWithoutInvocation(input: {
  limit: number;
}): Promise<Array<{ tenantId: string; jobId: string }>> {
  return db
    .select({ tenantId: jobTable.tenantId, jobId: jobTable.id })
    .from(jobTable)
    .where(
      and(
        eq(jobTable.jobState, "queued"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(invocationTable)
            .where(
              and(
                eq(invocationTable.tenantId, jobTable.tenantId),
                eq(invocationTable.jobId, jobTable.id),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(jobTable.createdAt))
    .limit(input.limit);
}

/**
 * Job 的可信执行主体。
 *
 * - 关联 Thread 的 Job：主体是该 Thread 的稳定 owner（与员工端 Turn 同一个主体语义）。
 * - 无 Thread 的 Job：主体是 `Job.createdBy` 记录的**可信 service**；无 Agent 不等于无权限，
 *   service Principal 与正式输入仍是必需事实。
 */
export function resolveJobExecutionSubject(
  tenantId: string,
  job: Job,
  threadOwnerUserId: string | null,
): ExecutionSubject {
  if (threadOwnerUserId) {
    return { tenantId, subjectType: "user", subjectId: threadOwnerUserId };
  }
  return { tenantId, subjectType: "service", subjectId: job.createdBy };
}

/** 单 Job 接纳：幂等建立唯一 Invocation/Binding。 */
export async function admitQueuedJob(input: {
  tenantId: string;
  jobId: string;
  /**
   * 领域显式选择的初始压缩材料引用（T33；null = 本次不选择）。
   *
   * 与 Thread 路径同义：只给引用，存在性/tenant/用途/摘要/来源/有效期/访问权限由
   * Binding Authority 在事务内核验后冻结。
   */
  initialContextCheckpointId?: string | null;
}): Promise<JobAdmissionOutcome> {
  const [job] = await db
    .select()
    .from(jobTable)
    .where(and(eq(jobTable.tenantId, input.tenantId), eq(jobTable.id, input.jobId)))
    .limit(1);
  if (!job) throw new Error(`Job 不存在或租户不匹配：${input.jobId}`);
  if (job.jobState !== "queued") {
    return { outcome: "skipped", jobId: job.id, reason: "not_queued" };
  }
  const [existing] = await db
    .select({ id: invocationTable.id })
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, input.tenantId), eq(invocationTable.jobId, job.id)))
    .limit(1);
  if (existing) {
    // 已冻结：不再重新解析 Route/Runtime/Environment（R01 §2）。
    return { outcome: "admitted", jobId: job.id, invocationId: existing.id, created: false };
  }

  const thread = job.threadId ? await getThreadById(input.tenantId, job.threadId) : null;
  if (job.threadId && !thread) {
    throw new Error(`Job 关联的 Thread 不存在：${job.threadId}`);
  }
  const resolved = await resolveJobBindingCommand({
    tenantId: input.tenantId,
    job,
    thread,
    initialContextCheckpointId: input.initialContextCheckpointId ?? null,
  });
  if (!resolved.resolved) {
    return { outcome: "skipped", jobId: job.id, reason: resolved.reason };
  }
  const admitted = await createJobInvocation({
    tenantId: input.tenantId,
    jobId: job.id,
    binding: resolved.binding,
    capabilityCatalog: resolved.capabilityCatalog,
  });
  if (resolved.selection) {
    await recordEnvironmentSelectionFirstApplied({
      tenantId: input.tenantId,
      selectionId: resolved.selection.id,
      invocationId: admitted.invocation.id,
    });
  }
  return {
    outcome: "admitted",
    jobId: job.id,
    invocationId: admitted.invocation.id,
    created: admitted.created,
  };
}

export type ResolvedJobBindingCommand =
  | {
      resolved: true;
      binding: JobBindingCommandFields;
      capabilityCatalog: JobCapabilityCatalogBuilder;
      selection: EnvironmentChangeRequest | null;
    }
  | {
      resolved: false;
      reason: Extract<JobAdmissionSkipReason, "no_effective_route"> | "route_configuration_invalid";
    };

/**
 * 解析 Job 的冻结 Binding 输入（R01 §2「解析外部资料可在事务外」）。
 *
 * 与 `admitQueuedJob` 分离，使「解析」与「提交」边界显式：解析可以在事务外跑，提交时由
 * Binding Authority 对 Route/Revision/Publication/Policy/Projection 全部复验。需要自己
 * 掌握提交时机的调用方（例如断言"同 Job 换冻结语义必须冲突"）可以直接用本函数拿到输入，
 * 再调用 `createJobInvocation`；绝不允许自行拼装台账行。
 */
export async function resolveJobBindingCommand(input: {
  tenantId: string;
  job: Job;
  thread: Thread | null;
  initialContextCheckpointId?: string | null;
}): Promise<ResolvedJobBindingCommand> {
  const { tenantId, job, thread } = input;
  const plan = await resolveExecutionPlan(
    {
      tenantId,
      routeScopeKey: "default",
      businessKey: { jobId: job.id },
      attributes: {},
      threadDefaultModelRef: thread?.defaultModelRef ?? null,
      platformDefaultModelRef: aiConfig.chatModel,
    },
    canonicalRouteResolver,
  );
  if (!plan.resolved) {
    return {
      resolved: false,
      reason:
        plan.reason === "no_effective_route" ? "no_effective_route" : "route_configuration_invalid",
    };
  }
  const projectionVersionNo = plan.routeResolution.projectionVersionNo;
  if (!Number.isInteger(projectionVersionNo) || projectionVersionNo < 0) {
    throw new Error("RouteResolution 缺少有效 projectionVersionNo");
  }

  const executionSubject = resolveJobExecutionSubject(
    tenantId,
    job,
    thread ? thread.ownerUserId : null,
  );
  const frozenPrincipal = freezeTrustedExecutionSubject(executionSubject, tenantId);
  const workspaceFacts = thread
    ? await resolveThreadWorkspaceFacts(tenantId, thread)
    : { workspaceBindingId: null, workspaceUnavailable: false };
  const environment = thread
    ? await resolveEnvironmentRevisionForInvocation(
        tenantId,
        thread.id,
        thread.defaultEnvironmentDefinitionId,
      )
    : { revision: null, selection: null };
  const workspaceBindingId =
    environment.revision && workspaceFacts.workspaceBindingId
      ? workspaceFacts.workspaceBindingId
      : (await createNoPlatformWorkspaceBinding(tenantId, frozenPrincipal.principalId)).id;
  const governance = await resolveBindingGovernance(
    db,
    tenantId,
    plan.routeResolution.policyRevisionId,
  );
  const { kind: _kind, ...runtimeEvidence } = plan.routeResolution.controlPlaneEvidence;
  const modelInfo: ModelInfo = extractModelInfo(
    null,
    thread?.defaultModelRef ?? null,
    aiConfig.chatModel,
  );

  return {
    resolved: true,
    selection: environment.selection,
    binding: {
      runtimeRevisionId: plan.runtimeRevisionId,
      deploymentRouteId: plan.routeResolution.deploymentRouteId,
      modelProvider: modelInfo.modelProvider,
      modelId: modelInfo.modelId,
      modelRevisionRef: modelInfo.modelRevisionRef,
      workspaceBindingId,
      policyRevisionId: governance.policyRevisionId,
      policyRulesDigest: governance.policyRulesDigest,
      governanceConfigRevisionId: governance.governanceConfigRevisionId,
      governanceConfigDigest: governance.governanceConfigDigest,
      environmentDefinitionRevisionId: environment.revision?.id ?? null,
      environmentMode: environment.revision ? "MANAGED" : "NO_PLATFORM_ENVIRONMENT",
      initialContextCheckpointId: input.initialContextCheckpointId ?? null,
      ...frozenPrincipal,
      projectionVersionNo,
      controlPlaneEvidence: {
        routeRevisionId: plan.routeResolution.routeRevisionId,
        routeActivationId: plan.routeResolution.routeActivationId,
        routeContentDigest: plan.routeResolution.routeContentDigest,
        resolutionInputDigest: plan.routeResolution.resolutionInputDigest,
        ...runtimeEvidence,
      },
    },
    // 冻结能力目录（R01 §5）：Job 也必须拿到真实目录，不能退化成空合同。
    // snapshot.invocationId 必须是真实 Invocation，故由创建方回调取得。
    capabilityCatalog: async (invocationId) => {
      const catalog = await buildProductionCapabilityCatalogForJob({
        tenantId,
        invocationId,
        jobId: job.id,
        threadId: thread?.id ?? null,
        workspaceBindingId: workspaceFacts.workspaceBindingId,
        workspaceUnavailable: workspaceFacts.workspaceUnavailable,
        preferredAgentId: job.agentId ?? null,
        runtimeRevisionId: plan.runtimeRevisionId,
        policyRevisionId: governance.policyRevisionId,
        policyRulesDigest: governance.policyRulesDigest,
        executionSubject,
        resolveRoute: canonicalRouteResolver,
        routeScopeKey: "default",
      });
      return {
        capabilityCatalogJson: catalog.snapshot,
        capabilityCatalogDigest: catalog.digest,
        capabilityCatalogVersion: catalog.version,
        capabilityCatalogSourceRefs: catalog.sourceRefs,
        capabilityCatalogCreatedAt: catalog.createdAt,
      };
    },
  };
}
