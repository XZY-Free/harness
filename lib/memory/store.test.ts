import type { MemoryEntry } from "@/lib/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => ({
  createMemoryRow: vi.fn(),
  findDuplicateMemory: vi.fn(),
  getMemoryRow: vi.fn(),
  listMemoryRows: vi.fn(),
  updateMemoryRow: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  createMemoryRow: queries.createMemoryRow,
  findDuplicateMemory: queries.findDuplicateMemory,
  getMemoryRow: queries.getMemoryRow,
  listMemoryRows: queries.listMemoryRows,
  updateMemoryRow: queries.updateMemoryRow,
}));

// V3.3b Stage B：store.createMemory 触发 indexMemory。mock 掉以隔离 store 断言，
// 断言 indexMemory 被调（去重命中也调）。
const indexModule = vi.hoisted(() => ({
  indexMemory: vi.fn(),
}));
vi.mock("./index", () => ({
  indexMemory: indexModule.indexMemory,
}));

import { hashMemoryText } from "./store";
import { createMemory, listMemories, revokeMemory, updateConfidence } from "./store";

function memRow(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "m-1",
    scope: "project",
    scopeRef: "p1",
    kind: "convention",
    text: "commit 用 Lore trailer",
    textHash: hashMemoryText("commit 用 Lore trailer"),
    provenance: [{ kind: "tool_run", refId: "tr-1", threadId: "t1" }],
    confidence: "medium",
    status: "active",
    expiresAt: null,
    createdByToolRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // indexMemory 默认返回 ready（store 断言不依赖索引细节）；个别用例覆盖 error/skipped。
  indexModule.indexMemory.mockResolvedValue({ status: "ready", provider: "fake", model: "fake-1" });
});

describe("createMemory 去重", () => {
  it("无重复 → 新建（threadId 取自 provenance），deduplicated=false", async () => {
    queries.findDuplicateMemory.mockResolvedValue(null);
    queries.createMemoryRow.mockResolvedValue(memRow({ id: "m-new" }));

    const r = await createMemory({
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "commit 用 Lore trailer",
      provenance: [{ kind: "user", refId: "u1", threadId: "t1" }],
    });

    expect(r.deduplicated).toBe(false);
    expect(queries.createMemoryRow).toHaveBeenCalledOnce();
    const created = queries.createMemoryRow.mock.calls[0]?.[0];
    expect(created.textHash).toBe(hashMemoryText("commit 用 Lore trailer"));
    expect(created.text).toBe("commit 用 Lore trailer");
    // V3.3b Stage B：新建后触发 indexMemory（embedding 必须在写入时生成）。
    expect(indexModule.indexMemory).toHaveBeenCalledWith("m-new", { provider: undefined });
    expect(r.semanticStatus).toBe("ready");
  });

  it("命中重复 → 合并 provenance + confidence 取较高，deduplicated=true，不新建", async () => {
    const existing = memRow({
      id: "m-dup",
      confidence: "medium",
      provenance: [{ kind: "user", refId: "u1", threadId: "t1" }],
    });
    queries.findDuplicateMemory.mockResolvedValue(existing);
    queries.updateMemoryRow.mockResolvedValue(
      memRow({
        id: "m-dup",
        confidence: "high",
        provenance: [
          { kind: "user", refId: "u1", threadId: "t1" },
          { kind: "tool_run", refId: "tr-9", threadId: "t1" },
        ],
      }),
    );

    const r = await createMemory({
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "commit 用 Lore trailer",
      provenance: [{ kind: "tool_run", refId: "tr-9", threadId: "t1" }],
      confidence: "high",
    });

    expect(r.deduplicated).toBe(true);
    expect(queries.createMemoryRow).not.toHaveBeenCalled();
    expect(queries.updateMemoryRow).toHaveBeenCalledOnce();
    const patch = queries.updateMemoryRow.mock.calls[0]?.[1];
    expect(patch.confidence).toBe("high");
    expect(patch.provenance).toHaveLength(2);
    // V3.3b Stage B：去重命中也触发 indexMemory（confidence 升高 → 重 index 保证 provider/model 最新）。
    expect(indexModule.indexMemory).toHaveBeenCalledWith("m-dup", { provider: undefined });
  });

  it("text 规范化（trim + 折叠空白）→ 相同 hash", async () => {
    queries.findDuplicateMemory.mockResolvedValue(null);
    queries.createMemoryRow.mockResolvedValue(memRow());
    await createMemory({
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "  commit   用   Lore  trailer  ",
      provenance: [{ kind: "user", refId: "u1", threadId: "t1" }],
    });
    const created = queries.createMemoryRow.mock.calls[0]?.[0];
    expect(created.text).toBe("commit 用 Lore trailer");
    expect(created.textHash).toBe(hashMemoryText("commit 用 Lore trailer"));
  });
});

