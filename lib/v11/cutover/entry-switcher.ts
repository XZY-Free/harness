import type {
  ChannelSwitchStatus,
  CutoverChannel,
  DeploymentRouteGateReport,
  PostCutoverVerificationReport,
  ProductEntry,
  ProductEntrySwitchStatus,
  V11EntrySwitcher,
} from "@/lib/v11/cutover/entry-switch-contract";
import { ALL_CUTOVER_CHANNELS, ALL_PRODUCT_ENTRIES } from "@/lib/v11/cutover/entry-switch-contract";
import type { PostCutoverVerifier } from "@/lib/v11/cutover/post-cutover-verifier";
import { runPostCutoverVerifications } from "@/lib/v11/cutover/post-cutover-verifier";
import type { DeploymentRouteGatekeeper } from "@/lib/v11/cutover/route-gatekeeper";
/**
 * S13-W05 V11 入口切换器：4 通道 + 3 端 + 门禁校验 + 切换后验证。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W05
 *         （Gateway 将员工 API、Admin API、Runtime Event Ingress 和命令通道切到 V11；
 *           Web、Desktop、Studio 使用 V11 OpenAPI、Event 和错误目录，不保留旧字段兜底；
 *           DeploymentRoute 只指向已通过 conformance、健康、容量和安全门禁的 RuntimeRevision；
 *           切换后立即验证创建 Thread、连续 Turn、Tool/Effect、Desktop、本地授权、Child、Job、管理发布和 Trace）。
 *
 * 设计：
 * - 实现 V11EntrySwitcher 接口（entry-switch-contract.ts）。
 * - 内存实现，用于测试与开发；生产可替换为 Gateway 路由配置 + Runtime 部署。
 * - 完整流程：门禁校验 → 切换通道 → 切换产品入口 → 切换后验证。
 */
import type { CutoverSession, CutoverSessionStore } from "@/lib/v11/cutover/session-store";

// ─── 切换错误 ──────────────────────────────────────────────

/** V11 入口切换错误。 */
export class V11EntrySwitchError extends Error {
  constructor(
    message: string,
    readonly sessionId: string,
    readonly failedStep: string,
  ) {
    super(message);
    this.name = "V11EntrySwitchError";
  }
}

// ─── 通道/入口操作器接口 ──────────────────────────────────

/** 通道切换操作器（生产由 Gateway 路由配置实现）。 */
export interface ChannelSwitchOperator {
  /** 将指定通道切到 V11。 */
  switchToV11(channel: CutoverChannel, sessionId: string): Promise<void>;
}

/** 产品入口切换操作器（生产由 Web/Desktop/Studio 部署实现）。 */
export interface ProductEntrySwitchOperator {
  /** 将指定产品入口切到 V11（禁用旧字段兜底）。 */
  switchToV11(entry: ProductEntry, sessionId: string): Promise<void>;
}

// ─── V11 入口切换器选项 ──────────────────────────────────

/** V11 入口切换器选项。 */
export interface V11EntrySwitcherOptions {
  readonly sessionStore: CutoverSessionStore;
  readonly gatekeeper: DeploymentRouteGatekeeper;
  readonly verifiers: readonly PostCutoverVerifier[];
  readonly channelOperator: ChannelSwitchOperator;
  readonly productEntryOperator: ProductEntrySwitchOperator;
  /** 切换目标 DeploymentRoute 信息。 */
  readonly deploymentRoute: {
    readonly routeId: string;
    readonly agentId: string;
    readonly runtimeRevisionId: string;
  };
}

// ─── 内存 V11 入口切换器实现 ──────────────────────────────

/** 内存 V11 入口切换器（测试和开发用）。 */
export class InMemoryV11EntrySwitcher implements V11EntrySwitcher {
  private readonly channelStatuses = new Map<CutoverChannel, ChannelSwitchStatus>();
  private readonly productEntryStatuses = new Map<ProductEntry, ProductEntrySwitchStatus>();
  private lastGateReport: DeploymentRouteGateReport | null = null;
  private lastVerificationReport: PostCutoverVerificationReport | null = null;

