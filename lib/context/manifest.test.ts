import { buildContextManifest, recordContextSnapshot } from "@/lib/context/manifest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.0 Stage C：context manifest 纯函数 + 落库编排 fail-open 测试。
 *
 * 隐私约束（§6.2）是硬验收线：manifest 不含完整 prompt、用户消息正文、完整工具输出。
 * 通过构造输入只传计数/来源，从结构上保证不泄露。
 */

const baseInput = {
  threadId: "tid",
  trigger: "chat.user_message",
  model: "kimi-k2.7-code",
  runtimeType: "host" as const,
  skill: null,
  historyCount: 3,
  visibleToolNames: ["readFile", "writeFile", "runCommand"],
};

describe("buildContextManifest 分层", () => {
  it("无 skill 时包含 system.base / history / runtime / tools / external / memory 六类来源", () => {
    const m = buildContextManifest(baseInput);
    const layers = m.layers.map((l) => `${l.layer}:${l.sourceId}`);
    expect(layers).toContain("instructions:system.base");
    expect(layers).toContain("thread:messages.history");
    expect(layers).toContain("workspace:runtime.host");
    expect(layers).toContain("toolEvidence:tools.visible");
    expect(layers).toContain("external:none");
    expect(layers).toContain("memory:none");
    // 无 skill → 不含 skill 层
    expect(layers.some((l) => l.startsWith("instructions:skill."))).toBe(false);
    expect(m.activeSkillVersionId).toBeNull();
  });

  it("有 skill 时追加 skill 层，只记 skillId/versionId/commitSha/requiredCapabilities/runtimeType", () => {
    const m = buildContextManifest({
      ...baseInput,
      skill: {
        skillId: "skill-1",
        versionId: "ver-1",
        commitSha: "abc1234",
        requiredCapabilities: ["readFile", "writeFile"],
        runtimeType: "container",
      },
    });
    const skillLayer = m.layers.find((l) => l.sourceId === "skill.ver-1");
    expect(skillLayer).toBeDefined();
    const inline = JSON.parse(skillLayer?.inline ?? "{}");
    expect(inline).toMatchObject({
      skillId: "skill-1",
      versionId: "ver-1",
      commitSha: "abc1234",
      requiredCapabilities: ["readFile", "writeFile"],
      runtimeType: "container",
    });
    expect(m.activeSkillVersionId).toBe("ver-1");
  });

  it("toolNames 只含 registry 已登记工具，过滤未知名", () => {
    const m = buildContextManifest({
      ...baseInput,
      visibleToolNames: ["readFile", "ghostTool", "writeFile"],
    });
    expect(m.toolNames).toEqual(["readFile", "writeFile"]);
  });
});

describe("buildContextManifest 隐私约束", () => {
  it("不含完整 system prompt 文本（system.base 无 inline）", () => {
    const m = buildContextManifest(baseInput);
    const sys = m.layers.find((l) => l.sourceId === "system.base");
    expect(sys?.inline).toBeUndefined();
  });

  it("thread 层只记历史消息计数，不含用户消息正文", () => {
    const m = buildContextManifest({ ...baseInput, historyCount: 7 });
    const history = m.layers.find((l) => l.sourceId === "messages.history");
    expect(history?.inline).toBe("count=7");
    // 不含任何「用户消息正文」字样
    expect(JSON.stringify(m)).not.toMatch(/用户消息正文/);
  });

  it("skill 层 inline 不含 SKILL.md 全文，仅结构化引用字段", () => {
    const m = buildContextManifest({
      ...baseInput,
      skill: {
        skillId: "s1",
        versionId: "v1",
        commitSha: "deadbeef",
        requiredCapabilities: ["readFile"],
        runtimeType: "host",
      },
    });
    const skillLayer = m.layers.find((l) => l.sourceId === "skill.v1");
    const inline = skillLayer?.inline ?? "";
    // 不含 prompt 文本占位
    expect(inline).not.toMatch(/你是助手|SKILL\.md 全文/);
    expect(JSON.parse(inline)).toMatchObject({ commitSha: "deadbeef" });
  });

  it("整体 manifest JSON 不含完整工具输出", () => {
    const m = buildContextManifest(baseInput);
    const serialized = JSON.stringify(m);
    // toolEvidence 只记工具名与 metadata，不应出现 output/stdout 字段
    expect(serialized).not.toMatch(/"output"\s*:/);
    expect(serialized).not.toMatch(/"stdout"\s*:/);
  });
});

