import { describe, expect, it } from "vitest";
import { requiresSnapshotRefresh } from "./thread-client";
import type { ClientEvent } from "./types";

function event(overrides: Partial<ClientEvent>): ClientEvent {
  return {
    event_id: "event-1",
    sequence: 1,
    schema_version: 1,
    thread_id: "thread-1",
    turn_id: "turn-1",
    item_id: "item-1",
    occurred_at: "2026-07-30T00:00:00.000Z",
    event_type: "item.created",
    payload: {},
    ...overrides,
  };
}

describe("requiresSnapshotRefresh", () => {
  it("Item 事件只有摘要时要求重新读取完整快照", () => {
    expect(
      requiresSnapshotRefresh(
        event({ payload: { item_type: "agent_message", content_hash: "sha256:example" } }),
      ),
    ).toBe(true);
  });

  it("已携带完整 Item 的事件可直接应用", () => {
    expect(
      requiresSnapshotRefresh(
        event({
          payload: {
            item: {
              id: "item-1",
              turn_id: "turn-1",
              item_sequence: 1,
              item_type: "agent_message",
              item_state: "completed",
              content: { text: "已完成" },
              created_at: "2026-07-30T00:00:00.000Z",
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("非 Item 事件不触发快照重读", () => {
    expect(requiresSnapshotRefresh(event({ event_type: "turn.queued" }))).toBe(false);
  });
});
