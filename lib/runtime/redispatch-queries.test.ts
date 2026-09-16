import {
  REDISPATCH_ALLOWED_STATES,
  createQueuedRedispatchAttempt,
  redispatchRuntimeInvocation,
} from "@/lib/runtime/application/runtime-redispatch";
import { describe, expect, it } from "vitest";

describe("Runtime redispatch canonical surface", () => {
  it("only permits nonterminal Invocation states and routes through one implementation", () => {
    expect(REDISPATCH_ALLOWED_STATES).toEqual(["queued", "running", "waiting_user"]);
    expect(createQueuedRedispatchAttempt.name).toBe("createQueuedRedispatchAttempt");
    expect(redispatchRuntimeInvocation.name).toBe("redispatchRuntimeInvocation");
  });
});
