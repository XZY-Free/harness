import type { SubagentDefinition, SubagentRun } from "@/lib/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.5 Stage A registry 测试。
 *
 * registry 编排层（mutex / 并发上限 / 状态机 / 事件 / outputSchema 校验）在此隔离测试：
 * vi.mock 拦截 @/lib/db/queries，注入受控的 definition/run 存储与活跃 run 列表。
 * 纯函数 writeScopesOverlap / validateOutput / canTransition 直接断言。
 * 纯 DB CRUD 字段断言在 queries.test.ts 的真实 MySQL 同构测试覆盖。
 */

// ─── 受控存储 ────────────────────────────────────────────────
const definitions = new Map<string, SubagentDefinition>();
const runs = new Map<string, SubagentRun>();
const events: Array<{ threadId: string; type: string; payload: Record<string, unknown> }> = [];

function def(over: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    id: "def-1",
    name: "explore",
    role: "explore",
    modelProfileId: null,
    allowedTools: ["readFile", "glob", "grep"],
    contextPolicy: {},
    outputSchema: null,
    defaultWriteScope: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "run-1",
    parentThreadId: "tid",
    definitionId: "def-1",
    goal: "explore the repo",
    contextHints: null,
    status: "queued",
    writeScope: null,
    resultSummary: null,
    outputArtifactId: null,
    transcriptPath: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...over,
  };
}

vi.mock("@/lib/db/queries", () => ({
  createSubagentDefinition: vi.fn(async (p: Record<string, unknown>) => {
    const row = def({ id: "def-new", ...p } as unknown as Partial<SubagentDefinition>);
    definitions.set(row.id, row);
    return row;
  }),
  getSubagentDefinition: vi.fn(async (id: string) => definitions.get(id) ?? null),
  listSubagentDefinitions: vi.fn(async () => [...definitions.values()]),
  createSubagentRun: vi.fn(async (p: Record<string, unknown>) => {
    const row = run({ id: `run-${runs.size + 1}`, ...p } as unknown as Partial<SubagentRun>);
    runs.set(row.id, row);
    return row;
  }),
  getSubagentRun: vi.fn(async (id: string) => runs.get(id) ?? null),
  listSubagentRunsByThread: vi.fn(async (tid: string) =>
    [...runs.values()].filter((r) => r.parentThreadId === tid),
  ),
  listActiveSubagentRunsByThread: vi.fn(async (tid: string) =>
    [...runs.values()].filter(
      (r) => r.parentThreadId === tid && (r.status === "queued" || r.status === "running"),
    ),
  ),
  updateSubagentRun: vi.fn(
    async (id: string, patch: Partial<SubagentRun> & { expectedStatus?: string }) => {
      const existing = runs.get(id);
      if (!existing) return null;
      // P1-12: 模拟真实 CAS——expectedStatus 不匹配则返回 null
      if (patch.expectedStatus !== undefined && existing.status !== patch.expectedStatus) {
        return null;
      }
      const { expectedStatus: _unused, ...rest } = patch;
      void _unused;
      const merged = { ...existing, ...rest } as SubagentRun;
      runs.set(id, merged);
      return merged;
    },
  ),
  appendThreadEvent: vi.fn(
    async (threadId: string, type: string, payload: Record<string, unknown>) => {
      events.push({ threadId, type, payload });
    },
  ),
}));

// logger 的 warn 在状态机非法迁移时调用，mock 掉避免噪音。
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import * as queriesMock from "@/lib/db/queries";
import {
  DEFAULT_SUBAGENT_CONCURRENCY_CAP,
  canTransition,
  createDefinition,
  createRun,
  getRun,
  listActiveRunsByThread,
  updateRunStatus,
  validateOutput,
  writeScopesOverlap,
} from "./registry";

beforeEach(() => {
  definitions.clear();
  runs.clear();
  events.length = 0;
});

