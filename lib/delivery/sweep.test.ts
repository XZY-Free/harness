import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock DB modules before importing sweep module
const queryMocks = vi.hoisted(() => ({
  appendThreadEvent: vi.fn(),
  updateThreadStatus: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  appendThreadEvent: queryMocks.appendThreadEvent,
  updateThreadStatus: queryMocks.updateThreadStatus,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDbChain: any = {
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
};
mockDbChain.select.mockReturnValue(mockDbChain);
mockDbChain.from.mockReturnValue(mockDbChain);

vi.mock("@/lib/db/client", () => ({
  db: mockDbChain,
}));

vi.mock("@/lib/db/schema", () => ({
  thread: {
    id: "id",
    status: "status",
    updatedAt: "updatedAt",
  },
}));

// Dynamic import to ensure mocks are in place
let sweepStaleDeliveringThreads: () => Promise<number>;

beforeEach(async () => {
  vi.clearAllMocks();
  mockDbChain.select.mockReturnValue(mockDbChain);
  mockDbChain.from.mockReturnValue(mockDbChain);
  queryMocks.appendThreadEvent.mockResolvedValue(undefined);
  queryMocks.updateThreadStatus.mockResolvedValue(undefined);
  // Re-import to get the mocked version
  const mod = await import("./sweep");
  sweepStaleDeliveringThreads = mod.sweepStaleDeliveringThreads;
});

describe("sweepStaleDeliveringThreads (M1-4)", () => {
  it("无超时 thread 时不做任何操作", async () => {
    mockDbChain.where.mockResolvedValue([]);

    const result = await sweepStaleDeliveringThreads();

    expect(result).toBe(0);
    expect(queryMocks.updateThreadStatus).not.toHaveBeenCalled();
  });

  it("超时 delivering thread 被回退为 failed 并写审计事件", async () => {
    const staleThreads = [{ id: "thread-stale-1" }, { id: "thread-stale-2" }];
    mockDbChain.where.mockResolvedValue(staleThreads);

    const result = await sweepStaleDeliveringThreads();

    expect(result).toBe(2);
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledTimes(2);
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith("thread-stale-1", "failed");
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledWith("thread-stale-2", "failed");
    expect(queryMocks.appendThreadEvent).toHaveBeenCalledTimes(2);
    expect(queryMocks.appendThreadEvent).toHaveBeenCalledWith(
      "thread-stale-1",
      "agent.status_changed",
      expect.objectContaining({ from: "delivering", to: "failed", reason: "delivering_timeout" }),
    );
  });

  it("sweep 中 updateThreadStatus 抛出异常时向上传播", async () => {
    const staleThreads = [{ id: "thread-err" }, { id: "thread-ok" }];
    mockDbChain.where.mockResolvedValue(staleThreads);
    queryMocks.updateThreadStatus.mockRejectedValueOnce(new Error("db error"));

    await expect(sweepStaleDeliveringThreads()).rejects.toThrow("db error");

    // 第一个 thread 失败后异常传播，第二个未被处理
    expect(queryMocks.updateThreadStatus).toHaveBeenCalledTimes(1);
  });
});
