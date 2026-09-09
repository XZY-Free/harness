import { cancelAgentCall } from "@/lib/agents/calls/application/cancel-agent-call";
import { createCreateAgentCall } from "@/lib/agents/calls/application/create-agent-call";
import { projectAgentHostActions } from "@/lib/agents/calls/application/project-host-actions";
import {
  AgentActionUnavailableError,
  resolveAgentActionBinding,
} from "@/lib/agents/calls/application/resolve-agent-call-binding";
import {
  AgentCallStartCancelledError,
  startAgentCall,
} from "@/lib/agents/calls/application/start-agent-call";
import { toAgentCallDisposition } from "@/lib/agents/calls/domain/agent-call";
import { buildAgentCallLogicalKey } from "@/lib/agents/calls/domain/agent-call";
import type { AgentCallTransportChannel } from "@/lib/agents/calls/domain/agent-call-attempt";
import {
  AgentCallIdempotencyConflictError,
  mysqlAgentCallStore,
} from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import type { HostAction } from "@/lib/agents/calls/transport/a2a/host-control-contract";
import {
  RequiredContextDeniedError,
  RequiredContextUnavailableError,
} from "@/lib/context/enrichment/build-invocation-context-bundle";
import {
  AgentAttachmentAccessError,
  createAgentAttachmentReferences,
} from "@/lib/files/agent-attachment-access";
import {
  EnterpriseUserContextRequirementError,
  loadEnterpriseUserAccessPolicy,
} from "@/lib/identity/enterprise-user-access-policy";
import { getIdentityExtensions } from "@/lib/identity/identity-extension-bootstrap";
import { prepareEnterpriseUserContext } from "@/lib/identity/prepare-enterprise-user-context";
import { OutboundCredentialError } from "@/lib/identity/resolve-outbound-credential";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type { CapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import type { HarnessActionExecutors } from "@/lib/runtime/harness-loop/loop";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";

export class AgentActionExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentActionExecutionError";
  }
}

export interface CreateAgentActionExecutorParams {
  tenantId: string;
  executionSubject: ExecutionSubject;
  resolveRoute: RouteResolver;
  routeScopeKey?: string;
  capabilityCatalog?: CapabilityCatalogSnapshot;
  transportChannel: AgentCallTransportChannel;
}

const createAgentCall = createCreateAgentCall({ store: mysqlAgentCallStore });

