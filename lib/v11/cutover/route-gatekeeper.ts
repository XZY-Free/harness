import type {
  DeploymentRouteGateDimension,
  DeploymentRouteGateReport,
  DeploymentRouteGateResult,
} from "@/lib/v11/cutover/entry-switch-contract";
import { ALL_DEPLOYMENT_ROUTE_GATES } from "@/lib/v11/cutover/entry-switch-contract";
/**
 * S13-W05 DeploymentRoute 门禁校验器。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W05
 *         （DeploymentRoute 只指向已通过 conformance、健康、容量和安全门禁的 RuntimeRevision）。
 *
 * 设计：
 * - 4 维门禁：conformance、health、capacity、security。
 * - 每维门禁由独立 Provider 提供检查逻辑（生产由运维平台实现）。
 * - 任一维度未通过则 DeploymentRoute 不允许启用为切换目标。
 * - 支持批量校验多个 DeploymentRoute。
 */
import type { CutoverSession } from "@/lib/v11/cutover/session-store";

// ─── 门禁 Provider 接口 ──────────────────────────────────

/** conformance 门禁 Provider。 */
export interface ConformanceGateProvider {
  /** 检查 RuntimeRevision 是否通过 conformance 校验。 */
  verifyConformance(runtimeRevisionId: string): Promise<{ passed: boolean; details: string }>;
}

/** 健康门禁 Provider。 */
export interface HealthGateProvider {
  /** 检查 RuntimeRevision 健康状态。 */
  verifyHealth(runtimeRevisionId: string): Promise<{ passed: boolean; details: string }>;
}

/** 容量门禁 Provider。 */
export interface CapacityGateProvider {
  /** 检查 RuntimeRevision 容量是否满足。 */
  verifyCapacity(runtimeRevisionId: string): Promise<{ passed: boolean; details: string }>;
}

/** 安全门禁 Provider。 */
export interface SecurityGateProvider {
  /** 检查 RuntimeRevision 安全门禁。 */
  verifySecurity(runtimeRevisionId: string): Promise<{ passed: boolean; details: string }>;
}

/** 全部门禁 Provider 集合。 */
export interface DeploymentRouteGateProviders {
  readonly conformance: ConformanceGateProvider;
  readonly health: HealthGateProvider;
  readonly capacity: CapacityGateProvider;
  readonly security: SecurityGateProvider;
}

// ─── 门禁校验错误 ──────────────────────────────────────────

/** DeploymentRoute 门禁校验失败错误。 */
export class DeploymentRouteGateError extends Error {
  constructor(
    message: string,
    readonly deploymentRouteId: string,
    readonly failedGates: readonly string[],
  ) {
    super(message);
    this.name = "DeploymentRouteGateError";
  }
}

// ─── 门禁校验器 ──────────────────────────────────────────

/** DeploymentRoute 门禁校验器。 */
export class DeploymentRouteGatekeeper {
  constructor(private readonly providers: DeploymentRouteGateProviders) {}

  /**
   * 校验单个 DeploymentRoute 的全部门禁。
   * @param deploymentRouteId DeploymentRoute ID
   * @param agentId Agent ID
   * @param runtimeRevisionId RuntimeRevision ID
   * @param session 切换会话（用于审计关联）
   */
  async verifyGates(
    deploymentRouteId: string,
    agentId: string,
    runtimeRevisionId: string,
    _session: CutoverSession,
  ): Promise<DeploymentRouteGateReport> {
    const gateResults: DeploymentRouteGateResult[] = [];

    // 并行执行 4 维门禁检查（使用箭头函数绑定 this 上下文）
    const [conformance, health, capacity, security] = await Promise.all([
      this.runGate("conformance", runtimeRevisionId, (id) =>
        this.providers.conformance.verifyConformance(id),
      ),
      this.runGate("health", runtimeRevisionId, (id) => this.providers.health.verifyHealth(id)),
      this.runGate("capacity", runtimeRevisionId, (id) =>
        this.providers.capacity.verifyCapacity(id),
      ),
      this.runGate("security", runtimeRevisionId, (id) =>
        this.providers.security.verifySecurity(id),
      ),
    ]);

    gateResults.push(conformance, health, capacity, security);

    const failedGates = gateResults
      .filter((g) => !g.passed)
      .map((g) => `${g.dimension}: ${g.details}`);
    const passed = failedGates.length === 0;

    return {
      deploymentRouteId,
      agentId,
      runtimeRevisionId,
      gateResults,
      passed,
      failedGates,
    };
  }