describe("writeScopesOverlap（§14 互斥启发式）", () => {
  it("只读 scope（null/空）与任何 scope 都不重叠", () => {
    expect(writeScopesOverlap(null, ["src/**/*.ts"])).toBe(false);
    expect(writeScopesOverlap([], ["src/**/*.ts"])).toBe(false);
    expect(writeScopesOverlap(null, null)).toBe(false);
  });

  it("相同路径前缀重叠", () => {
    expect(writeScopesOverlap(["src/a.ts"], ["src/a.ts"])).toBe(true);
    expect(writeScopesOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
  });

  it("目录前缀包含重叠（父目录 vs 子文件）", () => {
    expect(writeScopesOverlap(["src/"], ["src/a.ts"])).toBe(true);
    expect(writeScopesOverlap(["src"], ["src/sub/x.ts"])).toBe(true);
  });

  it("不同根目录不重叠", () => {
    expect(writeScopesOverlap(["src/**"], ["docs/**"])).toBe(false);
  });

  it("unbounded glob（**/*.ts 前缀为空）与任何写 scope 重叠（fail-closed）", () => {
    expect(writeScopesOverlap(["**/*.ts"], ["docs/readme.md"])).toBe(true);
  });

  // S1（04-G18）：brace 展开后重叠判定
  it("brace 展开后子前缀重叠（src/{a,b} vs src/a）→ 重叠", () => {
    expect(writeScopesOverlap(["src/{a,b}/**"], ["src/a/x.ts"])).toBe(true);
    expect(writeScopesOverlap(["src/{a,b}/**"], ["src/c/x.ts"])).toBe(false);
  });
});

// S1（04-G12）：outputSchema 校验器扩展 keyword
describe("validateOutput 扩展 keyword（G12）", () => {
  it("minLength / maxLength", () => {
    const schema = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", minLength: 2, maxLength: 5 } },
    };
    expect(validateOutput({ name: "ab" }, schema).ok).toBe(true);
    expect(validateOutput({ name: "a" }, schema).ok).toBe(false); // minLength
    expect(validateOutput({ name: "abcdef" }, schema).ok).toBe(false); // maxLength
  });

  it("minimum / maximum", () => {
    const schema = {
      type: "object",
      required: ["n"],
      properties: { n: { type: "number", minimum: 1, maximum: 10 } },
    };
    expect(validateOutput({ n: 5 }, schema).ok).toBe(true);
    expect(validateOutput({ n: 0 }, schema).ok).toBe(false);
    expect(validateOutput({ n: 11 }, schema).ok).toBe(false);
  });

  it("minItems / maxItems", () => {
    const schema = {
      type: "object",
      required: ["list"],
      properties: { list: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } } },
    };
    expect(validateOutput({ list: ["a"] }, schema).ok).toBe(true);
    expect(validateOutput({ list: [] }, schema).ok).toBe(false);
    expect(validateOutput({ list: ["a", "b", "c", "d"] }, schema).ok).toBe(false);
  });

  it("pattern", () => {
    const schema = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", pattern: "^[a-z]+$" } },
    };
    expect(validateOutput({ id: "abc" }, schema).ok).toBe(true);
    expect(validateOutput({ id: "ABC" }, schema).ok).toBe(false);
  });
});

describe("validateOutput（outputSchema 契约）", () => {
  it("null schema = 不校验，always ok", () => {
    expect(validateOutput("anything", null).ok).toBe(true);
  });

  it("type 校验失败", () => {
    const r = validateOutput(42, { type: "string" });
    expect(r.ok).toBe(false);
  });

  it("required 缺字段失败", () => {
    const schema = {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    };
    expect(validateOutput({}, schema).ok).toBe(false);
    expect(validateOutput({ summary: "ok" }, schema).ok).toBe(true);
  });

  it("嵌套 properties + items 校验", () => {
    const schema = {
      type: "object",
      required: ["files"],
      properties: {
        files: { type: "array", items: { type: "string" } },
      },
    };
    expect(validateOutput({ files: ["a.ts", "b.ts"] }, schema).ok).toBe(true);
    expect(validateOutput({ files: ["a.ts", 5] }, schema).ok).toBe(false);
  });

  it("additionalProperties:false 拒绝额外字段", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    expect(validateOutput({ a: "x" }, schema).ok).toBe(true);
    expect(validateOutput({ a: "x", b: 1 }, schema).ok).toBe(false);
  });

  it("enum 校验", () => {
    expect(validateOutput("high", { type: "string", enum: ["low", "medium", "high"] }).ok).toBe(
      true,
    );
    expect(validateOutput("huge", { type: "string", enum: ["low", "medium", "high"] }).ok).toBe(
      false,
    );
  });
});

