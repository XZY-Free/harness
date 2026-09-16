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
import { getActiveLocksByInvocation } from "@/lib/workspace/workspace-write-lock-queries";
import { and, eq } from "drizzle-orm";

/** Parent Invocation guard used by both Runtime ingress and Runtime-originated Actions. */
export async function requireCurrentExecutionAuthority(input: {
  tenantId: string;
  authority: AuthorityIdentity;
  executor?: DbOrTx;
  requiredPhase?: "activating" | "dispatching" | "executing" | "suspending";
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
  if (invocation.checkpointGate !== "open") {
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
  if (workspace.continuityMode !== "NO_PLATFORM_WORKSPACE") {
    if (owner.workspaceWriterGeneration === null || !workspace.storageScopeDigest) {
      throw new Error("WorkspaceWriterNotFenced");
    }
    const locks = await getActiveLocksByInvocation(input.tenantId, invocation.id, executor);
    const writer = locks.find(
      (lock) =>
        lock.storageScopeDigest === workspace.storageScopeDigest &&
        lock.workspaceBindingId === workspace.id &&
        lock.holderAttemptId === owner.attemptId &&
        lock.holderOwnershipId === owner.id &&
        lock.writerGeneration === owner.workspaceWriterGeneration,
    );
    if (!writer) throw new Error("WorkspaceWriterNotFenced");
  }
  return owner;
}
