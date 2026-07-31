import { describe, expect, it } from "vitest";
import {
  contextSnapshotChecksumsSchema,
  contextSnapshotLayersSchema,
  contextSnapshotSkillLoadEvidenceSchema,
  contextSnapshotSkillResolverInputSchema,
  contextSnapshotSkillResolverOutputSchema,
  customToolExecutorConfigSchema,
  customToolInputSchemaSchema,
  memoryProvenanceSchema,
  threadPinnedFactsSchema,
  toolRunInputSchema,
  toolRunOutputSchema,
  validateJsonColumn,
} from "./json-columns";

/**
 * S1（08-P2-3）：json 列 zod 校验 schema 单测。
 *
 * 覆盖每个 schema 的合法 / 非法用例，确保 fail-closed（脏数据抛错不落库）。
 */

describe("toolRunInputSchema / toolRunOutputSchema", () => {
  it("合法：对象 → 通过", () => {
    expect(() => validateJsonColumn({ path: "x" }, toolRunInputSchema, "input")).not.toThrow();
    expect(() => validateJsonColumn({ ok: true }, toolRunOutputSchema, "output")).not.toThrow();
  });

  it("非法：数组 → 抛错", () => {
    expect(() => validateJsonColumn([], toolRunInputSchema, "input")).toThrow(/json-column:input/);
  });

  it("非法：null → 抛错", () => {
    expect(() => validateJsonColumn(null, toolRunInputSchema, "input")).toThrow(
      /json-column:input/,
    );
  });

  it("非法：原始值 → 抛错", () => {
    expect(() => validateJsonColumn("str", toolRunInputSchema, "input")).toThrow(
      /json-column:input/,
    );
  });
});

describe("customToolInputSchemaSchema", () => {
  it("合法：含 type 字段 → 通过", () => {
    expect(() =>
      validateJsonColumn({ type: "object" }, customToolInputSchemaSchema, "inputSchema"),
    ).not.toThrow();
  });

  it("合法：无 type 但有其他字段 → 通过（passthrough）", () => {
    expect(() =>
      validateJsonColumn({ properties: {} }, customToolInputSchemaSchema, "inputSchema"),
    ).not.toThrow();
  });

  it("非法：数组 → 抛错", () => {
    expect(() => validateJsonColumn([], customToolInputSchemaSchema, "inputSchema")).toThrow(
      /json-column:inputSchema/,
    );
  });
});

describe("customToolExecutorConfigSchema", () => {
  it("合法：对象 → 通过", () => {
    expect(() =>
      validateJsonColumn({ url: "https://x" }, customToolExecutorConfigSchema, "executorConfig"),
    ).not.toThrow();
  });

  it("非法：数组 → 抛错", () => {
    expect(() => validateJsonColumn([], customToolExecutorConfigSchema, "executorConfig")).toThrow(
      /json-column:executorConfig/,
    );
  });
});

describe("contextSnapshotLayersSchema", () => {
  it("合法：对象数组 → 通过", () => {
    expect(() =>
      validateJsonColumn([{ layer: "x" }], contextSnapshotLayersSchema, "layers"),
    ).not.toThrow();
  });

  it("合法：空数组 → 通过", () => {
    expect(() => validateJsonColumn([], contextSnapshotLayersSchema, "layers")).not.toThrow();
  });

  it("非法：对象（非数组）→ 抛错", () => {
    expect(() =>
      validateJsonColumn({ not: "array" }, contextSnapshotLayersSchema, "layers"),
    ).toThrow(/json-column:layers/);
  });
});

describe("contextSnapshotChecksumsSchema", () => {
  it("合法：string→string map → 通过", () => {
    expect(() =>
      validateJsonColumn({ tools: "abc" }, contextSnapshotChecksumsSchema, "checksums"),
    ).not.toThrow();
  });

  it("非法：值为 number → 抛错", () => {
    expect(() =>
      validateJsonColumn(
        { tools: 123 } as unknown as Record<string, string>,
        contextSnapshotChecksumsSchema,
        "checksums",
      ),
    ).toThrow(/json-column:checksums/);
  });
});

// ─── V8 Skill Run Resolver 证据字段校验 ───

