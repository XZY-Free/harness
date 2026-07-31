import type { MemoryEntry } from "@/lib/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => ({
  getMemoryRow: vi.fn(),
  upsertEmbeddingRow: vi.fn(),
  listEmbeddingRowsByMemory: vi.fn(),
  listMemoryRows: vi.fn(),
  appendThreadEvent: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({ ...queries }));

import {
  DeterministicFakeEmbeddingProvider,
  DisabledEmbeddingProvider,
  ErrorEmbeddingProvider,
} from "./embedding";
import { indexMemory, markEmbeddingStale, reindexMemories } from "./index";

function mem(over: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    scope: "project",
    scopeRef: "p1",
    kind: "convention",
    text: "commit 用 Lore trailer",
    textHash: "h",
    provenance: [{ kind: "tool_run", refId: "tr-1", threadId: "t1" }],
    confidence: "medium",
    status: "active",
    expiresAt: null,
    createdByToolRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as MemoryEntry;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("indexMemory 写入触发（embedding 必须在写入时生成，不能只建表不填数据）", () => {
  it("active memory + provider ready → upsert status=active + memory.reindexed(ready, dimension)", async () => {
    queries.getMemoryRow.mockResolvedValue(mem({ id: "m1" }));
    const provider = new DeterministicFakeEmbeddingProvider();
    const r = await indexMemory("m1", { provider });

    expect(r.status).toBe("ready");
    expect(r.dimension).toBe(16);
    expect(queries.upsertEmbeddingRow).toHaveBeenCalledOnce();
    const upserted = queries.upsertEmbeddingRow.mock.calls[0]?.[0];
    expect(upserted.memoryId).toBe("m1");
    expect(upserted.status).toBe("active");
    expect(upserted.vector).toHaveLength(16);
    expect(upserted.dim).toBe(16);
    // MemoryEmbedding 行存在且非空（核心硬约束）
    expect(upserted.vector.length).toBeGreaterThan(0);
    expect(queries.appendThreadEvent).toHaveBeenCalledWith(
      "t1",
      "memory.reindexed",
      expect.objectContaining({
        memoryId: "m1",
        provider: provider.name,
        status: "ready",
        dimension: 16,
      }),
    );
  });

  it("revoked memory → skipped，不索引、不写行、不发事件", async () => {
    queries.getMemoryRow.mockResolvedValue(mem({ id: "m1", status: "revoked" }));
    const r = await indexMemory("m1", { provider: new DeterministicFakeEmbeddingProvider() });
    expect(r.status).toBe("skipped");
    expect(queries.upsertEmbeddingRow).not.toHaveBeenCalled();
    expect(queries.appendThreadEvent).not.toHaveBeenCalled();
  });

  it("不存在 memory → skipped", async () => {
    queries.getMemoryRow.mockResolvedValue(null);
    const r = await indexMemory("nope", { provider: new DeterministicFakeEmbeddingProvider() });
    expect(r.status).toBe("skipped");
  });
});

describe("indexMemory provider 降级（不静默伪装成功）", () => {
  it("disabled provider → status=disabled，不写 embedding 行、不发事件（memory 仍可创建）", async () => {
    queries.getMemoryRow.mockResolvedValue(mem({ id: "m1" }));
    const r = await indexMemory("m1", { provider: new DisabledEmbeddingProvider() });
    expect(r.status).toBe("disabled");
    expect(queries.upsertEmbeddingRow).not.toHaveBeenCalled();
    expect(queries.appendThreadEvent).not.toHaveBeenCalled();
  });

  it("error provider → upsert status=error + memory.reindexed(error, errorCode)，不抛", async () => {
    queries.getMemoryRow.mockResolvedValue(mem({ id: "m1" }));
    const r = await indexMemory("m1", { provider: new ErrorEmbeddingProvider() });
    expect(r.status).toBe("error");
    expect(r.errorCode).toBeTruthy();
    const upserted = queries.upsertEmbeddingRow.mock.calls[0]?.[0];
    expect(upserted.status).toBe("error");
    expect(upserted.errorMessage).toBeTruthy();
    // errorMessage 不含 secret（ErrorEmbeddingProvider 的 error 文本无 key）
    expect(upserted.errorMessage).not.toMatch(/Bearer|sk-|key/i);
    expect(queries.appendThreadEvent).toHaveBeenCalledWith(
      "t1",
      "memory.reindexed",
      expect.objectContaining({ memoryId: "m1", status: "error", errorCode: expect.any(String) }),
    );
  });
});

describe("markEmbeddingStale", () => {
  it("读现有 embedding 行 → upsert status=stale + reason", async () => {
    queries.listEmbeddingRowsByMemory.mockResolvedValue([
      { memoryId: "m1", provider: "fake", model: "fake-1", vector: [0.1, 0.2], dim: 2 },
    ]);
    await markEmbeddingStale("m1", "text 变化");
    const upserted = queries.upsertEmbeddingRow.mock.calls[0]?.[0];
    expect(upserted.status).toBe("stale");
    expect(upserted.errorMessage).toBe("text 变化");
    expect(upserted.vector).toEqual([0.1, 0.2]);
  });

  it("无 embedding 行 → 不 upsert", async () => {
    queries.listEmbeddingRowsByMemory.mockResolvedValue([]);
    await markEmbeddingStale("m1", "x");
    expect(queries.upsertEmbeddingRow).not.toHaveBeenCalled();
  });
});

describe("reindexMemories（同步小批量）", () => {
  it("scope 内 active memory 逐个 index，汇总 ready/error/skipped", async () => {
    queries.listMemoryRows.mockResolvedValue([mem({ id: "m1" }), mem({ id: "m2" })]);
    queries.getMemoryRow
      .mockResolvedValueOnce(mem({ id: "m1" }))
      .mockResolvedValueOnce(mem({ id: "m2", status: "revoked" }));
    const summary = await reindexMemories({
      scope: "project",
      scopeRef: "p1",
      provider: new DeterministicFakeEmbeddingProvider(),
    });
    expect(summary.processed).toBe(2);
    expect(summary.ready).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.error).toBe(0);
  });

  it("无 scope → 不处理（返回 0）", async () => {
    const summary = await reindexMemories({ provider: new DeterministicFakeEmbeddingProvider() });
    expect(summary.processed).toBe(0);
    expect(queries.listMemoryRows).not.toHaveBeenCalled();
  });
});
