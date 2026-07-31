/**
 * S13-W08 观察窗口跟踪器与事故处置。
 *
 * 职责：
 * - 8 类指标采集：API/SSE/Invocation/unknown Effect/Job/Desktop/Trace/成本容量/安全告警。
 * - 异常检测：标记 anomalous 指标。
 * - 事故处置：隔离/限流/切换/暂停/轮换/通知/升级，禁止以修改数据库终态作为恢复手段。
 * - 报告生成：按类别汇总 + 异常处置记录 + 门禁判定。
 *
 * 事实源：13-migration-cutover-and-release.md §S13-W08
 *         （观察窗口跟踪 API/SSE、Invocation、unknown Effect、Job、Desktop、Trace、成本容量和安全告警；
 *           事故操作按阶段 12 的隔离与处置执行，不以修改数据库终态作为常规恢复手段）。
 */
import {
  ALL_OBSERVATION_METRIC_CATEGORIES,
  type IncidentActionType,
  IncidentOperationError,
  type IncidentOperationRecord,
  type MetricSample,
  type ObservationCategorySummary,
  type ObservationMetricCategory,
  ObservationWindowGateError,
  type ObservationWindowReport,
} from "@/lib/v11/release/release-contract";

// ─── 指标采集 Provider 接口 ────────────────────────────────

/** 单个类别的指标采集 Provider。 */
export interface MetricCollectorProvider {
  /** 采集该类别的指标样本。 */
  collect(): Promise<readonly MetricSample[]>;
}

/** 全部类别采集 Provider 集合。 */
export interface MetricCollectorProviders {
  readonly api: MetricCollectorProvider;
  readonly sse: MetricCollectorProvider;
  readonly invocation: MetricCollectorProvider;
  readonly unknownEffect: MetricCollectorProvider;
  readonly job: MetricCollectorProvider;
  readonly desktop: MetricCollectorProvider;
  readonly trace: MetricCollectorProvider;
  readonly costCapacity: MetricCollectorProvider;
  readonly securityAlert: MetricCollectorProvider;
}

// ─── 事故处置 Provider 接口 ────────────────────────────────

/** 事故处置 Provider（生产环境实现真实处置动作）。 */
export interface IncidentActionProvider {
  /** 执行事故处置动作。 */
  execute(
    action: IncidentActionType,
    incidentId: string,
    details: string,
  ): Promise<{
    resolved: boolean;
    modifiesDatabaseTerminalState: boolean;
    details: string;
  }>;
}

// ─── 观察窗口跟踪器 ───────────────────────────────────────

/** 跟踪器选项。 */
export interface ObservationWindowTrackerOptions {
  /** 窗口开始时间戳。 */
  readonly windowStart: string;
  /** 窗口结束时间戳。 */
  readonly windowEnd: string;
  /** 事故处置人。 */
  readonly operator: string;
}

/**
 * 观察窗口跟踪器。
 *
 * 流程：
 * 1. 调用 9 个类别的 Provider 采集指标样本。
 * 2. 标记异常样本（anomalous=true）。
 * 3. 对异常样本执行事故处置（调用 IncidentActionProvider）。
 * 4. 生成报告，门禁判定（未处置异常阻断）。
 */
export class ObservationWindowTracker {
  constructor(
    private readonly collectors: MetricCollectorProviders,
    private readonly actionProvider: IncidentActionProvider,
    private readonly options: ObservationWindowTrackerOptions,
  ) {}

