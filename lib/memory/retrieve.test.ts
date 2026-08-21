import type { MemoryEntry } from "@/lib/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => ({
  listMemoryRows: vi.fn(),
  getActiveEmbeddingRow: vi.fn(),
  // S1（06-P1-2/P2-3）：batch + fallback 查询 mock
  listActiveEmbeddingRows: vi.fn(async (ids: string[], _provider: string) => {
    const out = new Map();
    for (const id of ids) {
      const row = await queries.getActiveEmbeddingRow(id, _provider);
      if (row) out.set(id, row);
    }
    return out;
  }),
  // V6-M2-7：批量 fallback 查询 mock（替代原 getActiveEmbeddingRowAnyProvider N+1 mock）
  listActiveEmbeddingRowsAnyProvider: vi.fn(async () => new Map()),
  createMemoryRow: vi.fn(),
  findDuplicateMemory: vi.fn(),
  getMemoryRow: vi.fn(),
  updateMemoryRow: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({ ...queries }));

import {
  DeterministicFakeEmbeddingProvider,
  DisabledEmbeddingProvider,
  ErrorEmbeddingProvider,
} from "./embedding";
import { retrieveMemories } from "./retrieve";

function mem(over: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    scope: "project",
    scopeRef: "p1",
    kind: "convention",
    text: "commit 用 Lore trailer",
    textHash: "h",
    provenance: [{ kind: "user", refId: "u1" }],
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

describe("retrieveMemories lexical recall（fallback）", () => {
  it("关键词命中 → 返回；无 provider → embedding.status=disabled，并携带 lexical score/reason", async () => {
    queries.listMemoryRows.mockResolvedValue([
      mem({ id: "m1", text: "commit 用 Lore trailer" }),
      mem({ id: "m2", text: "完全无关的内容" }),
    ]);
    const r = await retrieveMemories({
      scopes: [{ scope: "project", scopeRef: "p1" }],
      currentGoal: "commit 用 Lore",
    });
    expect(r.memories.map((m) => m.id)).toContain("m1");
    expect(r.memories.find((m) => m.id === "m2")).toBeUndefined();
    expect(r.embedding.status).toBe("disabled");
    expect(r.embedding.reranked).toBe(false);
    for (const m of r.memories) {
      expect(m.retrievalScore).toBeGreaterThan(0);
      expect(m.retrievalReason).toBe("lexical");
    }
  });

  it("scope 优先级：user 记忆先于 project 同分记忆", async () => {
    queries.listMemoryRows.mockImplementation(async (filter: { scope: string }) => {
      if (filter.scope === "user")
        return [mem({ id: "mu", text: "commit Lore", scope: "user", scopeRef: "u1" })];
      if (filter.scope === "project")
        return [mem({ id: "mp", text: "commit Lore", scope: "project", scopeRef: "p1" })];
      return [];
    });
    const r = await retrieveMemories({
      scopes: [
        { scope: "user", scopeRef: "u1" },
        { scope: "project", scopeRef: "p1" },
      ],
      currentGoal: "commit Lore",
    });
    expect(r.memories[0]?.id).toBe("mu");
  });

  it("过期记忆被过滤", async () => {
    queries.listMemoryRows.mockResolvedValue([
      mem({ id: "m1", text: "commit Lore", expiresAt: new Date(Date.now() - 1000) }),
    ]);
    const r = await retrieveMemories({
      scopes: [{ scope: "project", scopeRef: "p1" }],
      currentGoal: "commit Lore",
    });
    expect(r.memories).toHaveLength(0);
  });

  it("无相关记忆 → 空（不强行注入）", async () => {
    queries.listMemoryRows.mockResolvedValue([mem({ id: "m1", text: "完全无关" })]);
    const r = await retrieveMemories({
      scopes: [{ scope: "project", scopeRef: "p1" }],
      currentGoal: "commit Lore",
    });
    expect(r.memories).toHaveLength(0);
  });

  it("limit 上限", async () => {
    queries.listMemoryRows.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => mem({ id: `m${i}`, text: "commit Lore" })),
    );
    const r = await retrieveMemories({
      scopes: [{ scope: "project", scopeRef: "p1" }],
      currentGoal: "commit Lore",
      limit: 3,
    });
    expect(r.memories).toHaveLength(3);
  });
});

