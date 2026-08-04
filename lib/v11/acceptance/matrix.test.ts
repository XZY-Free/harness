import { MANDATORY_GATE_CASES } from "@/lib/runtimes/domain/runtime-conformance";
import {
  ALL_ACCEPTANCE_MATRIX_CATEGORIES,
  ALL_ERROR_MAPPING_DIMENSIONS,
  ALL_HTTP_OPERATION_DIMENSIONS,
  ALL_PERSISTENT_EVENT_DIMENSIONS,
  ALL_RUNTIME_CONFORMANCE_DIMENSIONS,
  AcceptanceGateError,
  type AcceptanceMatrixItem,
  CATEGORY_LABELS,
} from "@/lib/v11/acceptance/matrix-contract";
import {
  type ContractBundle,
  RELEASE_BASELINE_COUNTS,
  checkBaselineCounts,
  extractHttpOperations,
  generateAcceptanceMatrix,
  getMatrixStats,
  loadContractsFromFiles,
} from "@/lib/v11/acceptance/matrix-generator";
import {
  AcceptanceMatrixRunner,
  type HttpOperationVerifierProvider,
  assertAcceptanceGate,
  buildReport,
  createPassingProviders,
  createProvidersWithFailures,
  formatAcceptanceReport,
} from "@/lib/v11/acceptance/matrix-runner";
/**
 * S13-W06 全量验收矩阵集成测试。
 *
 * 覆盖：
 * - 矩阵契约定义：4 类别 + 6/6/2/1 维度 + 标签 + mandatory 标记
 * - 矩阵生成器：从契约对象生成矩阵、HTTP 维度 required 判定、基线计数校验、文件加载
 * - 矩阵执行器：完整执行 + 跳过策略 + 异常捕获 + 超时 + 并行/顺序
 * - 报告生成：按类别/维度汇总、阻断项清单、格式化输出
 * - 门禁判定：全部 required Runtime case 失败都会阻断、断言模式
 */
import { beforeEach, describe, expect, it } from "vitest";

// ═══════════════════════════════════════════════════════════
// 测试夹具：内存契约
// ═══════════════════════════════════════════════════════════

/** 构造测试用契约集合（小规模，便于断言）。 */
function createTestBundle(): ContractBundle {
  return {
    openapi: {
      paths: {
        "/api/v1/threads": {
          post: {
            operationId: "post_api_v1_threads",
            tags: ["employee"],
            parameters: [{ name: "Idempotency-Key", in: "header", required: true }],
          },
        },
        "/api/v1/threads/{thread_id}/settings": {
          patch: {
            operationId: "patch_api_v1_threads_settings",
            tags: ["employee"],
            parameters: [{ name: "If-Match", in: "header", required: true }],
          },
        },
        "/api/v1/threads/{thread_id}/events": {
          get: {
            operationId: "get_api_v1_threads_events",
            tags: ["employee"],
            parameters: [],
          },
        },
      },
    },
    eventCatalog: {
      events: {
        "thread.created": {
          streams: ["thread"],
          version: 1,
          required_refs: ["thread_id"],
          skippable_for_projection: false,
        },
        "turn.completed": {
          streams: ["thread"],
          version: 1,
          required_refs: ["thread_id", "turn_id"],
          skippable_for_projection: false,
        },
      },
    },
    errorCatalog: {
      errors: {
        ACCESS_DENIED: { http: 403, retryable: false },
        RATE_LIMITED: { http: 429, retryable: true },
      },
    },
    runtimeConformance: {
      required_cases: [
        { id: "dispatch-binds-immutable-config" },
        { id: "event-batch-idempotent" },
        { id: "steer-requires-ack" },
        { id: "credential-never-in-model-data" },
      ],
    },
  };
}

// ═══════════════════════════════════════════════════════════
// 1. 矩阵契约定义
// ═══════════════════════════════════════════════════════════

