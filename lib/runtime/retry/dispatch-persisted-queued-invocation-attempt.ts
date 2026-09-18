/** Rebuilds transport from persisted RuntimeRevision and dispatches one Attempt. */
import { db } from "@/lib/db/client";
import { getAttemptById, updateAttemptState } from "@/lib/executions/persistence/attempt-store";
import { invocationTable } from "@/lib/persistence/schema/executions";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
import {
  dispatchQueuedInvocationAttempt,
  failAttemptAndInvokeRecoveryAuthority,
} from "@/lib/runtime/retry/dispatch-queued-invocation-attempt";
import type { SessionDispatchClaim } from "@/lib/runtime/retry/dispatch-retry-queries";
import {
  requireExecutionBinding,
  resolveBoundExecutionResources,
  resolveRuntimeTransportFromBinding,
} from "@/lib/runtime/retry/runtime-transport-from-binding";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import type { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import { and, eq } from "drizzle-orm";

export interface PersistedAttemptDispatcherDependencies {
  hostedApplicationService?: HostedRuntimeApplicationService;
  createExternalTransport?: typeof createHttpHarnessRuntimeTransport;
}

export function createPersistedQueuedInvocationAttemptDispatcher(
  dependencies: PersistedAttemptDispatcherDependencies = {},
) {
  return async function dispatchPersistedQueuedInvocationAttempt(claim: SessionDispatchClaim) {
    const attempt = await getAttemptById(claim.attemptId);
    if (!attempt || attempt.attemptState !== "queued") return;
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, claim.tenantId),
          eq(invocationTable.id, claim.invocationId),
        ),
      )
      .limit(1);
    if (!invocation) {
      await db.transaction((tx) =>
        updateAttemptState(tx, attempt.id, "failed", {
          errorCode: "InvocationNotFound",
          errorSummary: "Attempt 关联 Invocation 不存在",
        }),
      );
      return;
    }
    if (["completed", "failed", "cancelled", "lost"].includes(invocation.executionState)) {
      await db.transaction((tx) =>
        updateAttemptState(tx, attempt.id, "failed", {
          errorCode: "InvocationAlreadyTerminal",
          errorSummary: `Parent Invocation 已终态（${invocation.executionState}）`,
        }),
      );
      return;
    }
    let transport: Awaited<ReturnType<typeof resolveRuntimeTransportFromBinding>>;
    let resources: Awaited<ReturnType<typeof resolveBoundExecutionResources>>;
    try {
      const binding = await requireExecutionBinding(invocation.tenantId, invocation.id);
      transport = await resolveRuntimeTransportFromBinding({
        tenantId: invocation.tenantId,
        binding,
        ...dependencies,
      });
      // R01 §5：Transport 只是执行资源的一项。受管 Environment Provisioner 与 Workspace
      // 执行资源同样只能来自**同一份冻结 Binding**；不解析它们，MANAGED 的重投就会在
      // 「没有 Provisioner」上直接终态失败 —— 那等于同一份持久意图在请求内联路径可执行、
      // 在后台恢复路径不可恢复。
      resources = await resolveBoundExecutionResources({
        tenantId: invocation.tenantId,
        binding,
        purpose: "recovery",
      });
    } catch (error) {
      await failAttemptAndInvokeRecoveryAuthority({
        tenantId: invocation.tenantId,
        attempt,
        invocation,
        errorCode: error instanceof Error ? error.name : "RuntimeTransportMismatch",
        errorSummary: error instanceof Error ? error.message : String(error),
        now: new Date(),
        claim,
      });
      return;
    }
    const runtimeClient: RuntimeHttpClient = transport.runtimeClient;
    try {
      return await dispatchQueuedInvocationAttempt({
        tenantId: invocation.tenantId,
        attemptId: attempt.id,
        claim,
        runtimeClient,
        runtimeEndpointResolver: async (frozenBinding) => ({
          runtimeEndpoint: transport.runtimeEndpoint,
          auth: transport.auth,
          callbackEndpoints: buildGatewayEndpoints({
            external: !transport.hosted,
            invocationId: frozenBinding.invocationId,
          }),
          ...resources,
        }),
      });
    } catch (error) {
      const current = await getAttemptById(attempt.id);
      if (current?.attemptState === "queued") {
        await failAttemptAndInvokeRecoveryAuthority({
          tenantId: invocation.tenantId,
          attempt: current,
          invocation,
          errorCode: error instanceof Error ? error.name : "RuntimeDispatchFailed",
          errorSummary: error instanceof Error ? error.message : String(error),
          now: new Date(),
          claim,
        });
      }
    }
  };
}

export const dispatchPersistedQueuedInvocationAttempt =
  createPersistedQueuedInvocationAttemptDispatcher();
