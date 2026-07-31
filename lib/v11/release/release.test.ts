import {
  InMemoryIncidentActionProvider,
  InMemoryMetricCollector,
  ObservationWindowTracker,
  assertObservationWindowGate,
  createPassingCollectors,
  formatObservationWindowReport,
} from "@/lib/v11/release/observation-window";
import {
  assertRunbookGate,
  buildOperationsRunbook,
  formatRunbookSummary,
  validateRunbook,
} from "@/lib/v11/release/operations-runbook";
import {
  ALL_OBSERVATION_METRIC_CATEGORIES,
  type ArtifactDescriptor,
  type ConfigEntry,
  IncidentOperationError,
  type MigrationBatchRecord,
  ObservationWindowGateError,
  RUNBOOK_FORBIDDEN_KEYWORDS,
  ReleaseRecordGateError,
  type RollbackPointDescriptor,
  RunbookGateError,
  type RunbookSection,
  V11_SCHEME_VERSION,
} from "@/lib/v11/release/release-contract";
import {
  type ReleaseRecordInput,
  assertReleaseRecordGate,
  buildReleaseRecord,
  formatReleaseRecord,
  validateReleaseRecord,
} from "@/lib/v11/release/release-record";
/**
 * S13-W08 发布、值守与移交集成测试。
 *
 * 覆盖：
 * - 发布记录：构建 + 门禁校验 + 格式化 + 缺失字段检测 + failed 批次检测
 * - 观察窗口：9 类指标采集 + 异常检测 + 事故处置 + 数据库终态约束 + 报告 + 门禁
 * - 运维手册：构建 + 禁止关键词检测 + 门禁 + 格式化
 */
import { beforeEach, describe, expect, it } from "vitest";

// ═══════════════════════════════════════════════════════════
// 测试夹具
// ═══════════════════════════════════════════════════════════

/** 构造完整的发布记录输入。 */
function createCompleteReleaseInput(): ReleaseRecordInput {
  const artifacts: ArtifactDescriptor[] = [
    { name: "snow-harness-api", version: "11.0.0", type: "image", digest: "sha256:abc123" },
    { name: "snow-harness-runtime", version: "11.0.0", type: "image", digest: "sha256:def456" },
  ];
  const batches: MigrationBatchRecord[] = [
    {
      batchId: "batch-001",
      domain: "identity",
      recordCount: 100,
      status: "completed",
      completedAt: "2026-07-23T10:00:00.000Z",
    },
    {
      batchId: "batch-002",
      domain: "conversation",
      recordCount: 500,
      status: "completed",
      completedAt: "2026-07-23T11:00:00.000Z",
    },
  ];
  const config: ConfigEntry[] = [
    { key: "DATABASE_URL", value: "mysql://***", sensitive: true },
    { key: "RUNTIME_ENDPOINT", value: "https://runtime.internal", sensitive: false },
  ];
  const rollbackPoint: RollbackPointDescriptor = {
    location: "backup-2026-07-23",
    triggerConditions: ["API 错误率 > 5%", "切换后 24h 内严重事故"],
    owner: "rollback-owner-1",
    createdAt: "2026-07-23T09:00:00.000Z",
  };
  return {
    artifactSummary: artifacts,
    migrationBatches: batches,
    configSnapshot: config,
    knownLimitations: ["Memory 候选审核需人工介入"],
    rollbackPoint,
    owner: "release-owner-1",
    oncallRoster: ["oncall-1", "oncall-2"],
    releaseNotes: "V11 正式发布，切换已完成。",
  };
}

/** 构造标准运维手册章节。 */
function createStandardRunbookSections(): RunbookSection[] {
  return [
    {
      title: "系统概览",
      content: "V11 是当前可运行的 AgentKit 平台版本，包含 Thread/Turn/Item 模型。",
      order: 1,
    },
    {
      title: "启动与停止",
      content: "使用 `pnpm start` 启动 V11 服务，`pnpm stop` 停止。",
      order: 3,
    },
    {
      title: "健康检查",
      content: "访问 `/health` 端点检查服务状态，返回 200 表示健康。",
      order: 4,
    },
    {
      title: "事故响应",
      content: "发生事故时按隔离→限流→切换流程处置，不以修改数据库终态作为恢复手段。",
      order: 9,
    },
  ];
}

// ═══════════════════════════════════════════════════════════
// 1. 发布记录
// ═══════════════════════════════════════════════════════════