describe("retrieveMemories semantic rerank", () => {
  it("provider ready + candidate 有 embedding → cosine rerank, status=ready/reranked=true", async () => {
    const provider = new DeterministicFakeEmbeddingProvider();
    const m1Vec = (await provider.embed("commit 用 Lore")).vector; // 与 query 同文本 → cosine 1
    const m2Vec = (await provider.embed("完全不同的事情")).vector;
    queries.listMemoryRows.mockResolvedValue([
      mem({ id: "m1", text: "commit 用 Lore trailer" }),
      mem({ id: "m2", text: "commit 用 Lore 其他" }),
    ]);
    queries.getActiveEmbeddingRow.mockImplementation(async (memoryId: string) => {
      if (memoryId === "m1") return { vector: m1Vec, status: "active" } as never;
      if (memoryId === "m2") return { vector: m2Vec, status: "active" } as never;
      return null;
    });
    const r = await retrieveMemories({
      scopes: [{ scope: "project", scopeRef: "p1" }],
      currentGoal: "commit 用 Lore",
      embeddingProvider: provider,
    });
    expect(r.embedding.status).toBe("ready");
    expect(r.embedding.reranked).toBe(true);
    // m1 与 query 完全相同 → cosine 1，排前
    expect(r.memories[0]?.id).toBe("m1");
    for (const m of r.memories) {
      expect(m.retrievalScore).toBeDefined();
      expect(m.retrievalReason).toBe("rerank");
    }
  });

  it("provider ready 但 candidate 无 embedding → status=stale, fallback lexical", async () => {
    const provider = new DeterministicFakeEmbeddingProvider();
    queries.listMemoryRows.mockResolvedValue([mem({ id: "m1", text: "commit Lore" })]);
    queries.getActiveEmbeddingRow.mockResolvedValue(null);
    const r = await retrieveMemories({
      scopes: [{ scope: "project", scopeRef: "p1" }],
      currentGoal: "commit Lore",
      embeddingProvider: provider,
    });
    expect(r.embedding.status).toBe("stale");
    expect(r.embedding.reranked).toBe(false);
    expect(r.memories.map((m) => m.id)).toContain("m1");
  });

  it("高置信 user/project preference/convention 可走纯语义召回", async () => {
    const provider = new DeterministicFakeEmbeddingProvider();
    const semVec = (await provider.embed("提交信息遵循 Lore trailer 规范")).vector;
    queries.listMemoryRows.mockResolvedValue([
      mem({
        id: "m-pref",
        scope: "project",
        kind: "convention",
        confidence: "high",
        text: "提交信息遵循 Lore trailer 规范",
      }),
      mem({
        id: "m-nope",
        scope: "project",
        kind: "fact",
        confidence: "medium",
        text: "完全无关的实现细节",
      }),
    ]);
    queries.getActiveEmbeddingRow.mockImplementation(async (memoryId: string) => {
      if (memoryId === "m-pref") return { vector: semVec, status: "active" } as never;
      return null;
    });
    const r = await retrieveMemories({
      scopes: [{ scope: "project", scopeRef: "p1" }],
      currentGoal: "commit message trailers",
      embeddingProvider: provider,
    });
    expect(r.embedding.status).toBe("ready");
    expect(r.memories[0]?.id).toBe("m-pref");
    expect(r.memories[0]?.retrievalReason).toBe("semantic");
    expect(r.lexicalCandidates).toHaveLength(0);
  });

  it("V3.3b §7 综合分：lexical 相同（同文本）时，semantic 权重 0.45 让高 cosine 排前", async () => {
    const provider = new DeterministicFakeEmbeddingProvider();
    // 两条候选文本相同 → lexical 分相同；embedding 不同 → cosine 不同。
    // m-same 与 query 同文本（cosine=1），m-diff 不同（cosine<1）→ m-same 综合分更高排前。
    const sameVec = (await provider.embed("commit 用 Lore")).vector;
    const diffVec = (await provider.embed("完全不同的语义")).vector;
    queries.listMemoryRows.mockResolvedValue([
      mem({ id: "m-diff", text: "commit 用 Lore trailer" }),
      mem({ id: "m-same", text: "commit 用 Lore trailer" }),
    ]);
    queries.getActiveEmbeddingRow.mockImplementation(async (memoryId: string) => {
      if (memoryId === "m-same") return { vector: sameVec, status: "active" } as never;
      if (memoryId === "m-diff") return { vector: diffVec, status: "active" } as never;
      return null;
    });
    const r = await retrieveMemories({
      scopes: [{ scope: "project", scopeRef: "p1" }],
      currentGoal: "commit 用 Lore",
      embeddingProvider: provider,
    });
    expect(r.embedding.status).toBe("ready");
    expect(r.memories[0]?.id).toBe("m-same");
  });

  it("V3.3b §7 综合分：semantic 权重 0.45 能让语义更强者越过 lexical 略弱者", async () => {
    const provider = new DeterministicFakeEmbeddingProvider();
    // m-lex：lexical 更强（与 query 多 token 重叠），但语义 embedding 与 query 不同 → cosine 较低。
    // m-sem：lexical 略弱（少一个 token 重叠），但 embedding 与 query 同文本 → cosine=1。
    // 0.45*semantic 差距应足以让 m-sem 排前（验证 semantic 权重主导，非纯 lexical）。
    const semVec = (await provider.embed("commit 用 Lore")).vector; // 与 query 同 → cosine 1
    const lexVec = (await provider.embed("另一个完全无关方向")).vector; // cosine 低
    queries.listMemoryRows.mockResolvedValue([
      // m-lex 文本含 query 全部 token（lexical 强）+ 额外 token
      mem({ id: "m-lex", text: "commit 用 Lore trailer 规范" }),
      // m-sem 文本只含部分 query token（lexical 略弱）
      mem({ id: "m-sem", text: "commit Lore" }),
    ]);
    queries.getActiveEmbeddingRow.mockImplementation(async (memoryId: string) => {
      if (memoryId === "m-sem") return { vector: semVec, status: "active" } as never;
      if (memoryId === "m-lex") return { vector: lexVec, status: "active" } as never;
      return null;
    });
    const r = await retrieveMemories({
      scopes: [{ scope: "project", scopeRef: "p1" }],
      currentGoal: "commit 用 Lore",
      embeddingProvider: provider,
    });
    expect(r.embedding.reranked).toBe(true);
    // semantic 权重 0.45（cosine 差接近 1）>> lexical 归一化差（0.35）→ m-sem 排前
    expect(r.memories[0]?.id).toBe("m-sem");
  });
});

describe("retrieveMemories provider 降级可观测（不静默伪装成功）", () => {
  it("disabled provider → status=disabled, lexical fallback", async () => {
    queries.listMemoryRows.mockResolvedValue([mem({ id: "m1", text: "commit Lore" })]);
    const r = await retrieveMemories({
      scopes: [{ scope: "project", scopeRef: "p1" }],
      currentGoal: "commit Lore",
      embeddingProvider: new DisabledEmbeddingProvider(),
    });
    expect(r.embedding.status).toBe("disabled");
    expect(r.embedding.reranked).toBe(false);
    expect(r.memories.map((m) => m.id)).toContain("m1");
  });

  it("error provider → status=error, lexical fallback（不伪装 ready）", async () => {
    queries.listMemoryRows.mockResolvedValue([mem({ id: "m1", text: "commit Lore" })]);
    const r = await retrieveMemories({
      scopes: [{ scope: "project", scopeRef: "p1" }],
      currentGoal: "commit Lore",
      embeddingProvider: new ErrorEmbeddingProvider(),
    });
    expect(r.embedding.status).toBe("error");
    expect(r.embedding.reranked).toBe(false);
    expect(r.memories.map((m) => m.id)).toContain("m1");
  });
});