describe("buildContextManifest checksum 与 token 估算", () => {
  it("相同输入 → checksum 稳定；工具集变化 → tools checksum 变化", () => {
    const a = buildContextManifest(baseInput);
    const b = buildContextManifest(baseInput);
    expect(a.checksums).toEqual(b.checksums);
    const c = buildContextManifest({ ...baseInput, visibleToolNames: ["readFile"] });
    expect(c.checksums.tools).not.toBe(a.checksums.tools);
  });

  it("runtime 变化 → runtime checksum 变化", () => {
    const host = buildContextManifest({ ...baseInput, runtimeType: "host" });
    const ctr = buildContextManifest({ ...baseInput, runtimeType: "container" });
    expect(host.checksums.runtime).not.toBe(ctr.checksums.runtime);
  });

  it("skill 变化 → skill checksum 变化；无 skill → 无 skill checksum", () => {
    const noSkill = buildContextManifest(baseInput);
    expect(noSkill.checksums.skill).toBeUndefined();
    const withSkill = buildContextManifest({
      ...baseInput,
      skill: { skillId: "s", versionId: "v1", commitSha: "a" },
    });
    const withSkill2 = buildContextManifest({
      ...baseInput,
      skill: { skillId: "s", versionId: "v2", commitSha: "a" },
    });
    expect(withSkill.checksums.skill).toBeDefined();
    expect(withSkill.checksums.skill).not.toBe(withSkill2.checksums.skill);
  });

  it("estimatedTokens 为各层估算之和且 > 0（有内容时）", () => {
    const m = buildContextManifest(baseInput);
    expect(m.estimatedTokens).toBeGreaterThan(0);
    const sum = m.layers.reduce((s, l) => s + l.estimatedTokens, 0);
    expect(m.estimatedTokens).toBe(sum);
  });
});

// ─── recordContextSnapshot fail-open ─────────────────────────