describe("S13-W06 矩阵契约定义", () => {
  it("4 个验收矩阵类别全部定义", () => {
    expect(ALL_ACCEPTANCE_MATRIX_CATEGORIES).toHaveLength(4);
    expect(ALL_ACCEPTANCE_MATRIX_CATEGORIES).toContain("http_operation");
    expect(ALL_ACCEPTANCE_MATRIX_CATEGORIES).toContain("persistent_event");
    expect(ALL_ACCEPTANCE_MATRIX_CATEGORIES).toContain("error_mapping");
    expect(ALL_ACCEPTANCE_MATRIX_CATEGORIES).toContain("runtime_conformance");
  });

  it("6 个 HTTP operation 维度全部定义", () => {
    expect(ALL_HTTP_OPERATION_DIMENSIONS).toHaveLength(6);
    for (const dim of ["success", "auth", "idempotency", "concurrency", "error", "audit"]) {
      expect(ALL_HTTP_OPERATION_DIMENSIONS).toContain(dim);
    }
  });

  it("6 个持久 Event 维度全部定义", () => {
    expect(ALL_PERSISTENT_EVENT_DIMENSIONS).toHaveLength(6);
    for (const dim of ["producer", "schema", "ordering", "replay", "projection", "sse"]) {
      expect(ALL_PERSISTENT_EVENT_DIMENSIONS).toContain(dim);
    }
  });

  it("2 个错误映射维度全部定义", () => {
    expect(ALL_ERROR_MAPPING_DIMENSIONS).toHaveLength(2);
    expect(ALL_ERROR_MAPPING_DIMENSIONS).toContain("cataloged");
    expect(ALL_ERROR_MAPPING_DIMENSIONS).toContain("recoverable");
  });

  it("1 个 Runtime 一致性维度定义", () => {
    expect(ALL_RUNTIME_CONFORMANCE_DIMENSIONS).toHaveLength(1);
    expect(ALL_RUNTIME_CONFORMANCE_DIMENSIONS).toContain("conformance");
  });

  it("类别中文标签完整", () => {
    expect(CATEGORY_LABELS.http_operation).toBe("HTTP operation");
    expect(CATEGORY_LABELS.persistent_event).toBe("持久 Event");
    expect(CATEGORY_LABELS.error_mapping).toBe("错误映射");
    expect(CATEGORY_LABELS.runtime_conformance).toBe("Runtime 一致性");
  });

  it("RELEASE_BASELINE_COUNTS 与发布基线一致", () => {
    expect(RELEASE_BASELINE_COUNTS.httpOperations).toBe(63);
    expect(RELEASE_BASELINE_COUNTS.persistentEvents).toBe(91);
    expect(RELEASE_BASELINE_COUNTS.errorMappings).toBe(49);
    expect(RELEASE_BASELINE_COUNTS.runtimeConformanceCases).toBe(16);
  });

  it("MANDATORY_GATE_CASES 覆盖全部 16 个 required case", () => {
    expect(MANDATORY_GATE_CASES).toHaveLength(16);
    expect(MANDATORY_GATE_CASES).toContain("dispatch-binds-immutable-config");
    expect(MANDATORY_GATE_CASES).toContain("event-batch-idempotent");
    expect(MANDATORY_GATE_CASES).toContain("cancel-request-not-terminal");
    expect(MANDATORY_GATE_CASES).toContain("credential-never-in-model-data");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. 矩阵生成器
// ═══════════════════════════════════════════════════════════

describe("S13-W06 矩阵生成器", () => {
  let bundle: ContractBundle;

  beforeEach(() => {
    bundle = createTestBundle();
  });

  it("生成矩阵项总数 = HTTP×6 + Event×6 + Error×2 + Runtime×1", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    // 3 HTTP × 6 + 2 Event × 6 + 2 Error × 2 + 4 Runtime × 1 = 18+12+4+4 = 38
    expect(matrix).toHaveLength(38);
  });

  it("HTTP operation 矩阵项包含全部 6 个维度", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const httpItems = matrix.filter((i) => i.category === "http_operation");
    expect(httpItems).toHaveLength(18); // 3 ops × 6 dims
    const dims = new Set(httpItems.map((i) => i.dimension));
    expect(dims.size).toBe(6);
  });

  it("支持 Idempotency-Key 的 operation 的 idempotency 维度 required=true", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const idemItem = matrix.find((i) => i.key === "POST /api/v1/threads:idempotency");
    expect(idemItem?.required).toBe(true);
  });

  it("不支持 Idempotency-Key 的 operation 的 idempotency 维度 required=false", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const idemItem = matrix.find(
      (i) => i.key === "GET /api/v1/threads/{thread_id}/events:idempotency",
    );
    expect(idemItem?.required).toBe(false);
  });

  it("支持 ETag/If-Match 的 operation 的 concurrency 维度 required=true", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const concItem = matrix.find(
      (i) => i.key === "PATCH /api/v1/threads/{thread_id}/settings:concurrency",
    );
    expect(concItem?.required).toBe(true);
  });

  it("不支持 ETag/If-Match 的 operation 的 concurrency 维度 required=false", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const concItem = matrix.find((i) => i.key === "POST /api/v1/threads:concurrency");
    expect(concItem?.required).toBe(false);
  });

  it("success/auth/error/audit 维度对所有 operation 都 required=true", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const alwaysRequired = matrix.filter((i) =>
      ["success", "auth", "error", "audit"].includes(i.dimension),
    );
    for (const item of alwaysRequired) {
      expect(item.required).toBe(true);
    }
  });

  it("持久 Event 矩阵项包含全部 6 个维度", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const eventItems = matrix.filter((i) => i.category === "persistent_event");
    expect(eventItems).toHaveLength(12); // 2 events × 6 dims
    const dims = new Set(eventItems.map((i) => i.dimension));
    expect(dims.size).toBe(6);
  });

  it("错误映射矩阵项包含全部 2 个维度", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const errorItems = matrix.filter((i) => i.category === "error_mapping");
    expect(errorItems).toHaveLength(4); // 2 errors × 2 dims
    expect(errorItems.every((i) => i.required)).toBe(true);
  });

  it("Runtime 一致性矩阵项 mandatory 标记正确", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const runtimeItems = matrix.filter((i) => i.category === "runtime_conformance");
    expect(runtimeItems).toHaveLength(4);

    const mandatory = runtimeItems.filter((i) => i.mandatory);
    expect(mandatory).toHaveLength(4);
    expect(mandatory.map((i) => i.contractItemId)).toContain("dispatch-binds-immutable-config");
    expect(mandatory.map((i) => i.contractItemId)).toContain("event-batch-idempotent");
    expect(mandatory.map((i) => i.contractItemId)).toContain("credential-never-in-model-data");
  });

  it("steer-requires-ack 同样是发布门禁", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const steerItem = matrix.find((i) => i.contractItemId === "steer-requires-ack");
    expect(steerItem?.mandatory).toBe(true);
  });

  it("矩阵项 key 唯一", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const keys = matrix.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("矩阵项按类别顺序：HTTP → Event → Error → Runtime", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const categories = [...new Set(matrix.map((i) => i.category))];
    expect(categories).toEqual([
      "http_operation",
      "persistent_event",
      "error_mapping",
      "runtime_conformance",
    ]);
  });

  it("extractHttpOperations 提取 method/path/tag", () => {
    const ops = extractHttpOperations(bundle.openapi);
    expect(ops).toHaveLength(3);
    expect(ops.find((o) => o.operationId === "post_api_v1_threads")?.method).toBe("POST");
    expect(ops.find((o) => o.operationId === "post_api_v1_threads")?.supportsIdempotency).toBe(
      true,
    );
    expect(ops.find((o) => o.operationId === "post_api_v1_threads")?.hasOptimisticLock).toBe(false);
    expect(
      ops.find((o) => o.operationId === "patch_api_v1_threads_settings")?.hasOptimisticLock,
    ).toBe(true);
  });

  it("getMatrixStats 返回正确统计", () => {
    const matrix = generateAcceptanceMatrix(bundle);
    const stats = getMatrixStats(matrix);
    expect(stats.totalItems).toBe(38);
    // required = 38 - 跳过数
    // POST /api/v1/threads: 无 If-Match → concurrency 跳过（1）
    // GET events: 无 Idempotency-Key → idempotency 跳过；无 If-Match → concurrency 跳过（2）
    // PATCH settings: 有 If-Match 但无 Idempotency-Key → idempotency 跳过（1）
    // 共 4 跳过
    expect(stats.skippedItems).toBe(4);
    expect(stats.requiredItems).toBe(34);
    expect(stats.byCategory.http_operation.total).toBe(18);
    expect(stats.byCategory.persistent_event.total).toBe(12);
    expect(stats.byCategory.error_mapping.total).toBe(4);
    expect(stats.byCategory.runtime_conformance.total).toBe(4);
  });

  it("基线计数校验：测试夹具与基线不符时返回偏差", () => {
    const report = checkBaselineCounts(bundle);
    expect(report.passed).toBe(false);
    // 测试夹具 HTTP=3, Event=2, Error=2, Runtime=4，全部与基线不符
    expect(report.deviations).toHaveLength(4);
    const httpDev = report.deviations.find((d) => d.category === "http_operation");
    expect(httpDev?.expected).toBe(63);
    expect(httpDev?.actual).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 矩阵执行器
// ═══════════════════════════════════════════════════════════

describe("S13-W06 矩阵执行器", () => {
  let matrix: AcceptanceMatrixItem[];

  beforeEach(() => {
    matrix = generateAcceptanceMatrix(createTestBundle());
  });

  it("全部 Provider 通过时报告 passed=true", async () => {
    const runner = new AcceptanceMatrixRunner(createPassingProviders(), {
      verifier: "test",
    });
    const report = await runner.run(matrix);

    expect(report.passed).toBe(true);
    expect(report.mandatoryFailedCount).toBe(0);
    expect(report.blockingFailures).toHaveLength(0);
    expect(report.totalItems).toBe(matrix.length);
  });

  it("未 required 的项自动跳过并标记 passed=true", async () => {
    const runner = new AcceptanceMatrixRunner(createPassingProviders(), {
      verifier: "test",
    });
    const report = await runner.run(matrix);

    const skipped = report.results.filter((r) => r.skipped);
    expect(skipped.length).toBe(4);
    for (const r of skipped) {
      expect(r.passed).toBe(true);
      expect(r.details).toContain("自动跳过");
    }
  });

  it("mandatory 项失败时报告 passed=false 并列入阻断项", async () => {
    const failedKey = "dispatch-binds-immutable-config:conformance";
    const runner = new AcceptanceMatrixRunner(
      createProvidersWithFailures([failedKey], "Runtime 一致性失败"),
      { verifier: "test" },
    );
    const report = await runner.run(matrix);

    expect(report.passed).toBe(false);
    expect(report.mandatoryFailedCount).toBe(1);
    expect(report.blockingFailures).toContain(failedKey);
  });

  it("任一 required Runtime case 失败都会阻断发布", async () => {
    const failedKey = "steer-requires-ack:conformance";
    const runner = new AcceptanceMatrixRunner(
      createProvidersWithFailures([failedKey], "required case 失败"),
      { verifier: "test" },
    );
    const report = await runner.run(matrix);

    expect(report.passed).toBe(false);
    expect(report.mandatoryFailedCount).toBe(1);
    expect(report.failedCount).toBe(1);
    expect(report.blockingFailures).toEqual([failedKey]);
  });

  it("Provider 异常被捕获为失败", async () => {
    const throwingProvider: HttpOperationVerifierProvider = {
      verify: async () => {
        throw new Error("Provider 爆炸");
      },
    };
    const providers = {
      ...createPassingProviders(),
      httpOperation: throwingProvider,
    };
    const runner = new AcceptanceMatrixRunner(providers, { verifier: "test" });
    const report = await runner.run(matrix);

    const httpResults = report.results.filter((r) => r.category === "http_operation");
    expect(httpResults.length).toBeGreaterThan(0);
    for (const r of httpResults) {
      if (!r.skipped) {
        expect(r.passed).toBe(false);
        expect(r.details).toContain("Provider 爆炸");
      }
    }
    expect(report.passed).toBe(false);
  });

  it("结果包含耗时与时间戳", async () => {
    const runner = new AcceptanceMatrixRunner(createPassingProviders(), {
      verifier: "test",
    });
    const report = await runner.run(matrix);

    for (const r of report.results) {
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(r.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(r.verifier).toBe("test");
    }
  });

  it("单项超时被捕获为失败", async () => {
    const slowProvider: HttpOperationVerifierProvider = {
      verify: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { passed: true, details: "慢" };
      },
    };
    const providers = {
      ...createPassingProviders(),
      httpOperation: slowProvider,
    };
    const runner = new AcceptanceMatrixRunner(providers, {
      verifier: "test",
      itemTimeoutMs: 50,
    });
    const report = await runner.run(matrix);

    const httpNonSkipped = report.results.filter(
      (r) => r.category === "http_operation" && !r.skipped,
    );
    for (const r of httpNonSkipped) {
      expect(r.passed).toBe(false);
      expect(r.details).toContain("超时");
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 报告生成与格式化
// ═══════════════════════════════════════════════════════════

describe("S13-W06 报告生成与格式化", () => {
  let matrix: AcceptanceMatrixItem[];

  beforeEach(() => {
    matrix = generateAcceptanceMatrix(createTestBundle());
  });

  it("buildReport 按类别汇总正确", async () => {
    const runner = new AcceptanceMatrixRunner(createPassingProviders(), {
      verifier: "test",
    });
    const report = await runner.run(matrix);

    const httpSummary = report.categorySummaries.find((c) => c.category === "http_operation");
    expect(httpSummary?.total).toBe(18);
    expect(httpSummary?.passed).toBe(18);
    expect(httpSummary?.failed).toBe(0);
    expect(httpSummary?.skipped).toBe(4);

    const eventSummary = report.categorySummaries.find((c) => c.category === "persistent_event");
    expect(eventSummary?.total).toBe(12);

    const errorSummary = report.categorySummaries.find((c) => c.category === "error_mapping");
    expect(errorSummary?.total).toBe(4);

    const runtimeSummary = report.categorySummaries.find(
      (c) => c.category === "runtime_conformance",
    );
    expect(runtimeSummary?.total).toBe(4);
  });

  it("buildReport 按维度汇总正确", async () => {
    const runner = new AcceptanceMatrixRunner(createPassingProviders(), {
      verifier: "test",
    });
    const report = await runner.run(matrix);

    const httpSuccess = report.dimensionSummaries.find(
      (d) => d.category === "http_operation" && d.dimension === "success",
    );
    expect(httpSuccess?.total).toBe(3); // 3 HTTP ops

    const eventIdem = report.dimensionSummaries.find(
      (d) => d.category === "persistent_event" && d.dimension === "producer",
    );
    expect(eventIdem?.total).toBe(2); // 2 events
  });

  it("formatAcceptanceReport 生成可读字符串", async () => {
    const runner = new AcceptanceMatrixRunner(createPassingProviders(), {
      verifier: "test",
    });
    const report = await runner.run(matrix);
    const text = formatAcceptanceReport(report);

    expect(text).toContain("V11 全量验收报告");
    expect(text).toContain("总体结果：PASSED");
    expect(text).toContain("矩阵项：38");
    expect(text).toContain("按类别汇总");
    expect(text).toContain("按维度汇总");
    expect(text).toContain("http_operation");
  });

  it("formatAcceptanceReport 失败时显示阻断项", async () => {
    const failedKey = "credential-never-in-model-data:conformance";
    const runner = new AcceptanceMatrixRunner(createProvidersWithFailures([failedKey]), {
      verifier: "test",
    });
    const report = await runner.run(matrix);
    const text = formatAcceptanceReport(report);

    expect(text).toContain("总体结果：FAILED");
    expect(text).toContain("阻断项清单");
    expect(text).toContain(failedKey);
  });

  it("buildReport 直接接受结果列表", () => {
    const results = [
      {
        key: "test:success",
        category: "http_operation" as const,
        dimension: "success",
        contractItemId: "test",
        passed: true,
        mandatory: true,
        skipped: false,
        details: "通过",
        verifier: "unit",
        durationMs: 10,
        timestamp: new Date().toISOString(),
      },
      {
        key: "test:auth",
        category: "http_operation" as const,
        dimension: "auth",
        contractItemId: "test",
        passed: false,
        mandatory: true,
        skipped: false,
        details: "失败",
        verifier: "unit",
        durationMs: 5,
        timestamp: new Date().toISOString(),
      },
    ];
    const report = buildReport(results);
    expect(report.totalItems).toBe(2);
    expect(report.passedCount).toBe(1);
    expect(report.failedCount).toBe(1);
    expect(report.blockingFailures).toContain("test:auth");
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 门禁判定
// ═══════════════════════════════════════════════════════════

describe("S13-W06 验收门禁", () => {
  let matrix: AcceptanceMatrixItem[];

  beforeEach(() => {
    matrix = generateAcceptanceMatrix(createTestBundle());
  });

  it("assertAcceptanceGate 全部通过时不抛错", async () => {
    const runner = new AcceptanceMatrixRunner(createPassingProviders(), {
      verifier: "ci",
    });
    const report = await runner.run(matrix);
    expect(() => assertAcceptanceGate(report)).not.toThrow();
  });

  it("assertAcceptanceGate mandatory 失败时抛 AcceptanceGateError", async () => {
    const failedKey = "dispatch-binds-immutable-config:conformance";
    const runner = new AcceptanceMatrixRunner(createProvidersWithFailures([failedKey]), {
      verifier: "ci",
    });
    const report = await runner.run(matrix);

    try {
      assertAcceptanceGate(report);
      expect.unreachable("应抛 AcceptanceGateError");
    } catch (err) {
      expect(err).toBeInstanceOf(AcceptanceGateError);
      expect((err as AcceptanceGateError).blockingFailures).toContain(failedKey);
      expect((err as AcceptanceGateError).report).toBe(report);
      expect((err as AcceptanceGateError).message).toContain("验收门禁失败");
    }
  });

  it("多个 mandatory 失败时全部列入阻断项", async () => {
    const failedKeys = [
      "dispatch-binds-immutable-config:conformance",
      "credential-never-in-model-data:conformance",
    ];
    const runner = new AcceptanceMatrixRunner(createProvidersWithFailures(failedKeys), {
      verifier: "ci",
    });
    const report = await runner.run(matrix);

    expect(report.passed).toBe(false);
    expect(report.blockingFailures).toHaveLength(2);
    for (const key of failedKeys) {
      expect(report.blockingFailures).toContain(key);
    }

    try {
      assertAcceptanceGate(report);
      expect.unreachable("应抛 AcceptanceGateError");
    } catch (err) {
      expect(err).toBeInstanceOf(AcceptanceGateError);
      expect((err as AcceptanceGateError).blockingFailures).toHaveLength(2);
    }
  });

  it("steer case 失败时门禁拒绝", async () => {
    const failedKey = "steer-requires-ack:conformance";
    const runner = new AcceptanceMatrixRunner(createProvidersWithFailures([failedKey]), {
      verifier: "ci",
    });
    const report = await runner.run(matrix);

    expect(report.passed).toBe(false);
    expect(() => assertAcceptanceGate(report)).toThrow(AcceptanceGateError);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 真实契约文件加载（确保与发布基线对齐）
// ═══════════════════════════════════════════════════════════

describe("S13-W06 真实契约文件加载", () => {
  it("loadContractsFromFiles 加载全部 4 份契约", () => {
    const bundle = loadContractsFromFiles();
    expect(bundle.openapi.paths).toBeDefined();
    expect(bundle.eventCatalog.events).toBeDefined();
    expect(bundle.errorCatalog.errors).toBeDefined();
    expect(bundle.runtimeConformance.required_cases).toBeDefined();
  });

  it("真实契约生成矩阵包含 63 个 HTTP operation × 6 维度", () => {
    const bundle = loadContractsFromFiles();
    const matrix = generateAcceptanceMatrix(bundle);
    const httpItems = matrix.filter((i) => i.category === "http_operation");
    expect(httpItems.length).toBe(63 * 6);
  });

  it("真实契约 Runtime 一致性包含 16 个 case", () => {
    const bundle = loadContractsFromFiles();
    const matrix = generateAcceptanceMatrix(bundle);
    const runtimeItems = matrix.filter((i) => i.category === "runtime_conformance");
    expect(runtimeItems.length).toBe(16);
    const mandatory = runtimeItems.filter((i) => i.mandatory);
    expect(mandatory.length).toBe(16);
  });

  it("真实契约基线计数校验返回偏差报告", () => {
    const bundle = loadContractsFromFiles();
    const report = checkBaselineCounts(bundle);
    // 真实契约 Event/Error 可能与基线不符，HTTP/Runtime 应一致
    const httpDev = report.deviations.find((d) => d.category === "http_operation");
    expect(httpDev).toBeUndefined(); // HTTP 应为 63
    const runtimeDev = report.deviations.find((d) => d.category === "runtime_conformance");
    expect(runtimeDev).toBeUndefined(); // Runtime 应为 16
  });
});
