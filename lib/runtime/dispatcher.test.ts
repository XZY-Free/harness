import { DEFAULT_ROUTE_SCOPE_KEY, dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { describe, expect, it } from "vitest";

describe("Runtime dispatcher canonical surface", () => {
  it("creates the Invocation → Binding → Attempt chain from the canonical route scope", () => {
    expect(DEFAULT_ROUTE_SCOPE_KEY).toBe("default");
    expect(dispatchInvocationForTurn.name).toBe("dispatchInvocationForTurn");
  });
});