/** Harness agent.call 的唯一生产执行器；Hosted 与 Gateway 共同调用此服务。 */
export function createAgentActionExecutor(
  params: CreateAgentActionExecutorParams,
): NonNullable<HarnessActionExecutors["agent.call"]> {
  return async (action, context) => {
    if (context.tenantId !== params.tenantId) {
      throw new AgentActionExecutionError(
        "AGENT_CONTEXT_REQUIREMENT_UNSATISFIED",
        "Agent action 与执行器租户不一致",
      );
    }
    await throwIfAgentActionCancelled(context.abortSignal);

    try {
      const logicalCallKey = buildAgentCallLogicalKey(action.actionId, action.payload.agentId);
      const existing = await mysqlAgentCallStore.getByLogicalCallKey({
        tenantId: params.tenantId,
        parentInvocationId: context.invocationId,
        logicalCallKey,
      });
      let call = existing;
      if (!call) {
        const resolved = await resolveAgentActionBinding({
          tenantId: params.tenantId,
          agentId: action.payload.agentId,
          resolveRoute: params.resolveRoute,
          routeScopeKey: params.routeScopeKey ?? "default",
          businessKey: { threadId: context.threadId },
        });
        await throwIfAgentActionCancelled(context.abortSignal);
        const frozenAgent = params.capabilityCatalog?.agents.find(
          (entry) => entry.agentId === action.payload.agentId,
        );
        if (
          params.capabilityCatalog &&
          (!frozenAgent ||
            frozenAgent.agentRevisionId !== resolved.agentRevisionId ||
            frozenAgent.routeRevisionId !== resolved.resolution.routeRevisionId ||
            frozenAgent.contractSnapshotId !== resolved.contractSnapshotId ||
            frozenAgent.contractDigest !== resolved.contractDigest ||
            frozenAgent.publicationRecordId !== resolved.publicationRecordId)
        ) {
          throw new AgentActionExecutionError(
            "AGENT_CALL_BINDING_INVALID",
            "Agent 当前解析结果与 Invocation 冻结能力目录不一致",
          );
        }
        const enterprisePolicy = await loadEnterpriseUserAccessPolicy(
          params.tenantId,
          resolved.agentRevisionId,
        );
        const identityExtensions = await getIdentityExtensions();
        const enterpriseUserContextCandidate =
          enterprisePolicy.profileRequirement === "none"
            ? undefined
            : params.executionSubject.subjectType === "user"
              ? await prepareEnterpriseUserContext({
                  tenantId: params.tenantId,
                  userIdentityId: params.executionSubject.subjectId,
                  policy: enterprisePolicy,
                  source: identityExtensions.profileSource,
                  deadlineAt: context.deadlineAt,
                  signal: context.abortSignal,
                })
              : await prepareEnterpriseUserContext({
                  tenantId: params.tenantId,
                  userIdentityId: "service-subject",
                  policy: enterprisePolicy,
                  deadlineAt: context.deadlineAt,
                  signal: context.abortSignal,
                });
        await throwIfAgentActionCancelled(context.abortSignal);
        const created = await createAgentCall({
          tenantId: params.tenantId,
          parentInvocationId: context.invocationId,
          agentId: action.payload.agentId,
          actionId: action.actionId,
          transportChannel: params.transportChannel,
          bindingCandidate: {
            ...resolved.bindingCandidate,
            ...(enterpriseUserContextCandidate
              ? {
                  enterpriseUserContext: enterpriseUserContextCandidate.publicContext,
                  enterpriseUserContextEvidence: enterpriseUserContextCandidate.evidence,
                }
              : {}),
          },
        });
        call = created.call;
        await throwIfAgentActionCancelled(context.abortSignal, call);
      } else if (
        call.agentId !== action.payload.agentId ||
        call.sourceType !== "harness_planned" ||
        call.sourceRef !== action.actionId
      ) {
        throw new AgentCallIdempotencyConflictError(context.invocationId, logicalCallKey);
      }
      await throwIfAgentActionCancelled(context.abortSignal, call);
      const attachmentRefs = await createAgentAttachmentReferences({
        tenantId: params.tenantId,
        threadId: context.threadId,
        turnId: context.turnId,
        invocationId: context.invocationId,
        agentCallId: call.id,
        selectedContextRefs: action.payload.contextRefs ?? [],
        expiresAt: context.deadlineAt ?? new Date(Date.now() + 5 * 60 * 1000),
      });
      const current = await startAgentCall({
        tenantId: params.tenantId,
        callId: call.id,
        input: action.payload.task,
        contextEnvironment: {
          tenantId: params.tenantId,
          executionSubject: params.executionSubject,
          now: new Date(),
          timezone: "Asia/Shanghai",
          locale: "zh-CN",
          attachmentRefs,
        },
        selectedAcceptedContextKinds: attachmentRefs.length > 0 ? ["attachment_references"] : [],
        signal: context.abortSignal,
      });
      await throwIfAgentActionCancelled(context.abortSignal, current);
      const disposition = toAgentCallDisposition(current);
      if (disposition.outcome === "pending" || disposition.outcome === "waiting_user") {
        return {
          authorityRef: `agent-call:${disposition.callId}`,
          pending: {
            kind: "agent_call",
            callId: disposition.callId,
            state: disposition.state,
          },
        };
      }
      if (disposition.state !== "completed") {
        return {
          authorityRef: `agent-call:${disposition.callId}`,
          observation: {
            observationType: "agent",
            summary: disposition.errorSummary.slice(0, 20_000),
            sourceRefs: [`agent-call:${disposition.callId}`],
            data: {
              callId: disposition.callId,
              state: disposition.state,
              errorCode: normalizeTerminalCode(disposition.errorCode),
              errorSummary: disposition.errorSummary,
            },
          },
        };
      }
      const hostActions = readHostActions(disposition.resultJson);
      if (hostActions.length > 0) {
        await projectAgentHostActions({
          tenantId: params.tenantId,
          threadId: context.threadId,
          turnId: context.turnId,
          invocationId: context.invocationId,
          agentCallId: disposition.callId,
          actions: hostActions,
          executionSubject: params.executionSubject,
        });
      }
      return {
        authorityRef: `agent-call:${disposition.callId}`,
        observation: {
          observationType: "agent",
          summary: disposition.resultText.slice(0, 20_000),
          sourceRefs: [`agent-call:${disposition.callId}`],
          data: {
            callId: disposition.callId,
            resultText: disposition.resultText,
            resultJson: disposition.resultJson,
          },
        },
      };
    } catch (error) {
      if (
        error instanceof AgentActionExecutionError ||
        error instanceof AgentActionUnavailableError
      ) {
        throw error;
      }
      if (error instanceof AgentCallStartCancelledError) {
        throw new AgentActionExecutionError("AGENT_ACTION_CANCELLED", error.message);
      }
      if (error instanceof AgentAttachmentAccessError) {
        throw new AgentActionExecutionError("AGENT_CONTEXT_REQUIREMENT_UNSATISFIED", error.message);
      }
      if (error instanceof AgentCallIdempotencyConflictError) {
        throw new AgentActionExecutionError(
          "AGENT_CALL_IDEMPOTENCY_CONFLICT",
          "相同 Harness actionId 已绑定不同 AgentCall 请求",
        );
      }
      if (error instanceof OutboundCredentialError) {
        throw new AgentActionExecutionError(
          "AGENT_CALL_CREDENTIAL_UNAVAILABLE",
          "AgentCall 冻结凭证不可用",
        );
      }
      if (
        error instanceof RequiredContextUnavailableError ||
        error instanceof RequiredContextDeniedError ||
        error instanceof EnterpriseUserContextRequirementError
      ) {
        throw new AgentActionExecutionError("AGENT_CONTEXT_REQUIREMENT_UNSATISFIED", error.message);
      }
      const code = errorCode(error) ?? "AGENT_CALL_FAILED";
      throw new AgentActionExecutionError(
        normalizeStartCode(code),
        error instanceof Error ? error.message : "Agent action 执行失败",
      );
    }
  };
}