describe("contextSnapshotSkillResolverInputSchema", () => {
  it("合法：含 availableSkillCount + uiSelectedSkillIds → 通过", () => {
    expect(() =>
      validateJsonColumn(
        { availableSkillCount: 5, uiSelectedSkillIds: ["s1"] },
        contextSnapshotSkillResolverInputSchema,
        "skillResolverInput",
      ),
    ).not.toThrow();
  });

  it("合法：空对象 → 通过（passthrough，零回归）", () => {
    expect(() =>
      validateJsonColumn({}, contextSnapshotSkillResolverInputSchema, "skillResolverInput"),
    ).not.toThrow();
  });

  it("非法：数组 → 抛错", () => {
    expect(() =>
      validateJsonColumn([], contextSnapshotSkillResolverInputSchema, "skillResolverInput"),
    ).toThrow(/json-column:skillResolverInput/);
  });
});

describe("contextSnapshotSkillResolverOutputSchema", () => {
  it("合法：含 decisionReason + selectedSkillVersions → 通过", () => {
    expect(() =>
      validateJsonColumn(
        {
          decisionReason: "关键词命中",
          selectedSkillVersions: [{ skillId: "s1", skillVersionId: "v1" }],
          ignoredUiSelectedSkillIds: [],
        },
        contextSnapshotSkillResolverOutputSchema,
        "skillResolverOutput",
      ),
    ).not.toThrow();
  });

  it("非法：null → 抛错", () => {
    expect(() =>
      validateJsonColumn(null, contextSnapshotSkillResolverOutputSchema, "skillResolverOutput"),
    ).toThrow(/json-column:skillResolverOutput/);
  });
});

describe("contextSnapshotSkillLoadEvidenceSchema", () => {
  it("合法：证据条目数组 → 通过", () => {
    expect(() =>
      validateJsonColumn(
        [{ path: "SKILL.md", contentHash: "abc123", truncated: false, skillVersionId: "v1" }],
        contextSnapshotSkillLoadEvidenceSchema,
        "skillLoadEvidence",
      ),
    ).not.toThrow();
  });

  it("合法：空数组 → 通过（无读取）", () => {
    expect(() =>
      validateJsonColumn([], contextSnapshotSkillLoadEvidenceSchema, "skillLoadEvidence"),
    ).not.toThrow();
  });

  it("非法：对象（非数组）→ 抛错", () => {
    expect(() =>
      validateJsonColumn(
        { path: "x" },
        contextSnapshotSkillLoadEvidenceSchema,
        "skillLoadEvidence",
      ),
    ).toThrow(/json-column:skillLoadEvidence/);
  });
});

describe("threadPinnedFactsSchema", () => {
  it("合法：字符串数组 → 通过", () => {
    expect(() =>
      validateJsonColumn(["fact-1"], threadPinnedFactsSchema, "pinnedFacts"),
    ).not.toThrow();
  });

  it("合法：null（清空）→ 通过", () => {
    expect(() => validateJsonColumn(null, threadPinnedFactsSchema, "pinnedFacts")).not.toThrow();
  });

  it("非法：非字符串元素 → 抛错", () => {
    expect(() =>
      validateJsonColumn([123] as unknown as string[], threadPinnedFactsSchema, "pinnedFacts"),
    ).toThrow(/json-column:pinnedFacts/);
  });

  it("非法：对象（非数组非 null）→ 抛错", () => {
    expect(() =>
      validateJsonColumn({ not: "array" }, threadPinnedFactsSchema, "pinnedFacts"),
    ).toThrow(/json-column:pinnedFacts/);
  });
});

describe("memoryProvenanceSchema", () => {
  it("合法：非空来源数组 → 通过", () => {
    expect(() =>
      validateJsonColumn([{ kind: "user", refId: "u1" }], memoryProvenanceSchema, "provenance"),
    ).not.toThrow();
  });

  it("合法：带可选字段 → 通过", () => {
    expect(() =>
      validateJsonColumn(
        [{ kind: "tool_run", refId: "tr1", threadId: "t1", summary: "s" }],
        memoryProvenanceSchema,
        "provenance",
      ),
    ).not.toThrow();
  });

  it("非法：空数组 → 抛错（防孤儿记忆）", () => {
    expect(() => validateJsonColumn([], memoryProvenanceSchema, "provenance")).toThrow(
      /json-column:provenance/,
    );
  });

  it("非法：缺 refId → 抛错", () => {
    expect(() =>
      validateJsonColumn(
        [{ kind: "user" }] as unknown as { kind: "user"; refId: string }[],
        memoryProvenanceSchema,
        "provenance",
      ),
    ).toThrow(/json-column:provenance/);
  });

  it("非法：非法 kind 值 → 抛错", () => {
    expect(() =>
      validateJsonColumn(
        [{ kind: "bogus", refId: "u1" }] as unknown as { kind: "user"; refId: string }[],
        memoryProvenanceSchema,
        "provenance",
      ),
    ).toThrow(/json-column:provenance/);
  });
});