describe("S13-W08 发布记录", () => {
  it("buildReleaseRecord 构建完整记录", () => {
    const input = createCompleteReleaseInput();
    const record = buildReleaseRecord(input);

    expect(record.schemeVersion).toBe(V11_SCHEME_VERSION);
    expect(record.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.artifactSummary).toHaveLength(2);
    expect(record.migrationBatches).toHaveLength(2);
    expect(record.owner).toBe("release-owner-1");
    expect(record.oncallRoster).toHaveLength(2);
    expect(record.rollbackPoint.location).toBe("backup-2026-07-23");
  });

  it("validateReleaseRecord 完整记录通过门禁", () => {
    const record = buildReleaseRecord(createCompleteReleaseInput());
    const result = validateReleaseRecord(record);
    expect(result.passed).toBe(true);
    expect(result.missingFields).toHaveLength(0);
  });

  it("validateReleaseRecord 制品摘要为空时失败", () => {
    const input = createCompleteReleaseInput();
    const record = buildReleaseRecord({ ...input, artifactSummary: [] });
    const result = validateReleaseRecord(record);
    expect(result.passed).toBe(false);
    expect(result.missingFields).toContain("artifactSummary");
  });

  it("validateReleaseRecord 迁移批次为空时失败", () => {
    const input = createCompleteReleaseInput();
    const record = buildReleaseRecord({ ...input, migrationBatches: [] });
    const result = validateReleaseRecord(record);
    expect(result.passed).toBe(false);
    expect(result.missingFields).toContain("migrationBatches");
  });

  it("validateReleaseRecord 负责人为空时失败", () => {
    const input = createCompleteReleaseInput();
    const record = buildReleaseRecord({ ...input, owner: "" });
    const result = validateReleaseRecord(record);
    expect(result.passed).toBe(false);
    expect(result.missingFields).toContain("owner");
  });

  it("validateReleaseRecord 值守名单为空时失败", () => {
    const input = createCompleteReleaseInput();
    const record = buildReleaseRecord({ ...input, oncallRoster: [] });
    const result = validateReleaseRecord(record);
    expect(result.passed).toBe(false);
    expect(result.missingFields).toContain("oncallRoster");
  });

  it("validateReleaseRecord 回滚点位置为空时失败", () => {
    const input = createCompleteReleaseInput();
    const record = buildReleaseRecord({
      ...input,
      rollbackPoint: { ...input.rollbackPoint, location: "" },
    });
    const result = validateReleaseRecord(record);
    expect(result.passed).toBe(false);
    expect(result.missingFields).toContain("rollbackPoint.location");
  });

  it("validateReleaseRecord failed 批次标记为缺失", () => {
    const input = createCompleteReleaseInput();
    const failedBatch: MigrationBatchRecord = {
      batchId: "batch-003",
      domain: "memory",
      recordCount: 50,
      status: "failed",
      completedAt: "2026-07-23T12:00:00.000Z",
    };
    const record = buildReleaseRecord({
      ...input,
      migrationBatches: [...input.migrationBatches, failedBatch],
    });
    const result = validateReleaseRecord(record);
    expect(result.passed).toBe(false);
    expect(result.missingFields.some((f) => f.includes("batch-003"))).toBe(true);
  });

  it("validateReleaseRecord 制品摘要不完整时失败", () => {
    const input = createCompleteReleaseInput();
    const incompleteArtifact: ArtifactDescriptor = {
      name: "incomplete",
      version: "",
      type: "image",
      digest: "",
    };
    const record = buildReleaseRecord({
      ...input,
      artifactSummary: [...input.artifactSummary, incompleteArtifact],
    });
    const result = validateReleaseRecord(record);
    expect(result.passed).toBe(false);
    expect(result.missingFields.some((f) => f.includes("incomplete"))).toBe(true);
  });

  it("assertReleaseRecordGate 通过时不抛错", () => {
    const record = buildReleaseRecord(createCompleteReleaseInput());
    expect(() => assertReleaseRecordGate(record)).not.toThrow();
  });

  it("assertReleaseRecordGate 失败时抛 ReleaseRecordGateError", () => {
    const input = createCompleteReleaseInput();
    const record = buildReleaseRecord({ ...input, owner: "" });
    try {
      assertReleaseRecordGate(record);
      expect.unreachable("应抛 ReleaseRecordGateError");
    } catch (err) {
      expect(err).toBeInstanceOf(ReleaseRecordGateError);
      expect((err as ReleaseRecordGateError).missingFields).toContain("owner");
    }
  });

  it("formatReleaseRecord 生成可读字符串", () => {
    const record = buildReleaseRecord(createCompleteReleaseInput());
    const text = formatReleaseRecord(record);
    expect(text).toContain("V11 发布记录");
    expect(text).toContain(`方案版本：${V11_SCHEME_VERSION}`);
    expect(text).toContain("负责人：release-owner-1");
    expect(text).toContain("制品摘要");
    expect(text).toContain("snow-harness-api@11.0.0");
    expect(text).toContain("迁移批次");
    expect(text).toContain("回滚点");
    expect(text).toContain("已知限制");
    // 敏感配置应脱敏
    expect(text).toContain("***（脱敏）");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. 观察窗口
// ═══════════════════════════════════════════════════════════

describe("S13-W08 观察窗口", () => {
  let collectors: ReturnType<typeof createPassingCollectors>;
  let actionProvider: InMemoryIncidentActionProvider;

  beforeEach(() => {
    collectors = createPassingCollectors();
    actionProvider = new InMemoryIncidentActionProvider();
  });

  it("9 类指标类别全部定义", () => {
    expect(ALL_OBSERVATION_METRIC_CATEGORIES).toHaveLength(9);
    expect(ALL_OBSERVATION_METRIC_CATEGORIES).toContain("api");
    expect(ALL_OBSERVATION_METRIC_CATEGORIES).toContain("sse");
    expect(ALL_OBSERVATION_METRIC_CATEGORIES).toContain("invocation");
    expect(ALL_OBSERVATION_METRIC_CATEGORIES).toContain("unknown_effect");
    expect(ALL_OBSERVATION_METRIC_CATEGORIES).toContain("job");
    expect(ALL_OBSERVATION_METRIC_CATEGORIES).toContain("desktop");
    expect(ALL_OBSERVATION_METRIC_CATEGORIES).toContain("trace");
    expect(ALL_OBSERVATION_METRIC_CATEGORIES).toContain("cost_capacity");
    expect(ALL_OBSERVATION_METRIC_CATEGORIES).toContain("security_alert");
  });

  it("全部指标正常时报告通过", async () => {
    const tracker = new ObservationWindowTracker(collectors, actionProvider, {
      windowStart: "2026-07-23T00:00:00.000Z",
      windowEnd: "2026-07-23T23:59:59.000Z",
      operator: "oncall-1",
    });
    const report = await tracker.track();

    expect(report.passed).toBe(true);
    expect(report.anomalousCount).toBe(0);
    expect(report.unresolvedCount).toBe(0);
    // 每个类别至少 1 个样本
    expect(report.samples.length).toBeGreaterThanOrEqual(9);
  });

  it("异常指标被正确检测", async () => {
    (collectors.api as InMemoryMetricCollector).addAnomalousSample(
      "api",
      "api.error_rate",
      10,
      "%",
      "错误率超阈值",
    );
    const tracker = new ObservationWindowTracker(collectors, actionProvider, {
      windowStart: "2026-07-23T00:00:00.000Z",
      windowEnd: "2026-07-23T23:59:59.000Z",
      operator: "oncall-1",
    });
    const report = await tracker.track();

    expect(report.anomalousCount).toBe(1);
    const apiSummary = report.categorySummaries.find((c) => c.category === "api");
    expect(apiSummary?.anomalousCount).toBe(1);
  });

  it("异常指标处置成功后报告通过", async () => {
    (collectors.api as InMemoryMetricCollector).addAnomalousSample(
      "api",
      "api.error_rate",
      10,
      "%",
      "错误率超阈值",
    );
    actionProvider.setShouldResolve(true);
    const tracker = new ObservationWindowTracker(collectors, actionProvider, {
      windowStart: "2026-07-23T00:00:00.000Z",
      windowEnd: "2026-07-23T23:59:59.000Z",
      operator: "oncall-1",
    });
    const report = await tracker.track();

    expect(report.passed).toBe(true);
    expect(report.resolvedCount).toBe(1);
    expect(report.unresolvedCount).toBe(0);
    expect(report.incidentOperations).toHaveLength(1);
    expect(report.incidentOperations[0]?.resolved).toBe(true);
    expect(report.incidentOperations[0]?.modifiesDatabaseTerminalState).toBe(false);
  });

  it("异常指标处置失败后报告不通过", async () => {
    (collectors.api as InMemoryMetricCollector).addAnomalousSample(
      "api",
      "api.error_rate",
      10,
      "%",
      "错误率超阈值",
    );
    actionProvider.setShouldResolve(false);
    const tracker = new ObservationWindowTracker(collectors, actionProvider, {
      windowStart: "2026-07-23T00:00:00.000Z",
      windowEnd: "2026-07-23T23:59:59.000Z",
      operator: "oncall-1",
    });
    const report = await tracker.track();

    expect(report.passed).toBe(false);
    expect(report.unresolvedCount).toBe(1);
  });

  it("违反数据库终态约束时记录为未处置异常", async () => {
    (collectors.api as InMemoryMetricCollector).addAnomalousSample(
      "api",
      "api.error_rate",
      10,
      "%",
      "错误率超阈值",
    );
    actionProvider.setShouldViolateDbConstraint(true);
    const tracker = new ObservationWindowTracker(collectors, actionProvider, {
      windowStart: "2026-07-23T00:00:00.000Z",
      windowEnd: "2026-07-23T23:59:59.000Z",
      operator: "oncall-1",
    });
    const report = await tracker.track();

    expect(report.passed).toBe(false);
    const incident = report.incidentOperations[0];
    expect(incident?.resolved).toBe(false);
    expect(incident?.details).toContain("违反约束");
  });

  it("采集异常本身被记录为异常指标", async () => {
    const throwingCollector: typeof collectors.api = {
      collect: async () => {
        throw new Error("采集服务不可用");
      },
    };
    const throwingCollectors = { ...collectors, api: throwingCollector };
    const tracker = new ObservationWindowTracker(throwingCollectors, actionProvider, {
      windowStart: "2026-07-23T00:00:00.000Z",
      windowEnd: "2026-07-23T23:59:59.000Z",
      operator: "oncall-1",
    });
    const report = await tracker.track();

    const apiErrorSample = report.samples.find((s) => s.name === "api.collection_error");
    expect(apiErrorSample?.anomalous).toBe(true);
    expect(apiErrorSample?.details).toContain("采集服务不可用");
  });

  it("assertObservationWindowGate 通过时不抛错", async () => {
    const tracker = new ObservationWindowTracker(collectors, actionProvider, {
      windowStart: "2026-07-23T00:00:00.000Z",
      windowEnd: "2026-07-23T23:59:59.000Z",
      operator: "oncall-1",
    });
    const report = await tracker.track();
    expect(() => assertObservationWindowGate(report)).not.toThrow();
  });

  it("assertObservationWindowGate 失败时抛 ObservationWindowGateError", async () => {
    (collectors.api as InMemoryMetricCollector).addAnomalousSample(
      "api",
      "api.error_rate",
      10,
      "%",
      "错误率超阈值",
    );
    actionProvider.setShouldResolve(false);
    const tracker = new ObservationWindowTracker(collectors, actionProvider, {
      windowStart: "2026-07-23T00:00:00.000Z",
      windowEnd: "2026-07-23T23:59:59.000Z",
      operator: "oncall-1",
    });
    const report = await tracker.track();

    try {
      assertObservationWindowGate(report);
      expect.unreachable("应抛 ObservationWindowGateError");
    } catch (err) {
      expect(err).toBeInstanceOf(ObservationWindowGateError);
      expect((err as ObservationWindowGateError).unresolvedAnomalies.length).toBeGreaterThan(0);
    }
  });

  it("formatObservationWindowReport 生成可读字符串", async () => {
    const tracker = new ObservationWindowTracker(collectors, actionProvider, {
      windowStart: "2026-07-23T00:00:00.000Z",
      windowEnd: "2026-07-23T23:59:59.000Z",
      operator: "oncall-1",
    });
    const report = await tracker.track();
    const text = formatObservationWindowReport(report);

    expect(text).toContain("V11 观察窗口报告");
    expect(text).toContain("总体结果：PASSED");
    expect(text).toContain("按类别汇总");
    expect(text).toContain("api");
  });

  it("IncidentOperationError 携带 incidentId 与 violation", () => {
    const err = new IncidentOperationError("测试", "incident-1", "modifiesDb=true");
    expect(err.name).toBe("IncidentOperationError");
    expect(err.incidentId).toBe("incident-1");
    expect(err.violation).toBe("modifiesDb=true");
  });

  it("InMemoryMetricCollector 支持添加正常与异常样本", async () => {
    const collector = new InMemoryMetricCollector();
    collector.addNormalSample("api", "api.latency", 50, "ms");
    collector.addAnomalousSample("api", "api.error_rate", 10, "%", "超阈值");
    const samples = await collector.collect();
    expect(samples).toHaveLength(2);
    expect(samples[0]?.anomalous).toBe(false);
    expect(samples[1]?.anomalous).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 运维手册
// ═══════════════════════════════════════════════════════════

describe("S13-W08 运维手册", () => {
  it("RUNBOOK_FORBIDDEN_KEYWORDS 包含旧路径与未来设想关键词", () => {
    expect(RUNBOOK_FORBIDDEN_KEYWORDS.length).toBeGreaterThan(0);
    expect(RUNBOOK_FORBIDDEN_KEYWORDS).toContain("旧 API");
    expect(RUNBOOK_FORBIDDEN_KEYWORDS).toContain("双轨");
    expect(RUNBOOK_FORBIDDEN_KEYWORDS).toContain("TODO");
    expect(RUNBOOK_FORBIDDEN_KEYWORDS).toContain("未来版本");
  });

  it("buildOperationsRunbook 构建完整手册", () => {
    const sections = createStandardRunbookSections();
    const runbook = buildOperationsRunbook({ sections });

    expect(runbook.version).toBe(V11_SCHEME_VERSION);
    expect(runbook.scope).toContain("V11");
    expect(runbook.sections).toHaveLength(4);
    expect(runbook.markdown).toContain("# V11 运维手册");
    expect(runbook.markdown).toContain("系统概览");
  });

  it("validateRunbook 正常手册通过门禁", () => {
    const runbook = buildOperationsRunbook({
      sections: createStandardRunbookSections(),
    });
    const result = validateRunbook(runbook);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("validateRunbook 包含旧路径关键词时失败", () => {
    const sections: RunbookSection[] = [
      {
        title: "系统概览",
        content: "V11 替代了旧 API 和 Message 表，是当前可运行版本。",
        order: 1,
      },
    ];
    const runbook = buildOperationsRunbook({ sections });
    const result = validateRunbook(runbook);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("旧 API"))).toBe(true);
    expect(result.violations.some((v) => v.includes("Message 表"))).toBe(true);
  });

  it("validateRunbook 包含未来设想关键词时失败", () => {
    const sections: RunbookSection[] = [
      {
        title: "系统概览",
        content: "V11 是当前版本，TODO 待实现功能将在未来版本推出。",
        order: 1,
      },
    ];
    const runbook = buildOperationsRunbook({ sections });
    const result = validateRunbook(runbook);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("TODO"))).toBe(true);
    expect(result.violations.some((v) => v.includes("未来版本"))).toBe(true);
  });

  it("validateRunbook 适用范围不含 V11 时失败", () => {
    const runbook = buildOperationsRunbook({
      sections: createStandardRunbookSections(),
      scope: "旧系统运维",
    });
    const result = validateRunbook(runbook);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("V11"))).toBe(true);
  });

  it("validateRunbook 无章节时失败", () => {
    const runbook = buildOperationsRunbook({ sections: [] });
    const result = validateRunbook(runbook);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("无章节"))).toBe(true);
  });

  it("assertRunbookGate 通过时不抛错", () => {
    const runbook = buildOperationsRunbook({
      sections: createStandardRunbookSections(),
    });
    expect(() => assertRunbookGate(runbook)).not.toThrow();
  });

  it("assertRunbookGate 失败时抛 RunbookGateError", () => {
    const sections: RunbookSection[] = [{ title: "测试", content: "包含双轨兼容层说明", order: 1 }];
    const runbook = buildOperationsRunbook({ sections });
    try {
      assertRunbookGate(runbook);
      expect.unreachable("应抛 RunbookGateError");
    } catch (err) {
      expect(err).toBeInstanceOf(RunbookGateError);
      expect((err as RunbookGateError).violations.length).toBeGreaterThan(0);
    }
  });

  it("formatRunbookSummary 生成摘要", () => {
    const runbook = buildOperationsRunbook({
      sections: createStandardRunbookSections(),
    });
    const text = formatRunbookSummary(runbook);
    expect(text).toContain("V11 运维手册摘要");
    expect(text).toContain(`版本：${V11_SCHEME_VERSION}`);
    expect(text).toContain("章节数：4");
    expect(text).toContain("系统概览");
  });

  it("章节按 order 排序", () => {
    const sections: RunbookSection[] = [
      { title: "后置章节", content: "内容", order: 5 },
      { title: "前置章节", content: "内容", order: 1 },
      { title: "中置章节", content: "内容", order: 3 },
    ];
    const runbook = buildOperationsRunbook({ sections });
    expect(runbook.sections[0]?.title).toBe("前置章节");
    expect(runbook.sections[1]?.title).toBe("中置章节");
    expect(runbook.sections[2]?.title).toBe("后置章节");
  });
});
