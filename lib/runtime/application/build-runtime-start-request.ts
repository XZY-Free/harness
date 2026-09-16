/** Builds the one canonical Start/Resume request from frozen execution facts. */
import { issueContextHandle, resolveContextHandle } from "@/lib/context/context-handle";
import type {
  Invocation,
  ExecutionBinding as PersistedExecutionBinding,
} from "@/lib/persistence/schema/executions";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  type AuthorityIdentity,
  type CallbackEndpoints,
  type Credentials,
  type Recovery,
  type RuntimeStartRequest,
  RuntimeStartRequestSchema,
  computeSemanticRequestDigest,
  protocolDigest,
} from "@/lib/runtime/runtime-protocol";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";

export interface BuildRuntimeStartRequestInput {
  tenantId: string;
  invocation: Invocation;
  binding: PersistedExecutionBinding;
  authority: AuthorityIdentity;
  credentials: Credentials;
  runtimeEndpoint: string;
  callbackEndpoints: CallbackEndpoints;
  intentType?: "start" | "resume";
  recovery?: Recovery;
  activationEvidenceRef: string;
  attempt?: {
    producerSequenceStart?: number;
    checkpointId?: string;
    anchor?: string;
    anchorDigest?: string;
  };
  now?: Date;
}

export interface BuildRuntimeStartRequestResult {
  request: RuntimeStartRequest;
  serializedContext: string;
}

function inputDigest(value: unknown): string {
  return protocolDigest(value);
}

export async function buildRuntimeStartRequestForInvocation(
  input: BuildRuntimeStartRequestInput,
): Promise<BuildRuntimeStartRequestResult> {
  const { invocation, binding } = input;
  if (input.authority.invocationId !== invocation.id)
    throw new Error("Authority Invocation 不匹配");
  if (input.authority.runtimeRevisionId !== binding.runtimeRevisionId)
    throw new Error("RuntimeRevision 与 Binding 不匹配");
  const runtimeRevision = await getRuntimeRevisionById(binding.runtimeRevisionId);
  if (!runtimeRevision) throw new Error(`RuntimeRevision 不存在: ${binding.runtimeRevisionId}`);

  const serializedContext = await issueContextHandle({
    tenantId: input.tenantId,
    invocationId: invocation.id,
  });
  const context = await resolveContextHandle(serializedContext, {
    tenantId: input.tenantId,
    invocationId: invocation.id,
  });
  const inputs =
    invocation.subjectType === "thread"
      ? [
          {
            kind: "persistent_ref" as const,
            ref: invocation.triggerItemId ?? invocation.id,
            digest:
              context.subject.type === "thread"
                ? context.subject.triggerItemDigest
                : inputDigest({
                    invocationId: invocation.id,
                    triggerItemId: invocation.triggerItemId,
                  }),
          },
        ]
      : [
          {
            kind: "persistent_ref" as const,
            ref: `job:${invocation.jobId ?? invocation.id}`,
            digest:
              context.subject.type === "job"
                ? context.subject.inputHash
                : inputDigest({ invocationId: invocation.id, jobId: invocation.jobId }),
          },
        ];

  const capabilities = runtimeRevision.runtimeCapabilitiesJson as {
    limits?: {
      maxEventBytes?: number;
      maxBatchEvents?: number;
      maxBatchBytes?: number;
      executionTimeoutMs?: number;
    };
  } | null;
  const maxEventBytes = Math.min(capabilities?.limits?.maxEventBytes ?? 262_144, 262_144);
  const maxBatchEvents = Math.min(capabilities?.limits?.maxBatchEvents ?? 100, 100);
  const maxBatchBytes = Math.min(capabilities?.limits?.maxBatchBytes ?? 1_048_576, 1_048_576);
  const environment =
    binding.environmentMode === "MANAGED"
      ? (() => {
          if (!binding.environmentDefinitionRevisionId)
            throw new Error("MANAGED Binding 缺少 EnvironmentDefinitionRevision");
          const subject = context.common.environment;
          if (
            subject.mode !== "MANAGED" ||
            subject.revisionId !== binding.environmentDefinitionRevisionId
          )
            throw new Error("EnvironmentRevision 与 ContextHandle 不一致");
          return subject;
        })()
      : { mode: "NO_PLATFORM_ENVIRONMENT" as const };
  const workspaceBinding = await getWorkspaceBindingById(
    input.tenantId,
    binding.workspaceBindingId,
  );
  if (!workspaceBinding) throw new Error(`WorkspaceBinding 不存在: ${binding.workspaceBindingId}`);
  if (
    context.common.workspace.bindingId !== workspaceBinding.id ||
    context.common.workspace.contractDigest !== workspaceBinding.contractDigest
  ) {
    throw new Error("WorkspaceBinding 与 ContextHandle 不一致");
  }
  const workspace =
    workspaceBinding.continuityMode === "NO_PLATFORM_WORKSPACE"
      ? { mode: "NONE" as const }
      : {
          mode: "BOUND" as const,
          bindingId: workspaceBinding.id,
          contractDigest: workspaceBinding.contractDigest,
          continuityMode: workspaceBinding.continuityMode,
          activationEvidenceRef: input.activationEvidenceRef,
        };
  const executionBinding = {
    bindingDigest: context.common.bindingDigest,
    runtimeRevisionId: binding.runtimeRevisionId,
    policyRefs: [binding.policyRevisionId],
    governanceRefs: [binding.governanceConfigRevisionId],
    capabilityRefs: [binding.capabilityCatalogVersion].filter((value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    ),
    modelRefs: [],
    allowedEgress: [],
  };
  const recovery = input.recovery ?? { kind: "initial" as const };
  const authorityForRequest = input.authority;
  const requestWithoutDigest = {
    protocolVersion: 3 as const,
    authority: authorityForRequest,
    intentType: input.intentType ?? (recovery.kind === "resume" ? "resume" : "start"),
    semanticRequestDigest: `sha256:${"0".repeat(64)}`,
    executionBinding,
    context,
    inputs,
    environment,
    workspace,
    activationDigest: protocolDigest({
      invocationId: invocation.id,
      authority: authorityForRequest,
      activationEvidenceRef: input.activationEvidenceRef,
    }),
    recovery,
    producerSequenceStart: String(
      input.attempt?.producerSequenceStart ?? invocation.lastProducerSequence + 1,
    ),
    callbackEndpoints: input.callbackEndpoints,
    credentials: input.credentials,
    executionLimits: {
      maxEventBytes,
      maxBatchEvents,
      maxBatchBytes,
      dispatchDeadlineMs: 120_000,
      executionTimeoutMs: capabilities?.limits?.executionTimeoutMs ?? 600_000,
    },
  } satisfies RuntimeStartRequest;
  const request: RuntimeStartRequest = {
    ...requestWithoutDigest,
    semanticRequestDigest: computeSemanticRequestDigest(requestWithoutDigest),
  };
  RuntimeStartRequestSchema.parse(request);
  return { request, serializedContext };
}
