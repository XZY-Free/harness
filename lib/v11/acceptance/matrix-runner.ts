/**
 * S13-W06 验收矩阵执行器。
 *
 * 职责：
 * - 遍历矩阵项，调用对应类别的 Provider 执行验收。
 * - 每个矩阵项独立验收，单项失败不影响其他项。
 * - 收集结果生成 AcceptanceReport，包含按类别/维度汇总与阻断项清单。
 * - 门禁判定：任一 mandatory 项失败即阻断发布。
 *
 * Provider 设计：
 * - 每个类别对应一个 Provider，由生产环境实现真实验收（HTTP/Event/Error/Runtime）。
 * - Provider 返回 pass/fail/details，执行器负责时间测量、结果封装和报告聚合。
 * - 未 required 的项自动跳过并标记 skipped=true、passed=true。
 */
import {
  AcceptanceGateError,
  type AcceptanceMatrixCategory,
  type AcceptanceMatrixItem,
  type AcceptanceReport,
  type AcceptanceResult,
  type CategorySummary,
  type DimensionSummary,
} from "@/lib/v11/acceptance/matrix-contract";

// ─── Provider 接口 ────────────────────────────────────────

/** HTTP operation 验收 Provider。 */
export interface HttpOperationVerifierProvider {
  /**
   * 验收单个 HTTP operation 的某个维度。
   * @param item 矩阵项
   * @returns 验收结果（passed/details）
   */
  verify(item: AcceptanceMatrixItem): Promise<{ passed: boolean; details: string }>;
}

/** 持久 Event 验收 Provider。 */
export interface PersistentEventVerifierProvider {
  verify(item: AcceptanceMatrixItem): Promise<{ passed: boolean; details: string }>;
}

/** 错误映射验收 Provider。 */
export interface ErrorMappingVerifierProvider {
  verify(item: AcceptanceMatrixItem): Promise<{ passed: boolean; details: string }>;
}

/** Runtime 一致性验收 Provider。 */
export interface RuntimeConformanceVerifierProvider {
  verify(item: AcceptanceMatrixItem): Promise<{ passed: boolean; details: string }>;
}

/** 全部 Provider 集合。 */
export interface AcceptanceVerifierProviders {
  readonly httpOperation: HttpOperationVerifierProvider;
  readonly persistentEvent: PersistentEventVerifierProvider;
  readonly errorMapping: ErrorMappingVerifierProvider;
  readonly runtimeConformance: RuntimeConformanceVerifierProvider;
}

// ─── 执行器 ───────────────────────────────────────────────

/** 执行器选项。 */
export interface AcceptanceRunnerOptions {
  /** 验收人/自动用例名（写入结果 verifier 字段）。 */
  readonly verifier: string;
  /** 是否并行执行（默认 false，顺序执行便于审计与限流）。 */
  readonly parallel?: boolean;
  /** 单项超时（毫秒，默认 30000）。 */
  readonly itemTimeoutMs?: number;
}

/**
 * 验收矩阵执行器。
 *
 * 用法：
 * ```ts
 * const runner = new AcceptanceMatrixRunner(providers, { verifier: "ci-acceptance" });
 * const report = await runner.run(matrix);
 * if (!report.passed) throw new AcceptanceGateError(...);
 * ```
 */
export class AcceptanceMatrixRunner {
  constructor(
    private readonly providers: AcceptanceVerifierProviders,
    private readonly options: AcceptanceRunnerOptions,
  ) {}

  /**
   * 执行完整验收矩阵。
   * @param matrix 矩阵项列表
   * @returns 验收报告
   */
  async run(matrix: readonly AcceptanceMatrixItem[]): Promise<AcceptanceReport> {
    const results: AcceptanceResult[] = [];

    for (const item of matrix) {
      const result = await this.runItem(item);
      results.push(result);
    }

    return buildReport(results);
  }

