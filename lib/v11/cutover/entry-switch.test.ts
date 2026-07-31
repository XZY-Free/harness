import {
  ALL_CUTOVER_CHANNELS,
  ALL_DEPLOYMENT_ROUTE_GATES,
  ALL_POST_CUTOVER_VERIFICATIONS,
  ALL_PRODUCT_ENTRIES,
} from "@/lib/v11/cutover/entry-switch-contract";
import {
  InMemoryChannelSwitchOperator,
  InMemoryProductEntrySwitchOperator,
  InMemoryV11EntrySwitcher,
  V11EntrySwitchError,
} from "@/lib/v11/cutover/entry-switcher";
import {
  type AdminPublishChecker,
  AdminPublishVerifier,
  type ChildThreadCreator,
  ChildThreadVerifier,
  ConsecutiveTurnsVerifier,
  CreateThreadVerifier,
  type DesktopChecker,
  DesktopVerifier,
  type JobRunner,
  JobVerifier,
  type LocalAuthChecker,
  LocalAuthorizationVerifier,
  type PostCutoverVerifier,
  type ThreadCreator,
  ToolEffectVerifier,
  type ToolExecutor,
  type TraceChecker,
  TraceVerifier,
  type TurnRunner,
  formatPostCutoverReport,
  getAllVerificationTypes,
  runPostCutoverVerifications,
} from "@/lib/v11/cutover/post-cutover-verifier";
import {
  DeploymentRouteGateError,
  DeploymentRouteGatekeeper,
  InMemoryCapacityGateProvider,
  InMemoryConformanceGateProvider,
  InMemoryHealthGateProvider,
  InMemorySecurityGateProvider,
} from "@/lib/v11/cutover/route-gatekeeper";
import {
  type CutoverSessionStore,
  InMemoryCutoverSessionStore,
} from "@/lib/v11/cutover/session-store";
/**
 * S13-W05 API、Runtime 与产品入口切换集成测试。
 *
 * 覆盖：
 * - 契约定义：4 通道 + 3 端 + 9 项验证 + 门禁维度
 * - DeploymentRoute 门禁校验器：4 维门禁并行校验、失败检测、异常处理、断言模式
 * - 切换后验证器：9 项标准验证器 + 报告生成 + 格式化
 * - V11 入口切换器：通道切换、产品入口切换、完整 openV11Entry 流程、失败场景
 *
 * 不依赖真实数据库，全部使用内存实现与 mock Provider。
 */
import { beforeEach, describe, expect, it } from "vitest";

// ═══════════════════════════════════════════════════════════
// 1. 契约定义
// ═══════════════════════════════════════════════════════════

