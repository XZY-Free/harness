import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { db } from "@/lib/db/client";
import { getUserActionRequestsByInvocation } from "@/lib/permission/user-action-queries";
import { threadItemTable } from "@/lib/persistence/schema/conversation";
import { getIngressByInvocation } from "@/lib/runtime/event-ingress-queries";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import { and, asc, eq } from "drizzle-orm";
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
      const resolvedInputs = (await getUserActionRequestsByInvocation(tenantId, invocationId))
        .filter(
          (request) =>
            request.requestState === "resolved" &&
            request.requestType === "input" &&
            request.harnessActionId,
        )
        .map((request) => ({
          observationType: "user_input" as const,
          summary: request.resolution === "submit" ? "用户已补充所需信息" : "用户已取消补充信息",
          sourceRefs: [`user-action:${request.id}`],
          data: {
            harnessActionId: request.harnessActionId,
            uarId: request.id,
            purpose: request.purpose,
            resolution: request.resolution,
            response: request.responseRedactedJson,
          },
        }));
      const guidanceItems = await db
        .select({ id: threadItemTable.id, content: threadItemTable.contentJson })
        .from(threadItemTable)
        .where(
          and(
            eq(threadItemTable.invocationId, invocationId),
            eq(threadItemTable.itemType, "user_guidance"),
            eq(threadItemTable.itemState, "completed"),
          ),
        )
        .orderBy(asc(threadItemTable.itemSequence));
      const durableInputs = [
        ...resolvedInputs,
        ...guidanceItems.map((item) => ({
          observationType: "user_input" as const,
          summary: "用户已提供执行引导",
          sourceRefs: [`guidance-item:${item.id}`],
          data: { guidanceItemId: item.id, guidance: item.content },
        })),
      ];
      return {
        invocationState: invocation.executionState,
        nextProducerSequence: Math.max(0, ...ingress.map((row) => row.producerSequence)) + 1,
        actionHistory,
        observations: [
          ...actionHistory.flatMap((entry) =>
            entry.state === "completed" && entry.observation ? [entry.observation] : [],
          ),
          ...durableInputs,
        ],
      };
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