  /** 执行单个矩阵项。 */
  private async runItem(item: AcceptanceMatrixItem): Promise<AcceptanceResult> {
    const start = Date.now();
    const timestamp = new Date().toISOString();

    // 未 required 的项自动跳过
    if (!item.required) {
      return {
        key: item.key,
        category: item.category,
        dimension: item.dimension,
        contractItemId: item.contractItemId,
        passed: true,
        mandatory: item.mandatory,
        skipped: true,
        details: "契约特性不适用，自动跳过",
        verifier: this.options.verifier,
        durationMs: 0,
        timestamp,
      };
    }

    // 选择对应类别的 Provider
    const provider = this.selectProvider(item.category);

    try {
      const result = await this.withTimeout(
        provider.verify(item),
        this.options.itemTimeoutMs ?? 30000,
      );
      return {
        key: item.key,
        category: item.category,
        dimension: item.dimension,
        contractItemId: item.contractItemId,
        passed: result.passed,
        mandatory: item.mandatory,
        skipped: false,
        details: result.details,
        verifier: this.options.verifier,
        durationMs: Date.now() - start,
        timestamp,
      };
    } catch (err) {
      return {
        key: item.key,
        category: item.category,
        dimension: item.dimension,
        contractItemId: item.contractItemId,
        passed: false,
        mandatory: item.mandatory,
        skipped: false,
        details: `验收执行异常：${err instanceof Error ? err.message : String(err)}`,
        verifier: this.options.verifier,
        durationMs: Date.now() - start,
        timestamp,
      };
    }
  }

  /** 选择类别对应的 Provider。 */
  private selectProvider(category: AcceptanceMatrixCategory) {
    switch (category) {
      case "http_operation":
        return this.providers.httpOperation;
      case "persistent_event":
        return this.providers.persistentEvent;
      case "error_mapping":
        return this.providers.errorMapping;
      case "runtime_conformance":
        return this.providers.runtimeConformance;
    }
  }

  /** 带超时的 Promise 包装。 */
  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (ms <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`验收超时（${ms}ms）`)), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
}

// ─── 报告生成 ─────────────────────────────────────────────

/** 根据结果列表构建验收报告。 */
export function buildReport(results: readonly AcceptanceResult[]): AcceptanceReport {
  const blockingFailures = results
    .filter((r) => !r.passed && r.mandatory && !r.skipped)
    .map((r) => r.key);

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const mandatoryFailedCount = results.filter((r) => !r.passed && r.mandatory && !r.skipped).length;

  return {
    generatedAt: new Date().toISOString(),
    passed: blockingFailures.length === 0,
    blockingFailures,
    totalItems: results.length,
    passedCount,
    failedCount,
    skippedCount,
    mandatoryFailedCount,
    categorySummaries: buildCategorySummaries(results),
    dimensionSummaries: buildDimensionSummaries(results),
    results,
  };
}

/** 构建按类别汇总。 */
function buildCategorySummaries(results: readonly AcceptanceResult[]): CategorySummary[] {
  const categories: AcceptanceMatrixCategory[] = [
    "http_operation",
    "persistent_event",
    "error_mapping",
    "runtime_conformance",
  ];
  return categories.map((category) => {
    const catResults = results.filter((r) => r.category === category);
    return {
      category,
      total: catResults.length,
      passed: catResults.filter((r) => r.passed).length,
      failed: catResults.filter((r) => !r.passed).length,
      skipped: catResults.filter((r) => r.skipped).length,
      mandatoryFailed: catResults.filter((r) => !r.passed && r.mandatory && !r.skipped).length,
    };
  });
}

/** 构建按维度汇总。 */
function buildDimensionSummaries(results: readonly AcceptanceResult[]): DimensionSummary[] {
  const map = new Map<string, DimensionSummary>();
  for (const r of results) {
    const key = `${r.category}:${r.dimension}`;
    const existing = map.get(key);
    if (existing) {
      map.set(key, {
        ...existing,
        total: existing.total + 1,
        passed: existing.passed + (r.passed ? 1 : 0),
        failed: existing.failed + (r.passed ? 0 : 1),
        skipped: existing.skipped + (r.skipped ? 1 : 0),
      });
    } else {
      map.set(key, {
        category: r.category,
        dimension: r.dimension,
        total: 1,
        passed: r.passed ? 1 : 0,
        failed: r.passed ? 0 : 1,
        skipped: r.skipped ? 1 : 0,
      });
    }
  }
  return [...map.values()];
}

// ─── 门禁校验 ─────────────────────────────────────────────

/**
 * 门禁断言：任一 mandatory 项失败抛 AcceptanceGateError。
 * @param report 验收报告
 */
export function assertAcceptanceGate(report: AcceptanceReport): void {
  if (!report.passed) {
    throw new AcceptanceGateError(
      `验收门禁失败：${report.mandatoryFailedCount} 个 mandatory 项未通过（阻断项：${report.blockingFailures.slice(0, 10).join(", ")}${report.blockingFailures.length > 10 ? "..." : ""}）`,
      report.blockingFailures,
      report,
    );
  }
}

// ─── 报告格式化 ───────────────────────────────────────────