describe("S13-W05 切换契约定义", () => {
  it("4 个切换通道全部定义", () => {
    expect(ALL_CUTOVER_CHANNELS).toHaveLength(4);
    expect(ALL_CUTOVER_CHANNELS).toContain("employee_api");
    expect(ALL_CUTOVER_CHANNELS).toContain("admin_api");
    expect(ALL_CUTOVER_CHANNELS).toContain("runtime_event_ingress");
    expect(ALL_CUTOVER_CHANNELS).toContain("command_channel");
  });

  it("3 个产品入口全部定义", () => {
    expect(ALL_PRODUCT_ENTRIES).toHaveLength(3);
    expect(ALL_PRODUCT_ENTRIES).toContain("web");
    expect(ALL_PRODUCT_ENTRIES).toContain("desktop");
    expect(ALL_PRODUCT_ENTRIES).toContain("studio");
  });

  it("9 项切换后验证全部定义", () => {
    expect(ALL_POST_CUTOVER_VERIFICATIONS).toHaveLength(9);
    expect(ALL_POST_CUTOVER_VERIFICATIONS).toContain("create_thread");
    expect(ALL_POST_CUTOVER_VERIFICATIONS).toContain("consecutive_turns");
    expect(ALL_POST_CUTOVER_VERIFICATIONS).toContain("tool_effect");
    expect(ALL_POST_CUTOVER_VERIFICATIONS).toContain("desktop");
    expect(ALL_POST_CUTOVER_VERIFICATIONS).toContain("local_authorization");
    expect(ALL_POST_CUTOVER_VERIFICATIONS).toContain("child_thread");
    expect(ALL_POST_CUTOVER_VERIFICATIONS).toContain("job");
    expect(ALL_POST_CUTOVER_VERIFICATIONS).toContain("admin_publish");
    expect(ALL_POST_CUTOVER_VERIFICATIONS).toContain("trace");
  });

  it("4 个 DeploymentRoute 门禁维度全部定义", () => {
    expect(ALL_DEPLOYMENT_ROUTE_GATES).toHaveLength(4);
    expect(ALL_DEPLOYMENT_ROUTE_GATES).toContain("conformance");
    expect(ALL_DEPLOYMENT_ROUTE_GATES).toContain("health");
    expect(ALL_DEPLOYMENT_ROUTE_GATES).toContain("capacity");
    expect(ALL_DEPLOYMENT_ROUTE_GATES).toContain("security");
  });

  it("getAllVerificationTypes 返回全部验证项", () => {
    expect(getAllVerificationTypes()).toHaveLength(9);
    expect(getAllVerificationTypes()).toEqual(ALL_POST_CUTOVER_VERIFICATIONS);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. DeploymentRoute 门禁校验器
// ═══════════════════════════════════════════════════════════

describe("S13-W05 DeploymentRoute 门禁校验器", () => {
  let store: CutoverSessionStore;
  let conformance: InMemoryConformanceGateProvider;
  let health: InMemoryHealthGateProvider;
  let capacity: InMemoryCapacityGateProvider;
  let security: InMemorySecurityGateProvider;
  let gatekeeper: DeploymentRouteGatekeeper;

  beforeEach(() => {
    store = new InMemoryCutoverSessionStore();
    conformance = new InMemoryConformanceGateProvider();
    health = new InMemoryHealthGateProvider();
    capacity = new InMemoryCapacityGateProvider();
    security = new InMemorySecurityGateProvider();
    gatekeeper = new DeploymentRouteGatekeeper({ conformance, health, capacity, security });
  });

  it("全部门禁通过时返回 passed=true", async () => {
    const runtimeRevisionId = "rr-001";
    conformance.markPassed(runtimeRevisionId);
    health.markHealthy(runtimeRevisionId);
    capacity.markCapacityReady(runtimeRevisionId);
    security.markSecure(runtimeRevisionId);

    const session = store.createSession("initiator-1");
    const report = await gatekeeper.verifyGates("dr-001", "agent-001", runtimeRevisionId, session);

    expect(report.passed).toBe(true);
    expect(report.failedGates).toHaveLength(0);
    expect(report.gateResults).toHaveLength(4);
    for (const gate of report.gateResults) {
      expect(gate.passed).toBe(true);
      expect(gate.runtimeRevisionId).toBe(runtimeRevisionId);
    }
  });

  it("conformance 未通过时返回 passed=false", async () => {
    const runtimeRevisionId = "rr-002";
    health.markHealthy(runtimeRevisionId);
    capacity.markCapacityReady(runtimeRevisionId);
    security.markSecure(runtimeRevisionId);
    // conformance 未标记通过

    const session = store.createSession("initiator-1");
    const report = await gatekeeper.verifyGates("dr-002", "agent-002", runtimeRevisionId, session);

    expect(report.passed).toBe(false);
    expect(report.failedGates.length).toBe(1);
    expect(report.failedGates[0]).toContain("conformance");
  });

  it("多维度未通过时全部报告", async () => {
    const runtimeRevisionId = "rr-003";
    // 仅 security 通过
    security.markSecure(runtimeRevisionId);

    const session = store.createSession("initiator-1");
    const report = await gatekeeper.verifyGates("dr-003", "agent-003", runtimeRevisionId, session);

    expect(report.passed).toBe(false);
    expect(report.failedGates.length).toBe(3);
    expect(report.failedGates.some((g) => g.includes("conformance"))).toBe(true);
    expect(report.failedGates.some((g) => g.includes("health"))).toBe(true);
    expect(report.failedGates.some((g) => g.includes("capacity"))).toBe(true);
  });

  it("verifyGatesOrThrow 全部通过时返回报告", async () => {
    const runtimeRevisionId = "rr-004";
    conformance.markPassed(runtimeRevisionId);
    health.markHealthy(runtimeRevisionId);
    capacity.markCapacityReady(runtimeRevisionId);
    security.markSecure(runtimeRevisionId);

    const session = store.createSession("initiator-1");
    const report = await gatekeeper.verifyGatesOrThrow(
      "dr-004",
      "agent-004",
      runtimeRevisionId,
      session,
    );

    expect(report.passed).toBe(true);
  });

  it("verifyGatesOrThrow 失败时抛 DeploymentRouteGateError", async () => {
    const runtimeRevisionId = "rr-005";
    // 全部未通过

    const session = store.createSession("initiator-1");
    await expect(
      gatekeeper.verifyGatesOrThrow("dr-005", "agent-005", runtimeRevisionId, session),
    ).rejects.toThrow(DeploymentRouteGateError);
  });

  it("门禁检查异常被捕获为失败", async () => {
    const throwingConformance = {
      verifyConformance: async () => {
        throw new Error("conformance 服务不可用");
      },
    };
    const throwingGatekeeper = new DeploymentRouteGatekeeper({
      conformance: throwingConformance,
      health,
      capacity,
      security,
    });

    const session = store.createSession("initiator-1");
    const report = await throwingGatekeeper.verifyGates("dr-006", "agent-006", "rr-006", session);

    expect(report.passed).toBe(false);
    const conformanceGate = report.gateResults.find((g) => g.dimension === "conformance");
    expect(conformanceGate?.passed).toBe(false);
    expect(conformanceGate?.details).toContain("conformance 服务不可用");
  });

  it("getAllGateDimensions 返回 4 个维度", () => {
    expect(gatekeeper.getAllGateDimensions()).toHaveLength(4);
    expect(gatekeeper.getAllGateDimensions()).toEqual(ALL_DEPLOYMENT_ROUTE_GATES);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 切换后验证器
// ═══════════════════════════════════════════════════════════

describe("S13-W05 切换后验证器", () => {
  let store: CutoverSessionStore;

  beforeEach(() => {
    store = new InMemoryCutoverSessionStore();
  });

  /** 构造全部通过的 mock Provider。 */
  function createPassingProviders() {
    const threadCreator: ThreadCreator = {
      createTestThread: async () => ({ threadId: "thread-test-001" }),
    };
    const turnRunner: TurnRunner = {
      runTurn: async (threadId, _msg) => ({ turnId: `turn-${threadId}-${Date.now()}` }),
    };
    const toolExecutor: ToolExecutor = {
      executeTool: async () => ({ toolCallId: "tc-001" }),
    };
    const desktopChecker: DesktopChecker = {
      verifyDesktop: async () => ({
        passed: true,
        details: "Desktop 验证通过",
        deviceId: "device-001",
      }),
    };
    const localAuthChecker: LocalAuthChecker = {
      verifyLocalAuth: async () => ({ passed: true, details: "本地授权通过" }),
    };
    const childCreator: ChildThreadCreator = {
      createChildThread: async () => ({ threadId: "child-001" }),
    };
    const jobRunner: JobRunner = {
      runTestJob: async () => ({ jobId: "job-001" }),
    };
    const publishChecker: AdminPublishChecker = {
      verifyPublish: async () => ({
        passed: true,
        details: "管理发布通过",
        publishedResourceId: "skill-001",
      }),
    };
    const traceChecker: TraceChecker = {
      verifyTrace: async () => ({ passed: true, details: "Trace 通过", traceId: "trace-001" }),
    };
    return {
      threadCreator,
      turnRunner,
      toolExecutor,
      desktopChecker,
      localAuthChecker,
      childCreator,
      jobRunner,
      publishChecker,
      traceChecker,
    };
  }

  /** 构造全部 9 项验证器。 */
  function createAllVerifiers(
    providers: ReturnType<typeof createPassingProviders>,
  ): PostCutoverVerifier[] {
    return [
      new CreateThreadVerifier(providers.threadCreator),
      new ConsecutiveTurnsVerifier(providers.turnRunner, providers.threadCreator),
      new ToolEffectVerifier(providers.toolExecutor, providers.threadCreator),
      new DesktopVerifier(providers.desktopChecker),
      new LocalAuthorizationVerifier(providers.localAuthChecker),
      new ChildThreadVerifier(providers.childCreator, providers.threadCreator),
      new JobVerifier(providers.jobRunner),
      new AdminPublishVerifier(providers.publishChecker),
      new TraceVerifier(providers.traceChecker),
    ];
  }

  it("9 项验证全部通过", async () => {
    const providers = createPassingProviders();
    const verifiers = createAllVerifiers(providers);
    const session = store.createSession("initiator-1");

    const report = await runPostCutoverVerifications(session, verifiers);

    expect(report.passed).toBe(true);
    expect(report.passedCount).toBe(9);
    expect(report.failedCount).toBe(0);
    expect(report.results).toHaveLength(9);
    expect(report.failedVerifications).toHaveLength(0);
  });

  it("单项验证失败不影响其他验证", async () => {
    const providers = createPassingProviders();
    // 让 Tool 验证失败
    providers.toolExecutor = {
      executeTool: async () => {
        throw new Error("Tool 执行失败");
      },
    };
    const verifiers = createAllVerifiers(providers);
    const session = store.createSession("initiator-1");

    const report = await runPostCutoverVerifications(session, verifiers);

    expect(report.passed).toBe(false);
    expect(report.failedCount).toBe(1);
    expect(report.passedCount).toBe(8);
    expect(report.failedVerifications[0]).toContain("Tool 执行失败");
  });

  it("验证器异常被捕获为失败", async () => {
    const throwingVerifier: PostCutoverVerifier = {
      type: "create_thread",
      verify: async () => {
        throw new Error("验证器爆炸");
      },
    };
    const session = store.createSession("initiator-1");

    const report = await runPostCutoverVerifications(session, [throwingVerifier]);

    expect(report.passed).toBe(false);
    expect(report.results[0]?.passed).toBe(false);
    expect(report.results[0]?.details).toContain("验证器爆炸");
  });

  it("验证结果包含资源 ID 与耗时", async () => {
    const providers = createPassingProviders();
    const verifier = new CreateThreadVerifier(providers.threadCreator);
    const session = store.createSession("initiator-1");

    const result = await verifier.verify(session);

    expect(result.passed).toBe(true);
    expect(result.resourceId).toBe("thread-test-001");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("Desktop 验证失败时 resourceId 仍可记录", async () => {
    const desktopChecker: DesktopChecker = {
      verifyDesktop: async () => ({
        passed: false,
        details: "Desktop 连接失败",
        deviceId: "device-failed",
      }),
    };
    const verifier = new DesktopVerifier(desktopChecker);
    const session = store.createSession("initiator-1");

    const result = await verifier.verify(session);

    expect(result.passed).toBe(false);
    expect(result.resourceId).toBe("device-failed");
    expect(result.details).toContain("Desktop 连接失败");
  });

  it("ConsecutiveTurnsVerifier 创建两个连续 Turn", async () => {
    const providers = createPassingProviders();
    const verifier = new ConsecutiveTurnsVerifier(providers.turnRunner, providers.threadCreator);
    const session = store.createSession("initiator-1");

    const result = await verifier.verify(session);

    expect(result.passed).toBe(true);
    expect(result.details).toContain("Turn");
    expect(result.details).toContain("→");
  });

  it("formatPostCutoverReport 生成可读报告", async () => {
    const providers = createPassingProviders();
    const verifiers = createAllVerifiers(providers);
    const session = store.createSession("initiator-1");

    const report = await runPostCutoverVerifications(session, verifiers);
    const formatted = formatPostCutoverReport(report);

    expect(formatted).toContain("V11 切换后验证报告");
    expect(formatted).toContain(session.id);
    expect(formatted).toContain("通过: 9/9");
    expect(formatted).toContain("create_thread");
    expect(formatted).toContain("trace");
  });

  it("formatPostCutoverReport 包含失败项详情", async () => {
    const providers = createPassingProviders();
    providers.toolExecutor = {
      executeTool: async () => {
        throw new Error("Tool 不可用");
      },
    };
    const verifiers = createAllVerifiers(providers);
    const session = store.createSession("initiator-1");

    const report = await runPostCutoverVerifications(session, verifiers);
    const formatted = formatPostCutoverReport(report);

    expect(formatted).toContain("失败: 1");
    expect(formatted).toContain("失败项");
    expect(formatted).toContain("Tool 不可用");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. V11 入口切换器
// ═══════════════════════════════════════════════════════════

describe("S13-W05 V11 入口切换器", () => {
  let store: CutoverSessionStore;
  let conformance: InMemoryConformanceGateProvider;
  let health: InMemoryHealthGateProvider;
  let capacity: InMemoryCapacityGateProvider;
  let security: InMemorySecurityGateProvider;
  let gatekeeper: DeploymentRouteGatekeeper;
  let channelOperator: InMemoryChannelSwitchOperator;
  let productEntryOperator: InMemoryProductEntrySwitchOperator;
  let verifiers: PostCutoverVerifier[];
  let switcher: InMemoryV11EntrySwitcher;

  beforeEach(() => {
    store = new InMemoryCutoverSessionStore();
    conformance = new InMemoryConformanceGateProvider();
    health = new InMemoryHealthGateProvider();
    capacity = new InMemoryCapacityGateProvider();
    security = new InMemorySecurityGateProvider();
    gatekeeper = new DeploymentRouteGatekeeper({ conformance, health, capacity, security });
    channelOperator = new InMemoryChannelSwitchOperator();
    productEntryOperator = new InMemoryProductEntrySwitchOperator();

    // 全部通过的验证器
    const threadCreator: ThreadCreator = {
      createTestThread: async () => ({ threadId: "thread-001" }),
    };
    verifiers = [
      {
        type: "create_thread",
        verify: async () => ({
          type: "create_thread",
          passed: true,
          details: "通过",
          resourceId: "thread-001",
          timestamp: new Date().toISOString(),
          durationMs: 10,
        }),
      },
      {
        type: "consecutive_turns",
        verify: async () => ({
          type: "consecutive_turns",
          passed: true,
          details: "通过",
          resourceId: "thread-001",
          timestamp: new Date().toISOString(),
          durationMs: 20,
        }),
      },
      {
        type: "tool_effect",
        verify: async () => ({
          type: "tool_effect",
          passed: true,
          details: "通过",
          resourceId: "tc-001",
          timestamp: new Date().toISOString(),
          durationMs: 15,
        }),
      },
      {
        type: "desktop",
        verify: async () => ({
          type: "desktop",
          passed: true,
          details: "通过",
          resourceId: "device-001",
          timestamp: new Date().toISOString(),
          durationMs: 30,
        }),
      },
      {
        type: "local_authorization",
        verify: async () => ({
          type: "local_authorization",
          passed: true,
          details: "通过",
          resourceId: null,
          timestamp: new Date().toISOString(),
          durationMs: 5,
        }),
      },
      {
        type: "child_thread",
        verify: async () => ({
          type: "child_thread",
          passed: true,
          details: "通过",
          resourceId: "child-001",
          timestamp: new Date().toISOString(),
          durationMs: 25,
        }),
      },
      {
        type: "job",
        verify: async () => ({
          type: "job",
          passed: true,
          details: "通过",
          resourceId: "job-001",
          timestamp: new Date().toISOString(),
          durationMs: 40,
        }),
      },
      {
        type: "admin_publish",
        verify: async () => ({
          type: "admin_publish",
          passed: true,
          details: "通过",
          resourceId: "skill-001",
          timestamp: new Date().toISOString(),
          durationMs: 35,
        }),
      },
      {
        type: "trace",
        verify: async () => ({
          type: "trace",
          passed: true,
          details: "通过",
          resourceId: "trace-001",
          timestamp: new Date().toISOString(),
          durationMs: 12,
        }),
      },
    ];

    switcher = new InMemoryV11EntrySwitcher({
      sessionStore: store,
      gatekeeper,
      verifiers,
      channelOperator,
      productEntryOperator,
      deploymentRoute: {
        routeId: "dr-001",
        agentId: "agent-001",
        runtimeRevisionId: "rr-001",
      },
    });
  });

  it("初始状态全部通道未切换", () => {
    expect(switcher.isAllChannelsSwitched()).toBe(false);
    for (const status of switcher.getAllChannelStatuses()) {
      expect(status.switched).toBe(false);
      expect(status.legacyFrozen).toBe(false);
      expect(status.switchedAt).toBeNull();
    }
  });

  it("初始状态全部产品入口未切换且保留旧字段兜底", () => {
    expect(switcher.isAllProductEntriesSwitched()).toBe(false);
    for (const status of switcher.getAllProductEntryStatuses()) {
      expect(status.switched).toBe(false);
      expect(status.legacyFallbackEnabled).toBe(true); // 初始保留旧字段兜底
    }
  });

  it("switchChannel 切换指定通道", async () => {
    const session = store.createSession("initiator-1");
    await switcher.switchChannel("employee_api", session, "operator-1");

    const status = switcher.getChannelStatus("employee_api");
    expect(status.switched).toBe(true);
    expect(status.switchedBy).toBe("operator-1");
    expect(status.sessionId).toBe(session.id);
    expect(status.legacyFrozen).toBe(true);
    expect(status.switchedAt).not.toBeNull();
    expect(channelOperator.isSwitched("employee_api")).toBe(true);
  });

  it("switchChannel 重复切换抛错", async () => {
    const session = store.createSession("initiator-1");
    await switcher.switchChannel("employee_api", session, "operator-1");
    await expect(switcher.switchChannel("employee_api", session, "operator-1")).rejects.toThrow(
      V11EntrySwitchError,
    );
  });

  it("switchAllChannels 批量切换全部通道", async () => {
    const session = store.createSession("initiator-1");
    await switcher.switchAllChannels(session, "operator-1");

    expect(switcher.isAllChannelsSwitched()).toBe(true);
    for (const channel of ALL_CUTOVER_CHANNELS) {
      expect(switcher.getChannelStatus(channel).switched).toBe(true);
      expect(channelOperator.isSwitched(channel)).toBe(true);
    }
  });

  it("switchProductEntry 切换指定产品入口并禁用旧字段兜底", async () => {
    const session = store.createSession("initiator-1");
    await switcher.switchProductEntry("web", session, "operator-1");

    const status = switcher.getProductEntryStatus("web");
    expect(status.switched).toBe(true);
    expect(status.legacyFallbackEnabled).toBe(false); // S13-W05 要求不保留旧字段兜底
    expect(status.sessionId).toBe(session.id);
    expect(productEntryOperator.isSwitched("web")).toBe(true);
  });

  it("switchAllProductEntries 批量切换全部产品入口", async () => {
    const session = store.createSession("initiator-1");
    await switcher.switchAllProductEntries(session, "operator-1");

    expect(switcher.isAllProductEntriesSwitched()).toBe(true);
    for (const entry of ALL_PRODUCT_ENTRIES) {
      expect(switcher.getProductEntryStatus(entry).switched).toBe(true);
      expect(switcher.getProductEntryStatus(entry).legacyFallbackEnabled).toBe(false);
      expect(productEntryOperator.isSwitched(entry)).toBe(true);
    }
  });

  it("verifyDeploymentRouteGates 全部门禁通过", async () => {
    const runtimeRevisionId = "rr-001";
    conformance.markPassed(runtimeRevisionId);
    health.markHealthy(runtimeRevisionId);
    capacity.markCapacityReady(runtimeRevisionId);
    security.markSecure(runtimeRevisionId);

    const session = store.createSession("initiator-1");
    const report = await switcher.verifyDeploymentRouteGates(session);

    expect(report.passed).toBe(true);
    expect(report.deploymentRouteId).toBe("dr-001");
    expect(report.runtimeRevisionId).toBe(runtimeRevisionId);
  });

  it("runPostCutoverVerifications 全部验证通过", async () => {
    const session = store.createSession("initiator-1");
    const report = await switcher.runPostCutoverVerifications(session);

    expect(report.passed).toBe(true);
    expect(report.passedCount).toBe(9);
    expect(report.failedCount).toBe(0);
  });

  it("完整 openV11Entry 流程成功", async () => {
    const runtimeRevisionId = "rr-001";
    conformance.markPassed(runtimeRevisionId);
    health.markHealthy(runtimeRevisionId);
    capacity.markCapacityReady(runtimeRevisionId);
    security.markSecure(runtimeRevisionId);

    const session = store.createSession("initiator-1");
    const report = await switcher.openV11Entry(session.id);

    expect(report.passed).toBe(true);
    expect(switcher.isAllChannelsSwitched()).toBe(true);
    expect(switcher.isAllProductEntriesSwitched()).toBe(true);
    expect(switcher.getLastGateReport()?.passed).toBe(true);
    expect(switcher.getLastVerificationReport()?.passed).toBe(true);
  });

  it("门禁校验失败时 openV11Entry 抛错", async () => {
    // 不标记任何门禁通过
    const session = store.createSession("initiator-1");

    await expect(switcher.openV11Entry(session.id)).rejects.toThrow(V11EntrySwitchError);
    expect(switcher.isAllChannelsSwitched()).toBe(false);
  });

  it("通道切换失败时 openV11Entry 抛错", async () => {
    const runtimeRevisionId = "rr-001";
    conformance.markPassed(runtimeRevisionId);
    health.markHealthy(runtimeRevisionId);
    capacity.markCapacityReady(runtimeRevisionId);
    security.markSecure(runtimeRevisionId);

    // 让 employee_api 通道切换失败
    channelOperator.failingChannels.add("employee_api");

    const session = store.createSession("initiator-1");
    await expect(switcher.openV11Entry(session.id)).rejects.toThrow(V11EntrySwitchError);
    // 部分通道可能已切换，但不是全部
    expect(switcher.isAllChannelsSwitched()).toBe(false);
  });

  it("产品入口切换失败时 openV11Entry 抛错", async () => {
    const runtimeRevisionId = "rr-001";
    conformance.markPassed(runtimeRevisionId);
    health.markHealthy(runtimeRevisionId);
    capacity.markCapacityReady(runtimeRevisionId);
    security.markSecure(runtimeRevisionId);

    // 让 desktop 入口切换失败
    productEntryOperator.failingEntries.add("desktop");

    const session = store.createSession("initiator-1");
    await expect(switcher.openV11Entry(session.id)).rejects.toThrow(V11EntrySwitchError);
    expect(switcher.isAllProductEntriesSwitched()).toBe(false);
  });

  it("切换后验证失败时 openV11Entry 抛错", async () => {
    const runtimeRevisionId = "rr-001";
    conformance.markPassed(runtimeRevisionId);
    health.markHealthy(runtimeRevisionId);
    capacity.markCapacityReady(runtimeRevisionId);
    security.markSecure(runtimeRevisionId);

    // 替换为失败的验证器
    const failingSwitcher = new InMemoryV11EntrySwitcher({
      sessionStore: store,
      gatekeeper,
      verifiers: [
        {
          type: "create_thread",
          verify: async () => ({
            type: "create_thread",
            passed: false,
            details: "Thread 创建失败",
            resourceId: null,
            timestamp: new Date().toISOString(),
            durationMs: 10,
          }),
        },
      ],
      channelOperator,
      productEntryOperator,
      deploymentRoute: {
        routeId: "dr-001",
        agentId: "agent-001",
        runtimeRevisionId,
      },
    });

    const session = store.createSession("initiator-1");
    await expect(failingSwitcher.openV11Entry(session.id)).rejects.toThrow(/Thread 创建失败/);
  });

  it("会话不存在时 openV11Entry 抛错", async () => {
    await expect(switcher.openV11Entry("nonexistent")).rejects.toThrow(/切换会话不存在/);
  });
});
