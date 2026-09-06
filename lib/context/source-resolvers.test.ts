import { RecentItemsResolver } from "@/lib/context/source-resolvers";
import { listRecentContextItemsByThread } from "@/lib/conversations/thread-item-queries";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/conversations/thread-item-queries", () => ({
  listRecentContextItemsByThread: vi.fn(),
}));

const listRecentContextItemsByThreadMock = vi.mocked(listRecentContextItemsByThread);

function item(id: string, itemSequence: number) {
  return {
    id,
    itemType: "user_message" as const,
    itemState: "completed" as const,
    contextPolicy: "include" as const,
    itemSequence,
    contentJson: { text: id },
  } as never;
}

describe("RecentItemsResolver", () => {
  it("触发 Item 在最近窗口之外仍保留，并与最新上下文按时间排序", async () => {
    listRecentContextItemsByThreadMock.mockResolvedValue([
      item("trigger", 1),
      item("recent-3", 3),
      item("recent-4", 4),
    ]);

    const result = await new RecentItemsResolver(2).resolve({
      tenantId: "tenant-1",
      invocationId: "invocation-1",
      threadId: "thread-1",
      triggerItemId: "trigger",
    });

    expect(result.status).toBe("ok");
    expect(result.fragments.map((fragment) => fragment.sourceRef.id)).toEqual([
      "trigger",
      "recent-4",
    ]);
  });

  it("即使文本过滤不匹配，触发 Item 仍然保留", async () => {
    listRecentContextItemsByThreadMock.mockResolvedValue([item("trigger", 1)]);

    const result = await new RecentItemsResolver(2).resolve({
      tenantId: "tenant-1",
      invocationId: "invocation-1",
      threadId: "thread-1",
      triggerItemId: "trigger",
      query: "not-present",
    });

    expect(result.status).toBe("ok");
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]?.sourceRef.id).toBe("trigger");
  });
});
