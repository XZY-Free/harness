import type { ExecutionBinding, Invocation } from "@/lib/persistence/schema/executions";
import type { RuntimeRevisionRow } from "@/lib/persistence/schema/runtimes";
import type { HostedHarnessLoopResult } from "@/lib/runtime/adapters/hosted-adapter";
import {
  InvocationContinuationPermanentError,
  InvocationContinuationRetryableError,
} from "@/lib/runtime/continuation/invocation-continuation";
import {
  CapabilityCatalogIntegrityError,
  type CapabilityCatalogSnapshot,
  verifyCapabilityCatalogSnapshot,
} from "@/lib/runtime/harness-loop/capability-catalog";
import {
  type ExecutionSubject,
  recoverTrustedExecutionSubject,
} from "@/lib/runtime/transport/execution-subject";

export interface HarnessExecutionLease {
  id: string;
}

export interface ResumeHarnessInvocationDependencies {
  loadInvocation(tenantId: string, invocationId: string): Promise<Invocation | null>;
  loadBinding(tenantId: string, invocationId: string): Promise<ExecutionBinding | null>;
  loadRuntimeRevision(runtimeRevisionId: string): Promise<RuntimeRevisionRow | null>;
  acquireLease(params: {
    tenantId: string;
    invocationId: string;
    ownerRef: string;
  }): Promise<HarnessExecutionLease | null>;
  releaseLease(params: {
    invocationId: string;
    leaseId: string;
  }): Promise<void>;
  renewLease(params: { invocationId: string; leaseId: string }): Promise<boolean>;
  runHosted(params: {
    tenantId: string;
    invocation: Invocation;
    binding: ExecutionBinding;
    runtimeRevision: RuntimeRevisionRow;
    subject: ExecutionSubject;
    capabilityCatalog: CapabilityCatalogSnapshot;
  }): Promise<HostedHarnessLoopResult>;
  resumeExternal(params: {
    tenantId: string;
    invocation: Invocation;
    binding: ExecutionBinding;
    runtimeRevision: RuntimeRevisionRow;
    subject: ExecutionSubject;
    capabilityCatalog: CapabilityCatalogSnapshot;
    agentCallId: string;
    sourceVersion: number;
  }): Promise<{ resumed: boolean }>;
}

export type ResumeHarnessInvocationResult =
  | { status: "handled_noop"; invocationId: string }
  | {
      status: "resumed";
      invocationId: string;
      runtime: "hosted" | "external";
      completed?: boolean;
      pending?: boolean;
      waitingForUser?: boolean;
    };

/**
 * 父 Harness 恢复的唯一应用能力。它只恢复原 Invocation，并在执行前重证冻结
 * ExecutionBinding、trusted subject 与 Capability Catalog。
 */
export function createResumeHarnessInvocation(dependencies: ResumeHarnessInvocationDependencies) {
  return async (input: {
    tenantId: string;
    invocationId: string;
    agentCallId: string;
    sourceVersion: number;
  }): Promise<ResumeHarnessInvocationResult> => {
    const invocation = await dependencies.loadInvocation(input.tenantId, input.invocationId);
    if (!invocation) {
      throw new InvocationContinuationPermanentError(
        "PARENT_INVOCATION_MISSING",
        "父 Invocation 不存在或不属于当前租户",
      );
    }
    if (isTerminal(invocation.executionState)) {
      return { status: "handled_noop", invocationId: invocation.id };
    }
    if (invocation.executionState === "waiting_user") {
      throw new InvocationContinuationRetryableError(
        "PARENT_INVOCATION_WAITING_USER",
        "父 Invocation 仍在等待用户，暂不并发续跑",
      );
    }

    const binding = await dependencies.loadBinding(input.tenantId, invocation.id);
    if (!binding) {
      throw new InvocationContinuationPermanentError(
        "EXECUTION_BINDING_MISSING",
        "父 Invocation 的 ExecutionBinding 不存在",
      );
    }
    let subject: ExecutionSubject;
    let capabilityCatalog: CapabilityCatalogSnapshot;
    try {
      subject = recoverTrustedExecutionSubject(binding, input.tenantId);
      capabilityCatalog = verifyCapabilityCatalogSnapshot(
        binding.capabilityCatalogJson,
        binding.capabilityCatalogDigest,
      );
    } catch (error) {
      const code =
        error instanceof CapabilityCatalogIntegrityError
          ? "CAPABILITY_CATALOG_CORRUPTED"
          : "EXECUTION_SUBJECT_MISMATCH";
      throw new InvocationContinuationPermanentError(
        code,
        error instanceof Error ? error.message : "冻结执行身份无法恢复",
      );
    }
    if (capabilityCatalog.invocationId !== invocation.id) {
      throw new InvocationContinuationPermanentError(
        "CAPABILITY_CATALOG_CORRUPTED",
        "Capability Catalog 不属于父 Invocation",
      );
    }
    const runtimeRevision = await dependencies.loadRuntimeRevision(binding.runtimeRevisionId);
    if (!runtimeRevision) {
      throw new InvocationContinuationPermanentError(
        "RUNTIME_REVISION_MISSING",
        "Binding 冻结的 Runtime Revision 不存在",
      );
    }
    if (
      runtimeRevision.runtimeEvidenceKind !== binding.runtimeEvidenceKind ||
      runtimeRevision.runtimeTargetDigest !== binding.runtimeTargetDigest ||
      runtimeRevision.protocolType !== "harness_runtime_protocol"
    ) {
      throw new InvocationContinuationPermanentError(
        "RUNTIME_TARGET_MISMATCH",
        "Binding 冻结的 Runtime Target 与 Revision 不一致",
      );
    }

    const lease = await dependencies.acquireLease({
      tenantId: input.tenantId,
      invocationId: invocation.id,
      ownerRef: `continuation:${input.agentCallId}:${input.sourceVersion}`,
    });
    if (!lease) {
      throw new InvocationContinuationRetryableError(
        "INVOCATION_EXECUTION_LEASE_BUSY",
        "父 Invocation 当前由另一执行器持有",
      );
    }
    const renewTimer = setInterval(() => {
      void dependencies
        .renewLease({ invocationId: invocation.id, leaseId: lease.id })
        .catch(() => undefined);
    }, 30_000);
    try {
      if (binding.runtimeEvidenceKind === "external_endpoint") {
        const result = await dependencies.resumeExternal({
          tenantId: input.tenantId,
          invocation,
          binding,
          runtimeRevision,
          subject,
          capabilityCatalog,
          agentCallId: input.agentCallId,
          sourceVersion: input.sourceVersion,
        });
        if (!result.resumed) {
          throw new InvocationContinuationRetryableError(
            "EXTERNAL_RUNTIME_RESUME_REJECTED",
            "External Runtime 暂未接受恢复",
          );
        }
        return { status: "resumed", invocationId: invocation.id, runtime: "external" };
      }
      const result = await dependencies.runHosted({
        tenantId: input.tenantId,
        invocation,
        binding,
        runtimeRevision,
        subject,
        capabilityCatalog,
      });
      return {
        status: "resumed",
        invocationId: invocation.id,
        runtime: "hosted",
        completed: result.completed,
        pending: result.pending,
        waitingForUser: result.waitingForUser,
      };
    } finally {
      clearInterval(renewTimer);
      await dependencies.releaseLease({ invocationId: invocation.id, leaseId: lease.id });
    }
  };
}

function isTerminal(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "lost";
}