  constructor(private readonly options: V11EntrySwitcherOptions) {
    for (const channel of ALL_CUTOVER_CHANNELS) {
      this.channelStatuses.set(channel, {
        channel,
        switched: false,
        switchedAt: null,
        switchedBy: null,
        sessionId: null,
        legacyFrozen: false,
      });
    }
    for (const entry of ALL_PRODUCT_ENTRIES) {
      this.productEntryStatuses.set(entry, {
        entry,
        switched: false,
        legacyFallbackEnabled: true, // 初始保留旧字段兜底
        switchedAt: null,
        sessionId: null,
      });
    }
  }

  async verifyDeploymentRouteGates(session: CutoverSession): Promise<DeploymentRouteGateReport> {
    const { routeId, agentId, runtimeRevisionId } = this.options.deploymentRoute;
    this.lastGateReport = await this.options.gatekeeper.verifyGates(
      routeId,
      agentId,
      runtimeRevisionId,
      session,
    );
    return this.lastGateReport;
  }

  async switchChannel(
    channel: CutoverChannel,
    session: CutoverSession,
    operator: string,
  ): Promise<void> {
    const existing = this.channelStatuses.get(channel);
    if (existing?.switched) {
      throw new V11EntrySwitchError(
        `通道 ${channel} 已切换，无法重复切换`,
        session.id,
        "switchChannel",
      );
    }
    await this.options.channelOperator.switchToV11(channel, session.id);
    this.channelStatuses.set(channel, {
      channel,
      switched: true,
      switchedAt: new Date().toISOString(),
      switchedBy: operator,
      sessionId: session.id,
      legacyFrozen: true,
    });
  }

  async switchAllChannels(session: CutoverSession, operator: string): Promise<void> {
    for (const channel of ALL_CUTOVER_CHANNELS) {
      const existing = this.channelStatuses.get(channel);
      if (!existing?.switched) {
        await this.switchChannel(channel, session, operator);
      }
    }
  }

  async switchProductEntry(
    entry: ProductEntry,
    session: CutoverSession,
    operator: string,
  ): Promise<void> {
    const existing = this.productEntryStatuses.get(entry);
    if (existing?.switched) {
      throw new V11EntrySwitchError(
        `产品入口 ${entry} 已切换，无法重复切换`,
        session.id,
        "switchProductEntry",
      );
    }
    await this.options.productEntryOperator.switchToV11(entry, session.id);
    this.productEntryStatuses.set(entry, {
      entry,
      switched: true,
      legacyFallbackEnabled: false, // S13-W05 要求不保留旧字段兜底
      switchedAt: new Date().toISOString(),
      sessionId: session.id,
    });
  }

  async switchAllProductEntries(session: CutoverSession, operator: string): Promise<void> {
    for (const entry of ALL_PRODUCT_ENTRIES) {
      const existing = this.productEntryStatuses.get(entry);
      if (!existing?.switched) {
        await this.switchProductEntry(entry, session, operator);
      }
    }
  }

  getChannelStatus(channel: CutoverChannel): ChannelSwitchStatus {
    return (
      this.channelStatuses.get(channel) ?? {
        channel,
        switched: false,
        switchedAt: null,
        switchedBy: null,
        sessionId: null,
        legacyFrozen: false,
      }
    );
  }

  getAllChannelStatuses(): readonly ChannelSwitchStatus[] {
    return ALL_CUTOVER_CHANNELS.map((c) => this.getChannelStatus(c));
  }

  getProductEntryStatus(entry: ProductEntry): ProductEntrySwitchStatus {
    return (
      this.productEntryStatuses.get(entry) ?? {
        entry,
        switched: false,
        legacyFallbackEnabled: true,
        switchedAt: null,
        sessionId: null,
      }
    );
  }

  getAllProductEntryStatuses(): readonly ProductEntrySwitchStatus[] {
    return ALL_PRODUCT_ENTRIES.map((e) => this.getProductEntryStatus(e));
  }

  isAllChannelsSwitched(): boolean {
    return ALL_CUTOVER_CHANNELS.every((c) => this.channelStatuses.get(c)?.switched === true);
  }

  isAllProductEntriesSwitched(): boolean {
    return ALL_PRODUCT_ENTRIES.every(
      (e) =>
        this.productEntryStatuses.get(e)?.switched === true &&
        this.productEntryStatuses.get(e)?.legacyFallbackEnabled === false,
    );
  }