const queries = vi.hoisted(() => ({
  saveContextSnapshot: vi.fn(),
  appendThreadEvent: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => ({
  saveContextSnapshot: queries.saveContextSnapshot,
  appendThreadEvent: queries.appendThreadEvent,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("recordContextSnapshot fail-open", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("成功路径：构建 manifest → 写 snapshot → 追加 context.snapshot_created 事件", async () => {
    queries.saveContextSnapshot.mockResolvedValue({ id: "snap-1" });
    await recordContextSnapshot({ ...baseInput, runId: "run-1" });
    expect(queries.saveContextSnapshot).toHaveBeenCalledOnce();
    const saved = queries.saveContextSnapshot.mock.calls[0]?.[0];
    expect(saved).toMatchObject({
      threadId: "tid",
      trigger: "chat.user_message",
      model: "kimi-k2.7-code",
      runId: "run-1",
    });
    expect(queries.appendThreadEvent).toHaveBeenCalledWith(
      "tid",
      "context.snapshot_created",
      expect.objectContaining({ snapshotId: "snap-1", model: "kimi-k2.7-code" }),
      "run-1",
    );
  });

  it("saveContextSnapshot 抛错 → 不抛出、不写事件、不阻断（fail-open）", async () => {
    queries.saveContextSnapshot.mockRejectedValue(new Error("db down"));
    await expect(recordContextSnapshot(baseInput)).resolves.toBeUndefined();
    expect(queries.appendThreadEvent).not.toHaveBeenCalled();
  });

  it("appendThreadEvent 抛错 → 仍不抛出（fail-open）", async () => {
    queries.saveContextSnapshot.mockResolvedValue({ id: "snap-2" });
    queries.appendThreadEvent.mockRejectedValue(new Error("event db down"));
    await expect(recordContextSnapshot(baseInput)).resolves.toBeUndefined();
  });
});

// ─── V3.3b Stage 0：context manifest 必须与真实模型输入一致 ───

describe("buildContextManifest packageManifest 一致性 (Stage 0)", () => {
  it("未传 packageManifest → 零回归：静态 protectedRefs/excludedCandidates + compressed=false/afterTokens=null", () => {
    const m = buildContextManifest(baseInput);
    expect(m.compressed).toBe(false);
    expect(m.afterTokens).toBeNull();
    expect(m.protectedRefs).toEqual([
      { layer: "instructions", sourceId: "system.base" },
      { layer: "thread", sourceId: "messages.history" },
    ]);
    expect(m.excludedCandidates).toEqual([]);
  });

  it("传 packageManifest → protectedRefs/excludedCandidates/compressed/afterTokens 与真实装配一致", () => {
    const m = buildContextManifest({
      ...baseInput,
      packageManifest: {
        compressed: true,
        beforeTokens: 9000,
        afterTokens: 3000,
        protectedRefs: [
          { kind: "latest_user", messageIds: ["m9"], reason: "最新用户指令（永不压缩）" },
          { kind: "pinned_fact", messageIds: [], reason: "1 条 pinned facts 保留" },
        ],
        excludedCandidates: [{ kind: "memory", reason: "预算裁剪" }],
        appliedSummaryIds: ["sum-1"],
      },
    });
    expect(m.compressed).toBe(true);
    expect(m.afterTokens).toBe(3000);
    expect(m.protectedRefs).toEqual([
      { layer: "thread", sourceId: "latest_user", reason: "最新用户指令（永不压缩）" },
      { layer: "thread", sourceId: "pinned_fact", reason: "1 条 pinned facts 保留" },
    ]);
    // excludedCandidates 必须记录真实裁剪原因（kind=memory → memory 层）
    expect(m.excludedCandidates).toEqual([
      { layer: "memory", sourceId: "memory", reason: "预算裁剪" },
    ]);
  });

  it("excludedCandidate 非 memory kind → 归 thread 层（真实原因透传）", () => {
    const m = buildContextManifest({
      ...baseInput,
      packageManifest: {
        compressed: false,
        beforeTokens: 0,
        afterTokens: 0,
        protectedRefs: [],
        excludedCandidates: [{ kind: "toolRun", reason: "预算裁剪" }],
        appliedSummaryIds: [],
      },
    });
    expect(m.excludedCandidates[0]).toMatchObject({
      layer: "thread",
      sourceId: "toolRun",
      reason: "预算裁剪",
    });
  });

  it("recordContextSnapshot 透传 compressed/afterTokens 到 saveContextSnapshot", async () => {
    const input = {
      ...baseInput,
      packageManifest: {
        compressed: true,
        beforeTokens: 9000,
        afterTokens: 3000,
        protectedRefs: [{ kind: "latest_user", messageIds: ["m9"], reason: "r" }],
        excludedCandidates: [{ kind: "memory", reason: "预算裁剪" }],
        appliedSummaryIds: ["sum-1"],
      },
    };
    expect(buildContextManifest(input).compressed).toBe(true);
    queries.saveContextSnapshot.mockClear();
    queries.saveContextSnapshot.mockResolvedValue({ id: "snap-pm" });
    await recordContextSnapshot(input);
    const saved = queries.saveContextSnapshot.mock.calls.at(-1)?.[0];
    expect(saved).toMatchObject({ compressed: true, afterTokens: 3000 });
    expect(saved.protectedRefs).toEqual([
      { layer: "thread", sourceId: "latest_user", reason: "r" },
    ]);
    expect(saved.excludedCandidates).toEqual([
      { layer: "memory", sourceId: "memory", reason: "预算裁剪" },
    ]);
  });
});

// ─── V3.4 Stage A：external manifest layer 填实（零回归） ───

describe("buildContextManifest external layer (V3.4)", () => {
  it("无 externalSources → 零回归：external 层 sourceId='none'、无 inline", () => {
    const m = buildContextManifest(baseInput);
    const ext = m.layers.find((l) => l.layer === "external");
    expect(ext).toBeDefined();
    expect(ext?.sourceId).toBe("none");
    expect(ext?.inline).toBeUndefined();
    expect(ext?.estimatedTokens).toBe(0);
  });

  it("有 externalSources → external 层 sourceId='external.fetch'，inline 记 sourceUrl#contentHash", () => {
    const m = buildContextManifest({
      ...baseInput,
      externalSources: [
        {
          sourceUrl: "https://react.dev/learn",
          contentHash: "abc123",
          fetchedAt: "2026-06-23T00:00:00Z",
        },
        { sourceUrl: "https://example.com/api", contentHash: "def456" },
      ],
    });
    const ext = m.layers.find((l) => l.layer === "external");
    expect(ext?.sourceId).toBe("external.fetch");
    expect(ext?.inline).toBe("https://react.dev/learn#abc123,https://example.com/api#def456");
    expect(ext?.estimatedTokens).toBeGreaterThan(0);
  });

  it("externalSources 空数组 → 零回归（仍 sourceId='none'）", () => {
    const m = buildContextManifest({ ...baseInput, externalSources: [] });
    const ext = m.layers.find((l) => l.layer === "external");
    expect(ext?.sourceId).toBe("none");
  });

  it("external 层只记来源摘要，不含原文正文", () => {
    const m = buildContextManifest({
      ...baseInput,
      externalSources: [{ sourceUrl: "https://x.com/page", contentHash: "h" }],
    });
    const serialized = JSON.stringify(m);
    // 不应塞入完整页面正文
    expect(serialized).not.toMatch(/<html|<body|页面正文/);
  });
});

describe("buildContextManifest memory layer 可观测字段", () => {
  it("有 memories 时 inline 包含 id/scope/kind/score/reason/status", () => {
    const m = buildContextManifest({
      ...baseInput,
      memories: [
        {
          id: "m1",
          scope: "user",
          kind: "convention",
          textHash: "abc",
          retrievalScore: 0.95,
          retrievalReason: "rerank",
          semanticStatus: "ready",
        },
        {
          id: "m2",
          scope: "thread",
          kind: "fact",
          retrievalScore: 0.4,
          retrievalReason: "lexical",
          semanticStatus: "disabled",
        },
      ],
    });
    const memLayer = m.layers.find((l) => l.layer === "memory");
    expect(memLayer?.sourceId).toBe("memory.store");
    expect(memLayer?.inline).toContain("m1:user:convention:0.95:rerank:ready");
    expect(memLayer?.inline).toContain("m2:thread:fact:0.4:lexical:disabled");
  });

  it("memories 为空数组 → 零回归 sourceId='none'", () => {
    const m = buildContextManifest({ ...baseInput, memories: [] });
    const memLayer = m.layers.find((l) => l.layer === "memory");
    expect(memLayer?.sourceId).toBe("none");
  });
});

// ─── V8 Skill Run Resolver：ContextSnapshot 记录 Resolver 输入/输出 ───

describe("buildContextManifest V8 Skill Resolver 证据", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("传 skillResolverInput → 透传到 saveContextSnapshot（不含完整 SKILL.md）", async () => {
    queries.saveContextSnapshot.mockResolvedValue({ id: "snap-v8-1" });
    await recordContextSnapshot({
      ...baseInput,
      skillResolverInput: {
        availableSkillCount: 5,
        uiSelectedSkillIds: ["skill-a", "skill-b"],
      },
      skillResolverOutput: null,
    });
    const saved = queries.saveContextSnapshot.mock.calls[0]?.[0];
    expect(saved.skillResolverInput).toEqual({
      availableSkillCount: 5,
      uiSelectedSkillIds: ["skill-a", "skill-b"],
    });
    expect(saved.skillResolverOutput).toBeNull();
  });

  it("传 skillResolverOutput → 透传 selectedSkillVersions 摘要 + decisionReason + ignored", async () => {
    queries.saveContextSnapshot.mockResolvedValue({ id: "snap-v8-2" });
    await recordContextSnapshot({
      ...baseInput,
      skillResolverInput: { availableSkillCount: 3, uiSelectedSkillIds: [] },
      skillResolverOutput: {
        selectedSkillVersions: [
          { skillId: "s1", skillVersionId: "v1", role: "primary", source: "resolver" },
        ],
        decisionReason: "关键词匹配命中",
        ignoredUiSelectedSkillIds: ["skill-x"],
      },
    });
    const saved = queries.saveContextSnapshot.mock.calls[0]?.[0];
    expect(saved.skillResolverOutput).toEqual({
      selectedSkillVersions: [
        { skillId: "s1", skillVersionId: "v1", role: "primary", source: "resolver" },
      ],
      decisionReason: "关键词匹配命中",
      ignoredUiSelectedSkillIds: ["skill-x"],
    });
  });

  it("未传 skillResolverInput/Output → saveContextSnapshot 收到 undefined/null（零回归）", async () => {
    queries.saveContextSnapshot.mockResolvedValue({ id: "snap-v8-3" });
    await recordContextSnapshot(baseInput);
    const saved = queries.saveContextSnapshot.mock.calls[0]?.[0];
    expect(saved.skillResolverInput).toBeUndefined();
    expect(saved.skillResolverOutput).toBeNull();
  });

  it("skillResolverOutput 为空 selectedSkillVersions（基础 agent）→ 透传空数组", async () => {
    queries.saveContextSnapshot.mockResolvedValue({ id: "snap-v8-4" });
    await recordContextSnapshot({
      ...baseInput,
      skillResolverInput: { availableSkillCount: 0, uiSelectedSkillIds: [] },
      skillResolverOutput: {
        selectedSkillVersions: [],
        decisionReason: "无匹配 Skill，使用基础 agent",
        ignoredUiSelectedSkillIds: [],
      },
    });
    const saved = queries.saveContextSnapshot.mock.calls[0]?.[0];
    expect(saved.skillResolverOutput.selectedSkillVersions).toEqual([]);
    expect(saved.skillResolverOutput.decisionReason).toContain("基础 agent");
  });
});
