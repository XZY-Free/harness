import { z } from "zod";
import type { HarnessNextAction } from "./types";

const id = z.string().trim().min(1).max(128);
const actionId = z.string().trim().min(1).max(64);
const shortText = z.string().trim().min(1).max(500);
const refs = z.array(z.string().trim().min(1).max(512)).max(100);
const common = {
  actionId,
  stepNo: z.number().int().positive(),
  purposeCode: id,
  shortPurpose: shortText,
};

export const HARNESS_NEXT_ACTION_SCHEMA = z.discriminatedUnion("actionType", [
  z
    .object({
      ...common,
      actionType: z.literal("knowledge.search"),
      payload: z
        .object({
          query: z.string().trim().min(1).max(4_000),
          preferredSourceRefs: refs.optional(),
          maxResults: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      actionType: z.literal("tool.call"),
      payload: z
        .object({
          toolId: id,
          operationId: id,
          arguments: z.record(z.string(), z.unknown()),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      actionType: z.literal("agent.call"),
      payload: z
        .object({
          agentId: id,
          task: z.string().trim().min(1).max(8_000),
          expectedOutput: z.string().trim().min(1).max(2_000).optional(),
          contextRefs: refs.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      actionType: z.literal("request_user_input"),
      payload: z
        .object({
          purpose: id,
          inputSchema: z.record(z.string(), z.unknown()),
          prompt: z.string().trim().min(1).max(4_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      actionType: z.literal("respond"),
      payload: z.object({ evidenceRefs: refs.optional() }).strict(),
    })
    .strict(),
]);

export function parseHarnessNextAction(value: unknown): HarnessNextAction {
  return HARNESS_NEXT_ACTION_SCHEMA.parse(value) as HarnessNextAction;
}

export const HARNESS_ACTION_EVENT_PAYLOAD_SCHEMA = z
  .object({
    action_id: actionId,
    step_no: z.number().int().positive(),
    action_type: z.enum([
      "knowledge.search",
      "tool.call",
      "agent.call",
      "request_user_input",
      "respond",
    ]),
    action_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    purpose_code: id,
    short_purpose: shortText,
    target_ref: z.string().max(2_000).nullable(),
    state: z.enum(["proposed", "started", "completed", "failed"]),
    action_payload: z.record(z.string(), z.unknown()),
    authority_ref: z.string().trim().min(1).max(2_000).optional(),
    error_code: id.optional(),
    observation: z
      .object({
        observationType: z.enum(["knowledge", "tool", "agent", "user_input"]),
        summary: z.string().max(20_000),
        sourceRefs: refs,
        data: z.unknown(),
      })
      .strict()
      .optional(),
  })
  .strict();