describe("createMemory 触发 indexMemory 失败不阻断（V3.3b Stage B）", () => {
  it("indexMemory 抛错 → memory 仍创建成功，semanticStatus=error", async () => {
    queries.findDuplicateMemory.mockResolvedValue(null);
    queries.createMemoryRow.mockResolvedValue(memRow({ id: "m-err" }));
    indexModule.indexMemory.mockRejectedValue(new Error("unexpected"));

    const r = await createMemory({
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "commit 用 Lore trailer",
      provenance: [{ kind: "user", refId: "u1", threadId: "t1" }],
    });

    // 记忆创建优先于索引——memory 仍返回，未抛。
    expect(r.memory.id).toBe("m-err");
    expect(r.semanticStatus).toBe("error");
    expect(queries.createMemoryRow).toHaveBeenCalledOnce();
  });

  it("provider disabled → semanticStatus=disabled（memory 仍创建，不静默伪装 ready）", async () => {
    queries.findDuplicateMemory.mockResolvedValue(null);
    queries.createMemoryRow.mockResolvedValue(memRow({ id: "m-dis" }));
    indexModule.indexMemory.mockResolvedValue({
      status: "disabled",
      provider: "disabled",
      model: "none",
    });

    const r = await createMemory({
      scope: "project",
      scopeRef: "p1",
      kind: "convention",
      text: "commit 用 Lore trailer",
      provenance: [{ kind: "user", refId: "u1", threadId: "t1" }],
    });

    expect(r.memory.id).toBe("m-dis");
    expect(r.semanticStatus).toBe("disabled");
  });
});

describe("createMemory provenance 必填", () => {
  it("provenance 空 → 抛错（不写入、不查重）", async () => {
    await expect(
      createMemory({
        scope: "project",
        scopeRef: "p1",
        kind: "convention",
        text: "x",
        provenance: [],
      }),
    ).rejects.toThrow(/必填/);
    expect(queries.findDuplicateMemory).not.toHaveBeenCalled();
    expect(queries.createMemoryRow).not.toHaveBeenCalled();
  });

  it("provenance 全无效（缺 refId）→ 经 normalize 变空 → 抛必填错", async () => {
    await expect(
      createMemory({
        scope: "project",
        scopeRef: "p1",
        kind: "convention",
        text: "x",
        provenance: [{ kind: "user", refId: "" }],
      }),
    ).rejects.toThrow(/provenance/);
    expect(queries.createMemoryRow).not.toHaveBeenCalled();
  });
});

describe("revokeMemory soft delete", () => {
  it("存在 → status=revoked", async () => {
    queries.getMemoryRow.mockResolvedValue(memRow({ id: "m-1" }));
    queries.updateMemoryRow.mockResolvedValue(memRow({ id: "m-1", status: "revoked" }));

    const r = await revokeMemory("m-1", { reason: "过时", revokedBy: "u1" });

    expect(r?.status).toBe("revoked");
    expect(queries.updateMemoryRow).toHaveBeenCalledWith("m-1", { status: "revoked" });
  });

  it("不存在 → null", async () => {
    queries.getMemoryRow.mockResolvedValue(null);
    const r = await revokeMemory("nope");
    expect(r).toBeNull();
    expect(queries.updateMemoryRow).not.toHaveBeenCalled();
  });
});

describe("listMemories / updateConfidence", () => {
  it("listMemories 透传 filter（默认 status=active）", async () => {
    queries.listMemoryRows.mockResolvedValue([memRow()]);
    const r = await listMemories({ scope: "project", scopeRef: "p1" });
    expect(r).toHaveLength(1);
    expect(queries.listMemoryRows).toHaveBeenCalledWith({
      scope: "project",
      scopeRef: "p1",
      kind: undefined,
      status: "active",
    });
  });

  it("updateConfidence → updateMemoryRow", async () => {
    queries.updateMemoryRow.mockResolvedValue(memRow({ confidence: "high" }));
    const r = await updateConfidence("m-1", "high");
    expect(r?.confidence).toBe("high");
    expect(queries.updateMemoryRow).toHaveBeenCalledWith("m-1", { confidence: "high" });
  });
});