async function throwIfAgentActionCancelled(
  signal: AbortSignal | undefined,
  call?: { id: string; tenantId: string },
): Promise<void> {
  if (!signal?.aborted) return;
  if (call) {
    await cancelAgentCall({ tenantId: call.tenantId, callId: call.id }).catch(() => undefined);
  }
  throw new AgentActionExecutionError(
    "AGENT_ACTION_CANCELLED",
    "父执行已取消，停止 AgentCall 创建与出站",
  );
}

function readHostActions(value: unknown): HostAction[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const controls = (value as Record<string, unknown>).host_controls;
  if (!controls || typeof controls !== "object" || Array.isArray(controls)) return [];
  const actions = (controls as Record<string, unknown>).ui_actions;
  return Array.isArray(actions) ? (actions as HostAction[]) : [];
}

function normalizeTerminalCode(code: string): string {
  if (code.startsWith("AGENT_TRANSPORT_") || code.startsWith("AGENT_STREAM_")) {
    return "AGENT_CALL_TRANSPORT_FAILED";
  }
  return "AGENT_CALL_FAILED";
}

function normalizeStartCode(code: string): string {
  if (
    code.includes("CLAIM_CONFLICT") ||
    code.includes("INPUT_CONFLICT") ||
    code.includes("IDEMPOTENCY")
  ) {
    return "AGENT_CALL_IDEMPOTENCY_CONFLICT";
  }
  if (
    code.includes("BINDING") ||
    code.includes("CONTRACT") ||
    code.includes("UNSUPPORTED_PROTOCOL")
  ) {
    return "AGENT_CALL_BINDING_INVALID";
  }
  if (code.includes("CONTEXT")) return "AGENT_CONTEXT_REQUIREMENT_UNSATISFIED";
  return code.startsWith("AGENT_TRANSPORT_") ? "AGENT_CALL_TRANSPORT_FAILED" : "AGENT_CALL_FAILED";
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" && error.code ? error.code : null;
}
