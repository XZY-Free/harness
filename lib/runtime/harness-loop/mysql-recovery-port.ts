import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { getIngressByInvocation } from "@/lib/runtime/event-ingress-queries";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import { HARNESS_ACTION_EVENT_PAYLOAD_SCHEMA, parseHarnessNextAction } from "./action-schema";
import {
  HarnessLoopError,
  type HarnessLoopRecoveryPort,
  type HarnessLoopRecoverySnapshot,
} from "./loop";

export function createMySqlHarnessLoopRecoveryPort(tenantId: string): HarnessLoopRecoveryPort {
  return {
    async load(invocationId): Promise<HarnessLoopRecoverySnapshot> {
      const invocation = await getInvocationById(tenantId, invocationId);
      if (
        !invocation ||
        (invocation.executionState !== "running" && invocation.executionState !== "waiting_user")
      ) {
        throw new HarnessLoopError(
          "HARNESS_LOOP_STATE_RECOVERY_FAILED",
          `无法从 active Invocation 恢复 Harness Loop：${invocationId}`,
        );
      }
      const ingress = await getIngressByInvocation(tenantId, invocationId, { limit: 500 });
      const historyByActionId = new Map<
        string,
        HarnessLoopRecoverySnapshot["actionHistory"][number]
      >();
      for (const row of ingress) {
        if (!row.candidateType.startsWith("harness.action.")) continue;
        const envelope = asRecord(row.payloadJson);
        const parsed = HARNESS_ACTION_EVENT_PAYLOAD_SCHEMA.safeParse(envelope?.payload);
        if (!parsed.success) {
          throw new HarnessLoopError(
            "HARNESS_LOOP_STATE_RECOVERY_FAILED",
            `Harness action 事件负载损坏：${row.producerEventId}`,
          );
        }
        const payload = parsed.data;
        const action = parseHarnessNextAction({
          actionId: payload.action_id,
          stepNo: payload.step_no,
          actionType: payload.action_type,
          purposeCode: payload.purpose_code,
          shortPurpose: payload.short_purpose,
          payload: payload.action_payload,
        });
        const computedDigest = computeCanonicalDigest({
          actionType: action.actionType,
          payload: action.payload,
        });
        if (computedDigest !== payload.action_digest) {
          throw new HarnessLoopError(
            "HARNESS_LOOP_STATE_RECOVERY_FAILED",
            `Harness action digest 不一致：${payload.action_id}`,
          );
        }
        const existing = historyByActionId.get(payload.action_id);
        if (existing && existing.actionDigest !== payload.action_digest) {
          throw new HarnessLoopError(
            "HARNESS_LOOP_STATE_RECOVERY_FAILED",
            `Harness actionId 被不同 payload 复用：${payload.action_id}`,
          );
        }
        historyByActionId.set(payload.action_id, {
          actionId: payload.action_id,
          stepNo: payload.step_no,
          actionType: payload.action_type,
          actionDigest: payload.action_digest,
          targetRef: payload.target_ref,
          purposeCode: payload.purpose_code,
          shortPurpose: payload.short_purpose,
          action,
          state: payload.state,
          authorityRef: payload.authority_ref,
          errorCode: payload.error_code,
          observation: payload.observation,
        });
      }
      const actionHistory = [...historyByActionId.values()].sort((a, b) => a.stepNo - b.stepNo);
      return {
        invocationState: invocation.executionState,
        nextProducerSequence: Math.max(0, ...ingress.map((row) => row.producerSequence)) + 1,
        actionHistory,
        observations: actionHistory.flatMap((entry) =>
          entry.state === "completed" && entry.observation ? [entry.observation] : [],
        ),
      };
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
