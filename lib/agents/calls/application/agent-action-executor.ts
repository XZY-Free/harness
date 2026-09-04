import { createCreateAgentCall } from "@/lib/agents/calls/application/create-agent-call";
import {
  AgentActionUnavailableError,
  resolveAgentActionBinding,
} from "@/lib/agents/calls/application/resolve-agent-call-binding";
import { startAgentCall } from "@/lib/agents/calls/application/start-agent-call";
import { toAgentCallDisposition } from "@/lib/agents/calls/domain/agent-call";
import {
  AgentCallIdempotencyConflictError,
  mysqlAgentCallStore,
} from "@/lib/agents/calls/persistence/mysql-agent-call-store";
import {
  RequiredContextDeniedError,
  RequiredContextUnavailableError,
} from "@/lib/context/enrichment/build-invocation-context-bundle";
import { OutboundCredentialError } from "@/lib/identity/resolve-outbound-credential";
import { logger } from "@/lib/logger";
import type { RouteResolver } from "@/lib/routes/application/resolve-route";
import type { CapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import { coordinateAgentInputRequired } from "@/lib/runtime/harness-loop/coordinate-agent-input-required";
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

    try {
      const logicalCallKey = `${context.invocationId}:${action.actionId}:${action.payload.agentId}`;
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
        const created = await createAgentCall({
          tenantId: params.tenantId,
          parentInvocationId: context.invocationId,
          agentId: action.payload.agentId,
          agentRevisionId: resolved.agentRevisionId,
          sourceType: "harness_planned",
          sourceRef: action.actionId,
          logicalCallKey,
          bindingCandidate: resolved.bindingCandidate,
        });
        call = created.call;
      } else if (
        call.agentId !== action.payload.agentId ||
        call.sourceType !== "harness_planned" ||
        call.sourceRef !== action.actionId
      ) {
        throw new AgentCallIdempotencyConflictError(context.invocationId, logicalCallKey);
      }
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
        },
      });
      const disposition = toAgentCallDisposition(current);
      if (disposition.outcome === "pending" || disposition.outcome === "waiting_user") {
        if (disposition.outcome === "waiting_user") {
          try {
            await coordinateAgentInputRequired(params.tenantId, disposition.callId);
          } catch (error) {
            logger.warn("Harness recovery 尚未完成 Agent input-required Parent 协调", {
              callId: disposition.callId,
              error: error instanceof Error ? error.message : "unknown",
            });
          }
        }
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
        throw new AgentActionExecutionError(
          normalizeTerminalCode(disposition.errorCode),
          disposition.errorSummary,
        );
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
        error instanceof RequiredContextDeniedError
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
