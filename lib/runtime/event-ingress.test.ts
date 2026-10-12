/** Canonical RuntimeEventIngress contract regression tests. DB fencing is covered by runtime-ingress.db.test.ts. */
import {
  type AuthorityIdentity,
  RuntimeEventBatchSchema,
  computeEventPayloadHash,
} from "@/lib/runtime/runtime-protocol";
import { describe, expect, it } from "vitest";

const authority: AuthorityIdentity = {
  invocationId: "11111111-1111-4111-8111-111111111111",
  runtimeRevisionId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  ownershipId: "44444444-4444-4444-8444-444444444444",
  leaseEpoch: "1",
  sessionBindingId: "55555555-5555-4555-8555-555555555555",
};

describe("RuntimeEventIngress canonical wire", () => {
  it("accepts only version 3 events carrying the full execution authority", () => {
    const event = {
      eventId: "66666666-6666-4666-8666-666666666666",
      producerSequence: "1",
      type: "execution.started" as const,
      schemaVersion: 1,
      payload: { remoteSessionRef: "session:1", remoteExecutionRef: "execution:1" },
    };
    expect(
      RuntimeEventBatchSchema.parse({ protocolVersion: 3, authority, events: [event] }).authority,
    ).toEqual(authority);
  });

  it("hashes payload semantics without allowing event identity to substitute for fencing", () => {
    const base = {
      eventId: "66666666-6666-4666-8666-666666666666",
      producerSequence: "1",
      type: "progress" as const,
      schemaVersion: 1,
      payload: { progress: 1 },
    };
    expect(computeEventPayloadHash(base)).toBe(
      computeEventPayloadHash({
        ...base,
        eventId: "77777777-7777-4777-8777-777777777777",
        producerSequence: "2",
      }),
    );
    expect(computeEventPayloadHash(base)).not.toBe(
      computeEventPayloadHash({ ...base, payload: { progress: 2 } }),
    );
  });
});
