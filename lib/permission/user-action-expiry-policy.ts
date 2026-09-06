export type UserActionExpiryChildKind = "agent_call" | "tool_call" | "none";

export interface UserActionExpiryPolicy {
  childKind: UserActionExpiryChildKind;
  parentTerminal: true;
}

/**
 * Every production UserActionRequest purpose has an explicit expiry policy.
 * Unknown purposes are handled as generic user waits and still fail closed by
 * terminating the parent; they never reopen or synthesize a response.
 */
export function classifyUserActionExpiry(
  requestType: string,
  purpose: string | null,
): UserActionExpiryPolicy {
  if (purpose === "a2a_confirmation" || purpose === "a2a_input_required") {
    return { childKind: "agent_call", parentTerminal: true };
  }
  if (purpose === "tool_permission_confirmation") {
    return { childKind: "tool_call", parentTerminal: true };
  }
  if (["confirmation", "auth", "grant", "input"].includes(requestType)) {
    return { childKind: "none", parentTerminal: true };
  }
  return { childKind: "none", parentTerminal: true };
}
