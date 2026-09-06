import { classifyUserActionExpiry } from "@/lib/permission/user-action-expiry-policy";
import { describe, expect, it } from "vitest";

describe("UserActionRequest expiry policy", () => {
  it("覆盖 A2A、Tool permission、auth、grant、普通 input/confirmation", () => {
    expect(classifyUserActionExpiry("confirmation", "a2a_confirmation")).toEqual({
      childKind: "agent_call",
      parentTerminal: true,
    });
    expect(classifyUserActionExpiry("input", "a2a_input_required")).toEqual({
      childKind: "agent_call",
      parentTerminal: true,
    });
    expect(classifyUserActionExpiry("confirmation", "tool_permission_confirmation")).toEqual({
      childKind: "tool_call",
      parentTerminal: true,
    });
    expect(classifyUserActionExpiry("auth", "credential_login")).toEqual({
      childKind: "none",
      parentTerminal: true,
    });
    expect(classifyUserActionExpiry("grant", "grant")).toEqual({
      childKind: "none",
      parentTerminal: true,
    });
    expect(classifyUserActionExpiry("input", "other")).toEqual({
      childKind: "none",
      parentTerminal: true,
    });
  });
});
