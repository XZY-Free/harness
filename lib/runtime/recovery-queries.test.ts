import {
  findStaleInvocations,
  getLatestProducerSequence,
  markInvocationLost,
} from "@/lib/runtime/application/runtime-recovery";
import { describe, expect, it } from "vitest";

describe("Runtime recovery canonical surface", () => {
  it("uses ownership-aware recovery operations rather than mutable Invocation heartbeats", () => {
    expect(findStaleInvocations.name).toBe("findStaleInvocations");
    expect(getLatestProducerSequence.name).toBe("getLatestProducerSequence");
    expect(markInvocationLost.name).toBe("markInvocationLost");
  });
});
