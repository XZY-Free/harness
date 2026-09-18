import type { DbOrTx } from "@/lib/db/client";
import { ExecutionAuthorityError } from "@/lib/executions/domain/execution-authority";
import { requireCurrentExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { environmentLeaseTable } from "@/lib/persistence/schema/environment";
import {
  executionBindingTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { workspaceBinding } from "@/lib/persistence/schema/workspace";
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";
import { isWorkspaceWriterFenced } from "@/lib/workspace/workspace-writer-fence";
import { and, eq } from "drizzle-orm";

/**
 * 接纳请求的操作类别。Checkpoint Gate 只约束"新决策来源"的操作；
 * 已接纳行动的完成/失败、终态收口、控制命令与展示性进度必须能在
 * quiescing/frozen 下继续落库，否则安全点会吞掉真实执行事实。
 */
export type ExecutionOperationKind =
  | "new_action"
  | "accepted_action_completion"
  | "terminal"
  | "control"
  | "progress";

/** 只有新决策/新行动来源要求 Checkpoint Gate 处于 open。 */
const GATE_OPEN_REQUIRED: readonly ExecutionOperationKind[] = ["new_action"];

/** Parent Invocation guard used by both Runtime ingress and Runtime-originated Actions. */
export async function requireCurrentExecutionAuthority(input: {
  tenantId: string;
  authority: AuthorityIdentity;
  executor?: DbOrTx;
  requiredPhase?: "activating" | "dispatching" | "executing" | "suspending";
  /** 操作类别；由服务端入口按事件 Schema 决定，不接受调用方任意字符串提权。 */
  operationKind: ExecutionOperationKind;
}) {
  const executor = input.executor;
  if (!executor) {
    throw new Error("Current Execution Authority Guard 必须在同一事务中执行");
  }
  const owner = await requireCurrentExecutionOwnership({
    tenantId: input.tenantId,
    authority: {
      invocationId: input.authority.invocationId,
      attemptId: input.authority.attemptId,
      ownershipId: input.authority.ownershipId,
      leaseEpoch: Number(input.authority.leaseEpoch),
    },
    executor,
    requiredPhase: input.requiredPhase,
  });
  const [invocation] = await executor
    .select()
    .from(invocationTable)
    .where(
      and(
        eq(invocationTable.tenantId, input.tenantId),
        eq(invocationTable.id, input.authority.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const [session] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, input.tenantId),
        eq(runtimeSessionBindingTable.id, input.authority.sessionBindingId),
        eq(runtimeSessionBindingTable.invocationId, input.authority.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const [binding] = await executor
    .select()
    .from(executionBindingTable)
    .where(
      and(
        eq(executionBindingTable.tenantId, input.tenantId),
        eq(executionBindingTable.invocationId, input.authority.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !invocation ||
    ["completed", "failed", "cancelled", "lost"].includes(invocation.executionState) ||
    !session ||
    !binding ||
    session.ownershipId !== owner.id ||
    session.attemptId !== owner.attemptId ||
    session.leaseEpoch !== owner.leaseEpoch ||
    session.runtimeRevisionId !== input.authority.runtimeRevisionId ||
    binding.runtimeRevisionId !== input.authority.runtimeRevisionId ||
    ["closed", "lost"].includes(session.bindingState) ||
    (input.requiredPhase === "executing" && session.bindingState !== "active")
  ) {
    throw new Error("NotCurrentExecutor");
  }
  if (GATE_OPEN_REQUIRED.includes(input.operationKind) && invocation.checkpointGate !== "open") {
    throw new ExecutionAuthorityError(
      "CheckpointStale",
      "Checkpoint Gate 未解除，禁止接纳新的 Runtime Action",
    );
  }
  if (binding.environmentMode === "MANAGED") {
    if (!binding.environmentDefinitionRevisionId || !owner.environmentLeaseId) {
      throw new Error("EnvironmentRevisionMismatch");
    }
    const [lease] = await executor
      .select()
      .from(environmentLeaseTable)
      .where(
        and(
          eq(environmentLeaseTable.tenantId, input.tenantId),
          eq(environmentLeaseTable.id, owner.environmentLeaseId),
          eq(environmentLeaseTable.invocationId, invocation.id),
          eq(environmentLeaseTable.attemptId, owner.attemptId),
          eq(
            environmentLeaseTable.environmentDefinitionRevisionId,
            binding.environmentDefinitionRevisionId,
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !lease ||
      lease.leaseState !== "active" ||
      lease.readinessState !== "ready" ||
      lease.activationOwnershipId !== owner.id
    ) {
      throw new Error("EnvironmentComplianceFailed");
    }
  }
  const [workspace] = await executor
    .select()
    .from(workspaceBinding)
    .where(
      and(
        eq(workspaceBinding.tenantId, input.tenantId),
        eq(workspaceBinding.id, binding.workspaceBindingId),
      ),
    )
    .for("update")
    .limit(1);
  if (!workspace) throw new Error("WorkspaceNotReady");
  // Workspace Writer 围栏只适用于「服务端持有 Writer」的连续性模式（R08 §1/§4）：
  // `SHARED_DURABLE` / `CHECKPOINT_RESTORABLE` 的写入必须被当前代际的 W 行真正围栏住。
  // `HOST_AFFINE`（桌面个人目录）的写由绑定设备本机执行，服务端**不是**该目录的 Writer，
  // 因此 `workspaceWriterGeneration` 正确地恒为 null —— 对它要求服务端 W 行会把每一个
  // Runtime 事件都判成 `WorkspaceWriterNotFenced`，使"真实 Workspace 的默认入口"整体不可用
  // （R01 失败链）。判定与 Ingress 共用同一份实现。
  const fenced = await isWorkspaceWriterFenced({
    tenantId: input.tenantId,
    invocationId: invocation.id,
    workspaceBinding: workspace,
    holder: {
      attemptId: owner.attemptId,
      ownershipId: owner.id,
      writerGeneration: owner.workspaceWriterGeneration,
    },
    executor,
  });
  if (!fenced) throw new Error("WorkspaceWriterNotFenced");
  return owner;
}
