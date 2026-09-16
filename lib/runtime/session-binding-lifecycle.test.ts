/** Canonical RuntimeSessionBinding identity is scoped to one Ownership generation. */
import {
  RUNTIME_SESSION_BINDING_STATES,
  RUNTIME_SESSION_INTENT_TYPES,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import {
  getRuntimeSessionBindingByOwnership,
  getRuntimeSessionBindingByStartIntent,
} from "@/lib/runtime/persistence/runtime-session-store";
import { describe, expect, it } from "vitest";

describe("RuntimeSessionBinding canonical identity", () => {
  it("only exposes generation-bound start and resume states", () => {
    expect(RUNTIME_SESSION_BINDING_STATES).toEqual([
      "prepared",
      "dispatching",
      "active",
      "closed",
      "lost",
    ]);
    expect(RUNTIME_SESSION_INTENT_TYPES).toEqual(["start", "resume"]);
  });

  it("uses ownership and stable start intent lookup rather than thread reuse", () => {
    expect(getRuntimeSessionBindingByOwnership.name).toBe("getRuntimeSessionBindingByOwnership");
    expect(getRuntimeSessionBindingByStartIntent.name).toBe(
      "getRuntimeSessionBindingByStartIntent",
    );
    expect(runtimeSessionBindingTable.startIntentKey.name).toBe("startIntentKey");
    expect(runtimeSessionBindingTable.ownershipId.name).toBe("ownershipId");
    expect("threadId" in runtimeSessionBindingTable).toBe(false);
    expect("jobId" in runtimeSessionBindingTable).toBe(false);
  });
});
