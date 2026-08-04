import { getChatModel } from "@/lib/ai/provider";
import { aiConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { ensureHostedRouteForAgent } from "@/lib/runtimes/infrastructure/hosted-runtime-provisioner";
import { getThreadById } from "@/lib/v11/conversation/thread-queries";
import {
  WORKLOAD_TOKEN_DEFAULT_TTL_MS,
  issueWorkloadToken,
} from "@/lib/v11/identity/workload-token";
import type { HostedModelContext } from "@/lib/v11/runtime/adapters/hosted-adapter";
import { dispatchInvocationForTurn } from "@/lib/v11/runtime/dispatcher";
import { ingressEventBatch } from "@/lib/v11/runtime/event-ingress-queries";
import { createInProcessHostedRuntimeClient } from "@/lib/v11/runtime/in-process-hosted-runtime";
import { ingressTransientBatch } from "@/lib/v11/runtime/transient-events";
import { streamText } from "ai";

type ModelFn = (message: string, context: HostedModelContext) => Promise<string>;

export interface EmployeeTurnDispatchResult {
  dispatched: boolean;
  /** Agent Loop 的后台执行；HTTP 路由不等待它，测试可等待。 */
  completion: Promise<void>;
}

function configuredModelFn(): ModelFn {
  return async (message, context) => {
    if (!aiConfig.apiKey) {
      throw new Error("LLM_API_KEY 未配置");
    }
    const result = streamText({
      model: getChatModel(aiConfig.chatModel),
      prompt: message,
      maxOutputTokens: aiConfig.maxOutputTokens || undefined,
    });
    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
      await context.emitTextDelta?.(delta);
    }
    return text;
  };
}

/**
 * 调度员工发起的会话 Turn。
 *
 * 运行器与平台同进程，但仍严格通过 Invocation、ExecutionBinding 和 RuntimeEventIngress
 * 写回事件；不会绕开 V11 的会话事实源，也不会制造固定或回显式回复。
 */
export async function dispatchEmployeeTurn(params: {
  tenantId: string;
  threadId: string;
  turnId: string;
  modelRef?: string;
  modelFn?: ModelFn;
}): Promise<EmployeeTurnDispatchResult> {
  const thread = await getThreadById(params.tenantId, params.threadId);
  if (!thread) {
    throw new Error(`Turn 调度失败：会话不存在 (${params.threadId})`);
  }

  await ensureHostedRouteForAgent({
    tenantId: params.tenantId,
    agentId: thread.primaryAgentId,
  });
  const modelRef = params.modelRef ?? aiConfig.chatModel;
  const client = createInProcessHostedRuntimeClient({
    modelRef,
    modelFn: params.modelFn ?? configuredModelFn(),
    ingressEventBatch: async ({ invocationId, events, producerSequenceStart }) => {
      await ingressEventBatch({
        tenantId: params.tenantId,
        invocationId,
        events,
        producerSequenceStart,
      });
    },
    ingressTransientEventBatch: async ({ invocationId, events, transientSequenceStart }) => {
      await ingressTransientBatch({
        tenantId: params.tenantId,
        invocationId,
        events,
        transientSequenceStart,
      });
    },
  });

  const result = await dispatchInvocationForTurn({
    tenantId: params.tenantId,
    turnId: params.turnId,
    runtimeClient: client,
    runtimeEndpointResolver: async (binding) => ({
      runtimeEndpoint: "in-process://hosted",
      authToken: issueWorkloadToken({
        type: "runtime",
        tenantId: params.tenantId,
        invocationId: binding.invocationId,
        runtimeRevisionId: binding.runtimeRevisionId,
        audience: "runtime",
        expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
      }),
      gatewayEndpoints: {
        events: "in-process://events",
        cancel: "in-process://cancel",
        resume: "in-process://resume",
        steer: "in-process://steer",
      },
    }),
  });

  if (!result.dispatched || !result.invocation || result.runtimeDispatch?.skipped) {
    return { dispatched: result.dispatched, completion: Promise.resolve() };
  }

  const completion = client.launchAcceptedInvocation(result.invocation.id);
  void completion.catch((error) => {
    logger.error("[v11] Hosted Runtime 执行失败", {
      turnId: params.turnId,
      invocationId: result.invocation?.id,
      error: String(error),
    });
  });
  return { dispatched: true, completion };
}