  /** 执行观察窗口跟踪。 */
  async track(): Promise<ObservationWindowReport> {
    // 步骤 1：采集全部类别指标
    const allSamples: MetricSample[] = [];
    const providerMap: Record<ObservationMetricCategory, MetricCollectorProvider> = {
      api: this.collectors.api,
      sse: this.collectors.sse,
      invocation: this.collectors.invocation,
      unknown_effect: this.collectors.unknownEffect,
      job: this.collectors.job,
      desktop: this.collectors.desktop,
      trace: this.collectors.trace,
      cost_capacity: this.collectors.costCapacity,
      security_alert: this.collectors.securityAlert,
    };

    for (const category of ALL_OBSERVATION_METRIC_CATEGORIES) {
      const provider = providerMap[category];
      try {
        const samples = await provider.collect();
        allSamples.push(...samples);
      } catch (err) {
        // 采集异常本身视为异常指标
        allSamples.push({
          category,
          name: `${category}.collection_error`,
          value: 1,
          unit: "count",
          anomalous: true,
          timestamp: new Date().toISOString(),
          details: `采集异常：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 步骤 2：处置异常指标
    const anomalousSamples = allSamples.filter((s) => s.anomalous);
    const incidentOperations: IncidentOperationRecord[] = [];

    for (const sample of anomalousSamples) {
      const incidentId = `incident-${sample.category}-${Date.now()}`;
      try {
        const actionResult = await this.actionProvider.execute(
          "isolate",
          incidentId,
          `处置异常指标 ${sample.name}=${sample.value}${sample.unit}`,
        );

        // 约束检查：禁止以修改数据库终态作为恢复手段
        if (actionResult.modifiesDatabaseTerminalState) {
          throw new IncidentOperationError(
            `违反约束：事故处置 ${incidentId} 以修改数据库终态作为恢复手段`,
            incidentId,
            "modifiesDatabaseTerminalState=true",
          );
        }

        incidentOperations.push({
          incidentId,
          metricCategory: sample.category,
          actionType: "isolate",
          resolved: actionResult.resolved,
          operator: this.options.operator,
          operatedAt: new Date().toISOString(),
          details: actionResult.details,
          modifiesDatabaseTerminalState: false,
        });
      } catch (err) {
        // 处置失败时记录未处置异常
        incidentOperations.push({
          incidentId,
          metricCategory: sample.category,
          actionType: "isolate",
          resolved: false,
          operator: this.options.operator,
          operatedAt: new Date().toISOString(),
          details: err instanceof Error ? err.message : String(err),
          modifiesDatabaseTerminalState: false,
        });
      }
    }

    // 步骤 3：生成报告
    return this.buildReport(allSamples, incidentOperations);
  }

  /** 构建观察窗口报告。 */
  private buildReport(
    samples: readonly MetricSample[],
    incidents: readonly IncidentOperationRecord[],
  ): ObservationWindowReport {
    const anomalousCount = samples.filter((s) => s.anomalous).length;
    const resolvedCount = incidents.filter((i) => i.resolved).length;
    const unresolvedCount = incidents.filter((i) => !i.resolved).length;

    const categorySummaries: ObservationCategorySummary[] = ALL_OBSERVATION_METRIC_CATEGORIES.map(
      (category) => {
        const catSamples = samples.filter((s) => s.category === category);
        return {
          category,
          sampleCount: catSamples.length,
          anomalousCount: catSamples.filter((s) => s.anomalous).length,
        };
      },
    );

    const passed = unresolvedCount === 0;

    return {
      windowStart: this.options.windowStart,
      windowEnd: this.options.windowEnd,
      passed,
      anomalousCount,
      resolvedCount,
      unresolvedCount,
      categorySummaries,
      samples,
      incidentOperations: incidents,
    };
  }
}

// ─── 门禁校验 ─────────────────────────────────────────────

/** 门禁断言：存在未处置异常时抛 ObservationWindowGateError。 */
export function assertObservationWindowGate(report: ObservationWindowReport): void {
  if (!report.passed) {
    const unresolved = report.incidentOperations
      .filter((i) => !i.resolved)
      .map((i) => i.incidentId);
    throw new ObservationWindowGateError(
      `观察窗口门禁失败：${report.unresolvedCount} 个未处置异常`,
      unresolved,
      report,
    );
  }
}

// ─── 报告格式化 ───────────────────────────────────────────

/** 格式化观察窗口报告为可读字符串。 */
export function formatObservationWindowReport(report: ObservationWindowReport): string {
  const lines: string[] = [];
  lines.push("=== V11 观察窗口报告 ===");
  lines.push(`窗口：${report.windowStart} ~ ${report.windowEnd}`);
  lines.push(`总体结果：${report.passed ? "PASSED" : "FAILED"}`);
  lines.push(
    `异常指标：${report.anomalousCount}（已处置 ${report.resolvedCount} | 未处置 ${report.unresolvedCount}）`,
  );

  lines.push("");
  lines.push("按类别汇总：");
  for (const cat of report.categorySummaries) {
    lines.push(`  - ${cat.category}: ${cat.sampleCount} 样本（异常 ${cat.anomalousCount}）`);
  }

  if (report.incidentOperations.length > 0) {
    lines.push("");
    lines.push("事故处置记录：");
    for (const inc of report.incidentOperations) {
      const status = inc.resolved ? "已处置" : "未处置";
      lines.push(
        `  - ${inc.incidentId} [${inc.metricCategory}] ${inc.actionType} ${status} by ${inc.operator}`,
      );
    }
  }

  return lines.join("\n");
}

// ─── 内存 Provider 实现（测试用） ──────────────────────────

/** 内存指标采集 Provider（测试用）。 */
export class InMemoryMetricCollector implements MetricCollectorProvider {
  private samples: MetricSample[] = [];

  /** 设置采集结果。 */
  setSamples(samples: MetricSample[]): void {
    this.samples = samples;
  }

  /** 添加正常样本。 */
  addNormalSample(
    category: ObservationMetricCategory,
    name: string,
    value: number,
    unit: string,
  ): void {
    this.samples.push({
      category,
      name,
      value,
      unit,
      anomalous: false,
      timestamp: new Date().toISOString(),
      details: "正常",
    });
  }

  /** 添加异常样本。 */
  addAnomalousSample(
    category: ObservationMetricCategory,
    name: string,
    value: number,
    unit: string,
    details: string,
  ): void {
    this.samples.push({
      category,
      name,
      value,
      unit,
      anomalous: true,
      timestamp: new Date().toISOString(),
      details,
    });
  }

  async collect(): Promise<readonly MetricSample[]> {
    return [...this.samples];
  }
}

/** 构造全部类别通过的采集 Provider 集合（测试用）。 */
export function createPassingCollectors(): MetricCollectorProviders {
  const make = () => {
    const collector = new InMemoryMetricCollector();
    return collector;
  };
  const api = make();
  const sse = make();
  const invocation = make();
  const unknownEffect = make();
  const job = make();
  const desktop = make();
  const trace = make();
  const costCapacity = make();
  const securityAlert = make();

  // 每个类别添加一个正常样本
  api.addNormalSample("api", "api.error_rate", 0.1, "%");
  sse.addNormalSample("sse", "sse.connections", 50, "count");
  invocation.addNormalSample("invocation", "invocation.active", 10, "count");
  unknownEffect.addNormalSample("unknown_effect", "unknown_effect.count", 0, "count");
  job.addNormalSample("job", "job.failed_rate", 0, "%");
  desktop.addNormalSample("desktop", "desktop.connections", 5, "count");
  trace.addNormalSample("trace", "trace.spans", 1000, "count");
  costCapacity.addNormalSample("cost_capacity", "cost.tokens", 50000, "count");
  securityAlert.addNormalSample("security_alert", "security.alerts", 0, "count");

  return {
    api,
    sse,
    invocation,
    unknownEffect,
    job,
    desktop,
    trace,
    costCapacity,
    securityAlert,
  };
}

/** 内存事故处置 Provider（测试用）。 */
export class InMemoryIncidentActionProvider implements IncidentActionProvider {
  private shouldResolve = true;
  private shouldViolateDbConstraint = false;

  /** 设置处置是否成功。 */
  setShouldResolve(resolve: boolean): void {
    this.shouldResolve = resolve;
  }

  /** 设置是否违反数据库终态约束。 */
  setShouldViolateDbConstraint(violate: boolean): void {
    this.shouldViolateDbConstraint = violate;
  }

  async execute(
    _action: IncidentActionType,
    _incidentId: string,
    details: string,
  ): Promise<{
    resolved: boolean;
    modifiesDatabaseTerminalState: boolean;
    details: string;
  }> {
    return {
      resolved: this.shouldResolve,
      modifiesDatabaseTerminalState: this.shouldViolateDbConstraint,
      details: `处置完成：${details}`,
    };
  }
}
