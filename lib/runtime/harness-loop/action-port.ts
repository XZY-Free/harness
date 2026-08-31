import type { HarnessActionExecutionContext, HarnessActionExecutionResult } from "./loop";
import type { HarnessNextAction } from "./types";

export interface HarnessActionPort {
  execute(
    action: Exclude<HarnessNextAction, { actionType: "respond" }>,
    context: HarnessActionExecutionContext & { producerSequenceStart: number },
  ): Promise<
    HarnessActionExecutionResult & {
      nextProducerSequence: number;
    }
  >;
}

export class HarnessActionPortError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HarnessActionPortError";
  }
}

/** External Harness Runtime 只通过 Invocation-bound Gateway 调用平台 action。 */
export function createHttpHarnessActionPort(params: {
  endpoint: string;
  gatewayAccessToken: string;
}): HarnessActionPort {
  return {
    async execute(action, context) {
      const response = await fetch(params.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.gatewayAccessToken}`,
          "content-type": "application/json",
          "idempotency-key": `${context.invocationId}:${action.actionId}`,
        },
        body: JSON.stringify({
          invocation_id: context.invocationId,
          producer_sequence_start: context.producerSequenceStart,
          action,
        }),
      });
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
        next_producer_sequence?: number;
        observation?: HarnessActionExecutionResult["observation"];
        authority_ref?: string;
        waiting_for_user?: HarnessActionExecutionResult["waitingForUser"];
        pending?: Extract<HarnessActionExecutionResult, { pending: unknown }>["pending"];
      };
      if (!response.ok) {
        throw new HarnessActionPortError(
          body.error?.code ?? "HARNESS_ACTION_EXECUTION_FAILED",
          body.error?.message ?? `Capability Action HTTP ${response.status}`,
        );
      }
      if (typeof body.next_producer_sequence !== "number") {
        throw new Error("Capability Action 响应缺少 next_producer_sequence");
      }
      if (body.pending) {
        return {
          pending: body.pending,
          authorityRef: body.authority_ref,
          nextProducerSequence: body.next_producer_sequence,
        };
      }
      if (!body.observation) {
        throw new Error("Capability Action 响应缺少 observation");
      }
      return {
        observation: body.observation,
        authorityRef: body.authority_ref,
        waitingForUser: body.waiting_for_user,
        nextProducerSequence: body.next_producer_sequence,
      };
    },
  };
}