  /**
   * 校验并断言（失败抛 DeploymentRouteGateError）。
   */
  async verifyGatesOrThrow(
    deploymentRouteId: string,
    agentId: string,
    runtimeRevisionId: string,
    session: CutoverSession,
  ): Promise<DeploymentRouteGateReport> {
    const report = await this.verifyGates(deploymentRouteId, agentId, runtimeRevisionId, session);
    if (!report.passed) {
      throw new DeploymentRouteGateError(
        `DeploymentRoute ${deploymentRouteId} 门禁校验失败：${report.failedGates.join("; ")}`,
        deploymentRouteId,
        report.failedGates,
      );
    }
    return report;
  }

  /** 执行单个维度的门禁检查（异常处理）。 */
  private async runGate(
    dimension: DeploymentRouteGateDimension,
    runtimeRevisionId: string,
    checker: (id: string) => Promise<{ passed: boolean; details: string }>,
  ): Promise<DeploymentRouteGateResult> {
    try {
      const result = await checker(runtimeRevisionId);
      return {
        dimension,
        passed: result.passed,
        details: result.details,
        runtimeRevisionId,
      };
    } catch (err) {
      return {
        dimension,
        passed: false,
        details: `门禁检查执行异常：${err instanceof Error ? err.message : String(err)}`,
        runtimeRevisionId,
      };
    }
  }

  /** 获取全部门禁维度列表。 */
  getAllGateDimensions(): readonly DeploymentRouteGateDimension[] {
    return ALL_DEPLOYMENT_ROUTE_GATES;
  }
}

// ─── 内存 Provider 实现（测试用） ──────────────────────────

/** 内存 conformance 门禁 Provider（测试用）。 */
export class InMemoryConformanceGateProvider implements ConformanceGateProvider {
  private readonly passedRevisions = new Set<string>();

  /** 标记某 RuntimeRevision 通过 conformance。 */
  markPassed(runtimeRevisionId: string): void {
    this.passedRevisions.add(runtimeRevisionId);
  }

  async verifyConformance(
    runtimeRevisionId: string,
  ): Promise<{ passed: boolean; details: string }> {
    const passed = this.passedRevisions.has(runtimeRevisionId);
    return {
      passed,
      details: passed
        ? `RuntimeRevision ${runtimeRevisionId} conformance 校验通过`
        : `RuntimeRevision ${runtimeRevisionId} 未通过 conformance 校验`,
    };
  }
}

/** 内存健康门禁 Provider（测试用）。 */
export class InMemoryHealthGateProvider implements HealthGateProvider {
  private readonly healthyRevisions = new Set<string>();

  markHealthy(runtimeRevisionId: string): void {
    this.healthyRevisions.add(runtimeRevisionId);
  }

  async verifyHealth(runtimeRevisionId: string): Promise<{ passed: boolean; details: string }> {
    const passed = this.healthyRevisions.has(runtimeRevisionId);
    return {
      passed,
      details: passed
        ? `RuntimeRevision ${runtimeRevisionId} 健康检查通过`
        : `RuntimeRevision ${runtimeRevisionId} 健康检查未通过`,
    };
  }
}

/** 内存容量门禁 Provider（测试用）。 */
export class InMemoryCapacityGateProvider implements CapacityGateProvider {
  private readonly capacityReadyRevisions = new Set<string>();

  markCapacityReady(runtimeRevisionId: string): void {
    this.capacityReadyRevisions.add(runtimeRevisionId);
  }

  async verifyCapacity(runtimeRevisionId: string): Promise<{ passed: boolean; details: string }> {
    const passed = this.capacityReadyRevisions.has(runtimeRevisionId);
    return {
      passed,
      details: passed
        ? `RuntimeRevision ${runtimeRevisionId} 容量门禁通过`
        : `RuntimeRevision ${runtimeRevisionId} 容量不足`,
    };
  }
}

/** 内存安全门禁 Provider（测试用）。 */
export class InMemorySecurityGateProvider implements SecurityGateProvider {
  private readonly secureRevisions = new Set<string>();

  markSecure(runtimeRevisionId: string): void {
    this.secureRevisions.add(runtimeRevisionId);
  }

  async verifySecurity(runtimeRevisionId: string): Promise<{ passed: boolean; details: string }> {
    const passed = this.secureRevisions.has(runtimeRevisionId);
    return {
      passed,
      details: passed
        ? `RuntimeRevision ${runtimeRevisionId} 安全门禁通过`
        : `RuntimeRevision ${runtimeRevisionId} 安全门禁未通过`,
    };
  }
}