/** 格式化验收报告为可读字符串。 */
export function formatAcceptanceReport(report: AcceptanceReport): string {
  const lines: string[] = [];
  lines.push("=== V11 全量验收报告 ===");
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push(`总体结果：${report.passed ? "PASSED" : "FAILED"}`);
  lines.push(
    `矩阵项：${report.totalItems}（通过 ${report.passedCount} | 失败 ${report.failedCount} | 跳过 ${report.skippedCount}）`,
  );
  lines.push(`Mandatory 失败：${report.mandatoryFailedCount}`);

  if (report.blockingFailures.length > 0) {
    lines.push("");
    lines.push("阻断项清单：");
    for (const key of report.blockingFailures) {
      lines.push(`  - ${key}`);
    }
  }

  lines.push("");
  lines.push("按类别汇总：");
  for (const cat of report.categorySummaries) {
    lines.push(
      `  - ${cat.category}: ${cat.total} 项（通过 ${cat.passed} | 失败 ${cat.failed} | 跳过 ${cat.skipped} | mandatory 失败 ${cat.mandatoryFailed}）`,
    );
  }

  lines.push("");
  lines.push("按维度汇总：");
  for (const dim of report.dimensionSummaries) {
    lines.push(
      `  - ${dim.category}/${dim.dimension}: ${dim.total} 项（通过 ${dim.passed} | 失败 ${dim.failed} | 跳过 ${dim.skipped}）`,
    );
  }

  return lines.join("\n");
}

// ─── 内存 Provider 实现（测试用） ─────────────────────────

/**
 * 内存验收 Provider（测试用）。
 *
 * 通过 markPassed/markFailed 预设结果，便于测试矩阵执行器和报告生成。
 */
export class InMemoryAcceptanceProvider {
  private readonly passedItems = new Set<string>();
  private readonly failedDetails = new Map<string, string>();

  /** 标记某矩阵项 key 通过。 */
  markPassed(key: string): void {
    this.passedItems.add(key);
    this.failedDetails.delete(key);
  }

  /** 标记某矩阵项 key 失败。 */
  markFailed(key: string, details: string): void {
    this.passedItems.delete(key);
    this.failedDetails.set(key, details);
  }

  /** 标记全部矩阵项通过。 */
  markAllPassed(items: readonly AcceptanceMatrixItem[]): void {
    for (const item of items) {
      this.passedItems.add(item.key);
    }
  }

  /** 全部通过的 Provider。 */
  static allPassing(): InMemoryAcceptanceProvider {
    return new InMemoryAcceptanceProvider();
  }

  /** verify 实现：未预设的项默认通过。 */
  async verify(item: AcceptanceMatrixItem): Promise<{ passed: boolean; details: string }> {
    const failedDetails = this.failedDetails.get(item.key);
    if (failedDetails !== undefined) {
      return { passed: false, details: failedDetails };
    }
    return { passed: true, details: "验收通过" };
  }
}

/** 构造全部通过的内存 Provider 集合（测试用）。 */
export function createPassingProviders(): AcceptanceVerifierProviders {
  const http = new InMemoryAcceptanceProvider();
  const event = new InMemoryAcceptanceProvider();
  const error = new InMemoryAcceptanceProvider();
  const runtime = new InMemoryAcceptanceProvider();
  return {
    httpOperation: { verify: (item) => http.verify(item) },
    persistentEvent: { verify: (item) => event.verify(item) },
    errorMapping: { verify: (item) => error.verify(item) },
    runtimeConformance: { verify: (item) => runtime.verify(item) },
  };
}

/** 构造指定失败项的内存 Provider 集合（测试用）。 */
export function createProvidersWithFailures(
  failedKeys: readonly string[],
  failureDetail = "模拟验收失败",
): AcceptanceVerifierProviders {
  const providers = createPassingProviders();
  const failedSet = new Set(failedKeys);
  const wrap =
    (base: InMemoryAcceptanceProvider) =>
    async (item: AcceptanceMatrixItem): Promise<{ passed: boolean; details: string }> => {
      if (failedSet.has(item.key)) {
        return { passed: false, details: failureDetail };
      }
      return base.verify(item);
    };
  return {
    httpOperation: { verify: wrap(new InMemoryAcceptanceProvider()) },
    persistentEvent: { verify: wrap(new InMemoryAcceptanceProvider()) },
    errorMapping: { verify: wrap(new InMemoryAcceptanceProvider()) },
    runtimeConformance: { verify: wrap(new InMemoryAcceptanceProvider()) },
  };
}
