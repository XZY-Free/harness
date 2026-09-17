import { createToolExecutionWorker } from "@/lib/capability/tool-execution-worker";
import { createOutboxRelayWorker } from "@/lib/control-plane/events/outbox-relay-worker";
import { createJobWorker } from "@/lib/job/job-worker";
import { createUserActionExpiryWorker } from "@/lib/permission/user-action-expiry-worker";
import { createBuildRouteEligibility } from "@/lib/routes/projection/build-route-eligibility";
import { mysqlRouteEligibilitySourceReader } from "@/lib/routes/projection/mysql-route-eligibility-source-reader";
import { mysqlRouteEligibilityStore } from "@/lib/routes/projection/mysql-route-eligibility-store";
import { createProjectionEventHandler } from "@/lib/routes/projection/projection-event-handlers";
import { createProductionInvocationContinuationWorker } from "@/lib/runtime/continuation/production-invocation-continuation-worker";
import { createHostedProvisioningWorker } from "@/lib/runtime/provisioning/hosted-provisioning-worker";
import { createRuntimeDispatchRetryWorker } from "@/lib/runtime/retry/runtime-dispatch-retry-worker";

export const CANONICAL_PRODUCTION_ROLES = [
  "web-api",
  "hosted-provisioning-worker",
  "control-plane-outbox-worker",
  "runtime-dispatch-retry-worker",
  "job-worker",
  "tool-execution-worker",
] as const;

export type ProductionRole = (typeof CANONICAL_PRODUCTION_ROLES)[number];
export type DurableWorkerRole = Exclude<ProductionRole, "web-api">;

export const DURABLE_WORKER_ROLES = CANONICAL_PRODUCTION_ROLES.filter(
  (role) => role !== "web-api",
) as DurableWorkerRole[];

export interface ProductionWorkerRole {
  role: DurableWorkerRole;
  pollOnce(): Promise<unknown>;
  stop(): void;
}

export function parseDurableWorkerRole(value: string | undefined): DurableWorkerRole {
  if (!value || !DURABLE_WORKER_ROLES.includes(value as DurableWorkerRole)) {
    throw new Error(`WORKER_ROLE 非法或缺失（允许值：${DURABLE_WORKER_ROLES.join(", ")}）`);
  }
  return value as DurableWorkerRole;
}

export function createProductionWorkerRole(role: DurableWorkerRole): ProductionWorkerRole {
  if (role === "hosted-provisioning-worker") {
    const worker = createHostedProvisioningWorker();
    return { role, pollOnce: () => worker.pollOnce(), stop: () => worker.stop() };
  }
  if (role === "runtime-dispatch-retry-worker") {
    const worker = createRuntimeDispatchRetryWorker();
    return { role, pollOnce: () => worker.tick(), stop: () => worker.stop() };
  }
  if (role === "job-worker") {
    const worker = createJobWorker();
    return { role, pollOnce: () => worker.pollOnce(), stop: () => worker.stop() };
  }
  if (role === "tool-execution-worker") {
    const worker = createToolExecutionWorker();
    return { role, pollOnce: () => worker.runOnce(), stop: () => undefined };
  }

  const buildRouteEligibility = createBuildRouteEligibility({ store: mysqlRouteEligibilityStore });
  const projectionWorker = createOutboxRelayWorker(
    createProjectionEventHandler({
      store: mysqlRouteEligibilityStore,
      sourceReader: mysqlRouteEligibilitySourceReader,
      buildRouteEligibility,
    }),
  );
  const continuationWorker = createProductionInvocationContinuationWorker();
  const userActionExpiryWorker = createUserActionExpiryWorker();
  return {
    role,
    pollOnce: () =>
      Promise.all([
        projectionWorker.pollOnce(),
        continuationWorker.pollOnce(),
        userActionExpiryWorker.pollOnce(),
      ]),
    stop() {
      projectionWorker.stop();
      continuationWorker.stop();
      userActionExpiryWorker.stop();
    },
  };
}

export const WORKER_REQUIRED_TABLES: Record<DurableWorkerRole, readonly string[]> = {
  "hosted-provisioning-worker": ["HostedProvisioningRequest"],
  "control-plane-outbox-worker": [
    "ControlPlaneOutboxEvent",
    "ControlPlaneEventDelivery",
    "UserActionRequest",
    "Thread",
    "ThreadItem",
    "ThreadEvent",
    "Turn",
    "Invocation",
  ],
  // R04 §5：本 Worker 承载四条 lane —— Session dispatch（RuntimeSessionBinding）、
  // InvocationCommand dispatch、Workspace Writer 物理释放（WorkspaceWriteLock +
  // WorkspaceBinding）、Owner 过期收口（Invocation + ExecutionOwnership + Thread/Turn/ThreadEvent）。
  // R05 §5 / R09 §2 步骤 8 追加第五条 lane：Checkpoint 维护（stuck gate 收口 +
  // 解冻两条腿续做），读写 Invocation/ExecutionOwnership/ExecutionBinding/WorkspaceBinding。
  // 启动就绪检查必须覆盖它真实读写的全部对象，否则缺表环境会"启动成功"却在首次 tick 才失败。
  "runtime-dispatch-retry-worker": [
    "Invocation",
    "InvocationAttempt",
    "InvocationCommand",
    "ExecutionOwnership",
    "ExecutionBinding",
    "RuntimeSessionBinding",
    "Thread",
    "Turn",
    "ThreadEvent",
    "WorkspaceWriteLock",
    "WorkspaceBinding",
  ],
  "job-worker": [
    "Job",
    "JobCommand",
    "JobEvent",
    "Invocation",
    "InvocationAttempt",
    "ExecutionBinding",
    "WorkspaceBinding",
    "DeploymentRoute",
    "DeploymentRouteSet",
    "RouteActivation",
    "RouteRevision",
    "Runtime",
    "RuntimeRevision",
    "PublicationRecord",
    "RuntimeConformanceRun",
    "RuntimeConformanceCaseResult",
    "PolicySet",
    "PolicyRevision",
    "GovernanceConfigSet",
    "GovernanceConfigRevision",
    "RouteEligibilityProjection",
  ],
  "tool-execution-worker": ["ToolCall", "ToolExecutionAttempt"],
};