describe("canTransition（状态机）", () => {
  it("queued → running / cancelled 合法", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("queued", "cancelled")).toBe(true);
    expect(canTransition("queued", "completed")).toBe(false);
  });

  it("running → 终态合法", () => {
    expect(canTransition("running", "completed")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("running", "timed_out")).toBe(true);
    expect(canTransition("running", "queued")).toBe(false);
  });

  it("终态不可再迁移", () => {
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("failed", "completed")).toBe(false);
  });
});

describe("createRun（并发上限 + writeScope 互斥 + 事件）", () => {
  it("definition 不存在 → definition_not_found 拒绝", async () => {
    const r = await createRun({
      parentThreadId: "tid",
      definitionId: "missing",
      goal: "g",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.kind).toBe("definition_not_found");
  });

  it("正常创建只读 run：落行 + subagent.spawned 事件", async () => {
    definitions.set("def-1", def());
    const r = await createRun({ parentThreadId: "tid", definitionId: "def-1", goal: "find x" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.run.status).toBe("queued");
      expect(r.run.writeScope).toBeNull();
    }
    expect(events.find((e) => e.type === "subagent.spawned")?.payload).toMatchObject({
      role: "explore",
      goal: "find x",
    });
  });

  it("并发上限：活跃 run 数 >= cap → 拒绝", async () => {
    definitions.set("def-1", def());
    for (let i = 0; i < DEFAULT_SUBAGENT_CONCURRENCY_CAP; i++) {
      runs.set(`r${i}`, run({ id: `r${i}`, status: "running" }));
    }
    const r = await createRun({ parentThreadId: "tid", definitionId: "def-1", goal: "g" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.kind).toBe("concurrency_cap");
  });

  it("writeScope 互斥：与活跃 run 写范围重叠 → 拒绝（§14）", async () => {
    definitions.set("def-w", def({ id: "def-w", defaultWriteScope: ["src/a.ts"] }));
    runs.set("r1", run({ id: "r1", status: "running", writeScope: ["src/a.ts"] }));
    const r = await createRun({ parentThreadId: "tid", definitionId: "def-w", goal: "g" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.kind).toBe("write_scope_overlap");
  });

  it("writeScope 互斥：不重叠的写范围允许并发", async () => {
    definitions.set("def-w", def({ id: "def-w", defaultWriteScope: ["docs/**"] }));
    runs.set("r1", run({ id: "r1", status: "running", writeScope: ["src/**"] }));
    const r = await createRun({ parentThreadId: "tid", definitionId: "def-w", goal: "g" });
    expect(r.ok).toBe(true);
  });

  it("spawn 参数 writeScope 覆盖 definition.defaultWriteScope", async () => {
    definitions.set("def-1", def({ defaultWriteScope: ["src/**"] }));
    const r = await createRun({
      parentThreadId: "tid",
      definitionId: "def-1",
      goal: "g",
      writeScope: ["docs/**"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.run.writeScope).toEqual(["docs/**"]);
  });

  it("createRun 保存 contextHints", async () => {
    definitions.set("def-1", def());
    const r = await createRun({
      parentThreadId: "tid",
      definitionId: "def-1",
      goal: "g",
      contextHints: ["hint-a", "hint-b"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.run.contextHints).toEqual(["hint-a", "hint-b"]);
  });
});

describe("updateRunStatus（状态机 + 终态事件）", () => {
  it("queued → running：写 startedAt，不追加事件", async () => {
    definitions.set("def-1", def());
    const created = await createRun({ parentThreadId: "tid", definitionId: "def-1", goal: "g" });
    if (!created.ok) throw new Error("create failed");
    events.length = 0;
    const updated = await updateRunStatus(created.run.id, "running");
    expect(updated?.status).toBe("running");
    expect(updated?.startedAt).toBeInstanceOf(Date);
    expect(events).toHaveLength(0);
  });

  it("running → completed：写 finishedAt + resultSummary + subagent.joined", async () => {
    definitions.set("def-1", def());
    const created = await createRun({ parentThreadId: "tid", definitionId: "def-1", goal: "g" });
    if (!created.ok) throw new Error("create failed");
    await updateRunStatus(created.run.id, "running");
    events.length = 0;
    const updated = await updateRunStatus(created.run.id, "completed", {
      resultSummary: "found 3 files",
      outputArtifactId: "art-1",
    });
    expect(updated?.status).toBe("completed");
    expect(updated?.resultSummary).toBe("found 3 files");
    expect(updated?.finishedAt).toBeInstanceOf(Date);
    expect(events.find((e) => e.type === "subagent.joined")?.payload).toMatchObject({
      runId: created.run.id,
      status: "completed",
      outputArtifactId: "art-1",
    });
  });

  it("running → failed：subagent.failed 事件", async () => {
    definitions.set("def-1", def());
    const created = await createRun({ parentThreadId: "tid", definitionId: "def-1", goal: "g" });
    if (!created.ok) throw new Error("create failed");
    await updateRunStatus(created.run.id, "running");
    events.length = 0;
    await updateRunStatus(created.run.id, "failed", { errorMessage: "timeout" });
    expect(events.find((e) => e.type === "subagent.failed")?.payload).toMatchObject({
      runId: created.run.id,
      status: "failed",
    });
  });

  it("running → timed_out：subagent.failed 事件（超时属失败）", async () => {
    definitions.set("def-1", def());
    const created = await createRun({ parentThreadId: "tid", definitionId: "def-1", goal: "g" });
    if (!created.ok) throw new Error("create failed");
    await updateRunStatus(created.run.id, "running");
    events.length = 0;
    await updateRunStatus(created.run.id, "timed_out", { errorMessage: "step limit" });
    expect(events.find((e) => e.type === "subagent.failed")).toBeTruthy();
  });

  it("非法迁移（completed → running）→ 返回 null，不改状态", async () => {
    definitions.set("def-1", def());
    const created = await createRun({ parentThreadId: "tid", definitionId: "def-1", goal: "g" });
    if (!created.ok) throw new Error("create failed");
    await updateRunStatus(created.run.id, "running");
    await updateRunStatus(created.run.id, "completed", { resultSummary: "done" });
    const bad = await updateRunStatus(created.run.id, "running");
    expect(bad).toBeNull();
    const final = await getRun(created.run.id);
    expect(final?.status).toBe("completed");
  });

  it("run 不存在 → null", async () => {
    expect(await updateRunStatus("nope", "running")).toBeNull();
  });

  it("P1-12: CAS——传 expectedStatus=读到的 status,并发改写后返回 null", async () => {
    definitions.set("def-1", def());
    const created = await createRun({ parentThreadId: "tid", definitionId: "def-1", goal: "g" });
    if (!created.ok) throw new Error("create failed");
    await updateRunStatus(created.run.id, "running");
    // 断言 updateSubagentRun 收到 expectedStatus=queued(读时的状态)
    expect(vi.mocked(queriesMock.updateSubagentRun)).toHaveBeenCalledWith(
      created.run.id,
      expect.objectContaining({ status: "running", expectedStatus: "queued" }),
    );
  });
});

describe("createDefinition / listActiveRunsByThread", () => {
  it("createDefinition 落定义 + 默认 contextPolicy 为 {}", async () => {
    const d = await createDefinition({
      name: "reviewer",
      role: "reviewer",
      allowedTools: ["readFile"],
    });
    expect(d.role).toBe("reviewer");
    expect(d.contextPolicy).toEqual({});
    expect(definitions.get(d.id)?.name).toBe("reviewer");
  });

  // S1（04-G17）：含 spawn 能力工具的定义早期拒绝
  it("createDefinition 含 spawnSubagent/joinSubagent → 抛错拒绝（嵌套深度=1）", async () => {
    await expect(
      createDefinition({
        name: "bad",
        role: "explore",
        allowedTools: ["readFile", "spawnSubagent"],
      }),
    ).rejects.toThrow(/spawn 能力工具/);
    await expect(
      createDefinition({ name: "bad2", role: "explore", allowedTools: ["joinSubagents"] }),
    ).rejects.toThrow(/spawn 能力工具/);
  });

  it("listActiveRunsByThread 只返回 queued/running", async () => {
    definitions.set("def-1", def());
    const a = await createRun({ parentThreadId: "tid", definitionId: "def-1", goal: "g" });
    const b = await createRun({ parentThreadId: "tid", definitionId: "def-1", goal: "g2" });
    if (!a.ok || !b.ok) throw new Error("create failed");
    await updateRunStatus(b.run.id, "running");
    await updateRunStatus(b.run.id, "completed", { resultSummary: "done" });
    const active = await listActiveRunsByThread("tid");
    expect(active.map((r) => r.id)).toEqual([a.run.id]);
  });
});
