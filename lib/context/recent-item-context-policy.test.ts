import { isDirectRecentContextItemEligible } from "@/lib/context/recent-item-context-policy";
import { describe, expect, it } from "vitest";

describe("recent item context policy", () => {
  it("只允许 completed + include + 明确 allowlist", () => {
    expect(
      isDirectRecentContextItemEligible({
        itemType: "assistant_message",
        itemState: "completed",
        contextPolicy: "include",
      }),
    ).toBe(true);
    expect(
      isDirectRecentContextItemEligible({
        itemType: "assistant_message",
        itemState: "pending",
        contextPolicy: "include",
      }),
    ).toBe(false);
    expect(
      isDirectRecentContextItemEligible({
        itemType: "host_action",
        itemState: "completed",
        contextPolicy: "include",
      }),
    ).toBe(false);
    expect(
      isDirectRecentContextItemEligible({
        itemType: "user_message",
        itemState: "completed",
        contextPolicy: "summary_only",
      }),
    ).toBe(false);
    expect(
      isDirectRecentContextItemEligible({
        itemType: "artifact",
        itemState: "completed",
        contextPolicy: "include",
      }),
    ).toBe(false);
  });
});
