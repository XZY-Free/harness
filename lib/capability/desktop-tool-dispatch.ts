import { db } from "@/lib/db/client";
import { getBridgeServer } from "@/lib/desktop-bridge/bridge-server";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import {
  toolExecutionAttemptTable,
  toolExecutionBindingTable,
} from "@/lib/persistence/schema/tool-execution";
import { verifyCapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import { resolveToolExecutionTarget } from "@/lib/runtime/resolve-tool-execution-target";
import { recoverTrustedExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { and, eq, gt, isNull } from "drizzle-orm";
import { ProviderExecutionError } from "./provider-executor";
import { getToolCallById } from "./tool-call-queries";
import { parseToolExecutionContract } from "./tool-execution-contract";
import { getToolSchemaRevisionById } from "./tool-queries";

/** Gateway 只接受已领取的 ToolCall/Attempt 引用，命令和执行位置全部从事实源恢复。 */
export async function dispatchDesktopTool(input: {
  tenantId: string;
  invocationId: string;
  toolCallId: string;
  attemptId: string;
}) {
  const unavailable = () =>
    new ProviderExecutionError(
      "DESKTOP_EXECUTION_UNAVAILABLE",
      "桌面执行上下文不可用或已失效",
      "permanent",
      false,
    );
  const call = await getToolCallById({ tenantId: input.tenantId, toolCallId: input.toolCallId });
  if (
    !call ||
    call.invocationId !== input.invocationId ||
    call.callState !== "running" ||
    !call.threadId
  )
    throw unavailable();
  const binding = await getExecutionBindingByInvocation(input.tenantId, input.invocationId);
  if (!binding) throw unavailable();
  const catalog = verifyCapabilityCatalogSnapshot(
    binding.capabilityCatalogJson,
    binding.capabilityCatalogDigest,
  );
  const target = catalog.tools.find(
    (tool) => tool.toolId === call.toolId && tool.schemaRevisionId === call.toolSchemaRevisionId,
  )?.executionTarget;
  const subject = recoverTrustedExecutionSubject(binding, input.tenantId);
  if (
    catalog.invocationId !== input.invocationId ||
    target?.kind !== "desktop" ||
    target.threadId !== call.threadId ||
    target.workspaceBindingId !== binding.workspaceBindingId ||
    subject.subjectType !== "user" ||
    subject.subjectId !== target.ownerUserId
  )
    throw unavailable();
  const current = await resolveToolExecutionTarget({
    tenantId: input.tenantId,
    threadId: call.threadId,
    workspaceBindingId: target.workspaceBindingId,
    ownerUserId: target.ownerUserId,
  });
  if (
    current?.kind !== "desktop" ||
    current.deviceId !== target.deviceId ||
    current.bindingVersion !== target.bindingVersion
  )
    throw unavailable();
  const [toolBinding] = await db
    .select()
    .from(toolExecutionBindingTable)
    .where(
      and(
        eq(toolExecutionBindingTable.tenantId, input.tenantId),
        eq(toolExecutionBindingTable.toolCallId, call.id),
      ),
    )
    .limit(1);
  if (toolBinding?.providerType !== "builtin" || toolBinding.executorKind !== "builtin.shell")
    throw unavailable();
  const revision = await getToolSchemaRevisionById({
    tenantId: input.tenantId,
    schemaRevisionId: call.toolSchemaRevisionId,
  });
  if (!revision || revision.executionContractDigest !== toolBinding.executionContractDigest)
    throw unavailable();
  const contract = parseToolExecutionContract(revision.executionContractJson);
  const args = call.argumentsRedactedJson as Record<string, unknown>;
  if (contract.providerOperationMetadata.operation !== "shell" || typeof args.command !== "string")
    throw unavailable();
  const bridge = getBridgeServer();
  if (!bridge) throw unavailable();
  // 持久 CAS 防重放；发送后连接丢失视为结果未知，不能再次执行同一 Attempt。
  const reference = `desktop:${input.attemptId}`;
  const changed = await db
    .update(toolExecutionAttemptTable)
    .set({ providerRequestRef: reference })
    .where(
      and(
        eq(toolExecutionAttemptTable.id, input.attemptId),
        eq(toolExecutionAttemptTable.tenantId, input.tenantId),
        eq(toolExecutionAttemptTable.toolCallId, call.id),
        eq(toolExecutionAttemptTable.attemptState, "dispatched"),
        gt(toolExecutionAttemptTable.claimExpiresAt, new Date()),
        isNull(toolExecutionAttemptTable.providerRequestRef),
      ),
    );
  if (changed[0].affectedRows !== 1)
    throw new ProviderExecutionError(
      "DESKTOP_ATTEMPT_ALREADY_DISPATCHED",
      "桌面命令已发送或执行租约失效",
      "unknown_effect",
      true,
    );
  const result = await bridge.sendRpcToBoundThread({
    target: { tenantId: input.tenantId, deviceRecordId: target.deviceId },
    userId: target.ownerUserId,
    threadId: call.threadId,
    runId: call.invocationId,
    approvalId: call.id,
    command: "workspace.execute",
    payload: {
      threadId: call.threadId,
      bindingId: target.workspaceBindingId,
      command: args.command,
      timeoutMs: Math.min(contract.timeoutMs, 30000),
      logCapBytes: Math.min(Math.floor(contract.responseLimits.maxBytes / 4), 10000),
    },
  });
  if (!result.ok)
    throw new ProviderExecutionError(
      result.code ?? "DESKTOP_EXECUTION_FAILED",
      result.message ?? "桌面命令未取得结果",
      [
        "desktop_unavailable",
        "desktop_unauthorized",
        "desktop_target_mismatch",
        "workspace_unavailable",
        "workspace_execution_rejected",
      ].includes(result.code ?? "")
        ? "permanent"
        : "unknown_effect",
      true,
    );
  return { result: result.result, reference };
}