  async runPostCutoverVerifications(
    session: CutoverSession,
  ): Promise<PostCutoverVerificationReport> {
    const report = await runPostCutoverVerifications(session, this.options.verifiers);
    this.lastVerificationReport = report;
    return report;
  }

  /**
   * 完整切换入口（编排器调用）。
   * 流程：门禁校验 → 切换通道 → 切换产品入口 → 切换后验证。
   * 任一步骤失败抛 V11EntrySwitchError。
   */
  async openV11Entry(sessionId: string): Promise<PostCutoverVerificationReport> {
    const session = this.options.sessionStore.getSession(sessionId);
    if (!session) {
      throw new V11EntrySwitchError(`切换会话不存在：${sessionId}`, sessionId, "getSession");
    }

    // 步骤 1：DeploymentRoute 门禁校验
    const gateReport = await this.verifyDeploymentRouteGates(session);
    if (!gateReport.passed) {
      throw new V11EntrySwitchError(
        `DeploymentRoute 门禁校验失败：${gateReport.failedGates.join("; ")}`,
        sessionId,
        "verifyDeploymentRouteGates",
      );
    }

    // 步骤 2：切换全部通道到 V11
    try {
      await this.switchAllChannels(session, session.initiatedBy);
    } catch (err) {
      if (err instanceof V11EntrySwitchError) throw err;
      throw new V11EntrySwitchError(
        `切换通道失败：${err instanceof Error ? err.message : String(err)}`,
        sessionId,
        "switchAllChannels",
      );
    }

    // 步骤 3：切换全部产品入口到 V11（禁用旧字段兜底）
    try {
      await this.switchAllProductEntries(session, session.initiatedBy);
    } catch (err) {
      if (err instanceof V11EntrySwitchError) throw err;
      throw new V11EntrySwitchError(
        `切换产品入口失败：${err instanceof Error ? err.message : String(err)}`,
        sessionId,
        "switchAllProductEntries",
      );
    }

    // 步骤 4：切换后立即验证
    const verificationReport = await this.runPostCutoverVerifications(session);
    if (!verificationReport.passed) {
      throw new V11EntrySwitchError(
        `切换后验证未通过：${verificationReport.failedVerifications.join("; ")}`,
        sessionId,
        "runPostCutoverVerifications",
      );
    }

    return verificationReport;
  }

  /** 获取最后一次门禁校验报告（测试用）。 */
  getLastGateReport(): DeploymentRouteGateReport | null {
    return this.lastGateReport;
  }

  /** 获取最后一次验证报告（测试用）。 */
  getLastVerificationReport(): PostCutoverVerificationReport | null {
    return this.lastVerificationReport;
  }
}

// ─── 内存操作器实现（测试用） ──────────────────────────────

/** 内存通道切换操作器（测试用）。 */
export class InMemoryChannelSwitchOperator implements ChannelSwitchOperator {
  private readonly switchedChannels = new Set<CutoverChannel>();
  /** 切换时抛错的通道（用于测试失败场景）。 */
  readonly failingChannels = new Set<CutoverChannel>();

  async switchToV11(channel: CutoverChannel, _sessionId: string): Promise<void> {
    if (this.failingChannels.has(channel)) {
      throw new Error(`通道 ${channel} 切换失败（模拟）`);
    }
    this.switchedChannels.add(channel);
  }

  isSwitched(channel: CutoverChannel): boolean {
    return this.switchedChannels.has(channel);
  }
}

/** 内存产品入口切换操作器（测试用）。 */
export class InMemoryProductEntrySwitchOperator implements ProductEntrySwitchOperator {
  private readonly switchedEntries = new Set<ProductEntry>();
  readonly failingEntries = new Set<ProductEntry>();

  async switchToV11(entry: ProductEntry, _sessionId: string): Promise<void> {
    if (this.failingEntries.has(entry)) {
      throw new Error(`产品入口 ${entry} 切换失败（模拟）`);
    }
    this.switchedEntries.add(entry);
  }

  isSwitched(entry: ProductEntry): boolean {
    return this.switchedEntries.has(entry);
  }
}
