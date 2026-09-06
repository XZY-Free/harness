import type {
  ContextPolicy,
  ThreadItemState,
  ThreadItemType,
} from "@/lib/persistence/schema/conversation";

/** Only these completed, explicitly included items may be emitted directly. */
export const DIRECT_RECENT_CONTEXT_ITEM_TYPES = [
  "user_message",
  "user_guidance",
  "assistant_message",
  "tool_call",
] as const satisfies readonly ThreadItemType[];

export function isDirectRecentContextItemEligible(item: {
  itemType: string;
  itemState: ThreadItemState | string;
  contextPolicy: ContextPolicy | string;
}): boolean {
  return (
    item.itemState === "completed" &&
    item.contextPolicy === "include" &&
    (DIRECT_RECENT_CONTEXT_ITEM_TYPES as readonly string[]).includes(item.itemType)
  );
}
