import {
  type BackupExecutor,
  type ConsistencyVerifier,
  CutoverOrchestrator,
  type IncrementalMigrationExecutor,
  type V11EntryOpener,
} from "@/lib/v11/cutover/orchestrator";
import {
  type AlertProvider,
  AlertSilenceCheck,
  type BackupProvider,
  BackupReadyCheck,
  CapacityPrecheck,
  type CapacityProvider,
  OnCallOperatorCheck,
  type Precheck,
  RestorePointVerifiedCheck,
  RollbackOwnerCheck,
  formatPrecheckReport,
  runPrechecks,
} from "@/lib/v11/cutover/precheck";
import {
  RollbackController,
  RollbackError,
  type V11Isolator,
  isRollbackAllowed,
} from "@/lib/v11/cutover/rollback";
import {
  type CutoverSessionStore,
  InMemoryCutoverSessionStore,
} from "@/lib/v11/cutover/session-store";
import {
  CUTOVER_WINDOW_STATES,
  TERMINAL_STATES,
  buildStepRecord,
  clearTransitionGuards,
  getLegalNextStates,
  isInCutoverWindow,
  isLegalTransition,
  isTerminalState,
  registerTransitionGuard,
  runTransitionGuards,
} from "@/lib/v11/cutover/state-machine";
import {
  ALL_WRITE_ENTRY_POINTS,
  InMemoryWriteFreezeController,
  type WriteFreezeController,
  WriteFrozenError,
} from "@/lib/v11/cutover/write-freeze";
/**
 * S13-W04 切换窗口与旧写入冻结集成测试。
 *
 * 覆盖：
 * - 状态机：合法/非法转换、终态、切换窗口判定、守卫注册与执行
 * - 会话存储：创建/更新/步骤追加/互斥会话
 * - 写入冻结控制器：冻结/解冻/批量操作/WriteFrozenError/进行中探测
 * - 前置检查：6 项标准检查 + 报告生成 + 格式化
 * - 回滚控制器：切换窗口内回滚成功、终态拒绝回滚、V11 隔离失败
 * - 编排器：完整切换成功流程、各步骤失败触发回滚
 *
 * 不依赖真实数据库，全部使用内存实现与 mock Provider。
 */
import { beforeEach, describe, expect, it } from "vitest";

// ═══════════════════════════════════════════════════════════
// 1. 状态机
// ═══════════════════════════════════════════════════════════

describe("S13-W04 切换状态机", () => {
  beforeEach(() => {
    clearTransitionGuards();
  });

  it("合法状态转换全部识别", () => {
    expect(isLegalTransition("idle", "precheck")).toBe(true);
    expect(isLegalTransition("precheck", "backup_ready")).toBe(true);
    expect(isLegalTransition("backup_ready", "write_frozen")).toBe(true);
    expect(isLegalTransition("write_frozen", "drained")).toBe(true);
    expect(isLegalTransition("drained", "incremental_migration")).toBe(true);
    expect(isLegalTransition("incremental_migration", "cutover_ready")).toBe(true);
    expect(isLegalTransition("cutover_ready", "cutover_completed")).toBe(true);
    // 任意切换窗口内状态可回滚
    expect(isLegalTransition("precheck", "rolled_back")).toBe(true);
    expect(isLegalTransition("write_frozen", "rolled_back")).toBe(true);
    expect(isLegalTransition("cutover_ready", "rolled_back")).toBe(true);
  });

  it("非法状态转换被拒绝", () => {
    expect(isLegalTransition("idle", "write_frozen")).toBe(false); // 跳过 precheck
    expect(isLegalTransition("idle", "cutover_completed")).toBe(false); // 跳过全部
    expect(isLegalTransition("write_frozen", "cutover_completed")).toBe(false); // 跳过中间
    expect(isLegalTransition("cutover_completed", "rolled_back")).toBe(false); // 终态不可回滚
    expect(isLegalTransition("rolled_back", "cutover_completed")).toBe(false); // 终态不可前进
    expect(isLegalTransition("cutover_completed", "idle")).toBe(false); // 终态不可回退
  });

  it("终态判定正确", () => {
    expect(isTerminalState("cutover_completed")).toBe(true);
    expect(isTerminalState("rolled_back")).toBe(true);
    expect(isTerminalState("idle")).toBe(false);
    expect(isTerminalState("write_frozen")).toBe(false);
    expect(TERMINAL_STATES.size).toBe(2);
  });

  it("切换窗口判定正确", () => {
    expect(isInCutoverWindow("write_frozen")).toBe(true);
    expect(isInCutoverWindow("drained")).toBe(true);
    expect(isInCutoverWindow("incremental_migration")).toBe(true);
    expect(isInCutoverWindow("cutover_ready")).toBe(true);
    expect(isInCutoverWindow("idle")).toBe(false);
    expect(isInCutoverWindow("precheck")).toBe(false);
    expect(isInCutoverWindow("cutover_completed")).toBe(false);
    expect(isInCutoverWindow("rolled_back")).toBe(false);
    expect(CUTOVER_WINDOW_STATES.size).toBe(4);
  });

  it("getLegalNextStates 返回合法后继", () => {
    expect(getLegalNextStates("idle")).toEqual(["precheck"]);
    expect(getLegalNextStates("precheck")).toContain("backup_ready");
    expect(getLegalNextStates("precheck")).toContain("rolled_back");
    expect(getLegalNextStates("cutover_completed")).toEqual([]);
    expect(getLegalNextStates("rolled_back")).toEqual([]);
  });

  it("守卫注册与执行", () => {
    const store = new InMemoryCutoverSessionStore();
    const session = store.createSession("operator-1");

    // 注册守卫：precheck → backup_ready 要求 onCallOperator 已设置
    registerTransitionGuard("precheck", "backup_ready", (s) => ({
      passed: s.onCallOperator !== null,
      reason: s.onCallOperator ? "" : "值守人员未指定",
    }));

    // 未设置值守人员时守卫失败
    let result = runTransitionGuards("precheck", "backup_ready", session);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("值守人员未指定");

    // 设置值守人员后守卫通过
    const updated = store.updateSession(session.id, { onCallOperator: "oncall-1" });
    result = runTransitionGuards("precheck", "backup_ready", updated);
    expect(result.passed).toBe(true);
  });

  it("注册守卫到非法转换抛错", () => {
    expect(() =>
      registerTransitionGuard("idle", "cutover_completed", () => ({ passed: true, reason: "" })),
    ).toThrow(/非法状态转换/);
  });

  it("buildStepRecord 构造步骤记录", () => {
    const record = buildStepRecord(
      {
        sessionId: "session-1",
        from: "idle",
        to: "precheck",
        operator: "op-1",
        reason: "启动",
      },
      { passed: true, reason: "" },
    );
    expect(record.sessionId).toBe("session-1");
    expect(record.fromState).toBe("idle");
    expect(record.toState).toBe("precheck");
    expect(record.operator).toBe("op-1");
    expect(record.reason).toBe("启动");
    expect(record.success).toBe(true);
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. 会话存储
// ═══════════════════════════════════════════════════════════

describe("S13-W04 切换会话存储", () => {
  let store: CutoverSessionStore;

  beforeEach(() => {
    store = new InMemoryCutoverSessionStore();
  });

  it("创建会话初始状态为 idle", () => {
    const session = store.createSession("initiator-1");
    expect(session.state).toBe("idle");
    expect(session.initiatedBy).toBe("initiator-1");
    expect(session.onCallOperator).toBeNull();
    expect(session.rollbackOwner).toBeNull();
    expect(session.completedAt).toBeNull();
    expect(session.backupRestorePoint).toBeNull();
  });

  it("更新会话字段", () => {
    const session = store.createSession("initiator-1");
    const updated = store.updateSession(session.id, {
      onCallOperator: "oncall-1",
      rollbackOwner: "rollback-1",
      state: "precheck",
    });
    expect(updated.onCallOperator).toBe("oncall-1");
    expect(updated.rollbackOwner).toBe("rollback-1");
    expect(updated.state).toBe("precheck");
    // updatedAt 应为有效 ISO 时间字符串
    expect(updated.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // updateSession 返回的对象应包含更新后的字段（非原始对象引用）
    expect(updated).not.toBe(session);
  });

  it("getActiveSession 返回非终态会话", () => {
    const session1 = store.createSession("initiator-1");
    expect(store.getActiveSession()?.id).toBe(session1.id);

    store.updateSession(session1.id, {
      state: "cutover_completed",
      completedAt: new Date().toISOString(),
    });
    expect(store.getActiveSession()).toBeUndefined();
  });

  it("互斥会话：存在活跃会话时拒绝创建新会话", () => {
    store.createSession("initiator-1");
    expect(() => store.createSession("initiator-2")).toThrow(/已存在活跃切换会话/);
  });

  it("终态会话后可创建新会话", () => {
    const session1 = store.createSession("initiator-1");
    store.updateSession(session1.id, {
      state: "rolled_back",
      completedAt: new Date().toISOString(),
    });
    const session2 = store.createSession("initiator-2");
    expect(session2.id).not.toBe(session1.id);
  });

  it("追加步骤记录与查询", () => {
    const session = store.createSession("initiator-1");
    store.appendStep({
      sessionId: session.id,
      fromState: "idle",
      toState: "precheck",
      operator: "op-1",
      reason: "启动",
      guardResult: "",
      timestamp: new Date().toISOString(),
      success: true,
    });
    const steps = store.getSteps(session.id);
    expect(steps.length).toBe(1);
    expect(steps[0]?.fromState).toBe("idle");
    expect(steps[0]?.toState).toBe("precheck");
  });

  it("listSessions 返回所有会话", () => {
    const s1 = store.createSession("initiator-1");
    store.updateSession(s1.id, { state: "rolled_back", completedAt: new Date().toISOString() });
    const s2 = store.createSession("initiator-2");
    expect(store.listSessions().length).toBe(2);
  });

  it("更新不存在的会话抛错", () => {
    expect(() => store.updateSession("nonexistent", { state: "precheck" })).toThrow(
      /切换会话不存在/,
    );
  });

  it("clear 清空所有数据", () => {
    const session = store.createSession("initiator-1");
    store.appendStep({
      sessionId: session.id,
      fromState: "idle",
      toState: "precheck",
      operator: "op-1",
      reason: "",
      guardResult: "",
      timestamp: new Date().toISOString(),
      success: true,
    });
    store.clear();
    expect(store.listSessions().length).toBe(0);
    expect(store.getSteps(session.id).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 写入冻结控制器
// ═══════════════════════════════════════════════════════════

describe("S13-W04 写入冻结控制器", () => {
  let controller: WriteFreezeController;
  let store: CutoverSessionStore;
  let session: ReturnType<CutoverSessionStore["createSession"]>;

  beforeEach(() => {
    store = new InMemoryCutoverSessionStore();
    controller = new InMemoryWriteFreezeController();
    session = store.createSession("initiator-1");
  });

  it("初始状态全部入口点未冻结", () => {
    expect(controller.isAllUnfrozen()).toBe(true);
    expect(controller.isAllFrozen()).toBe(false);
    expect(controller.getAllStatuses().length).toBe(ALL_WRITE_ENTRY_POINTS.length);
    for (const status of controller.getAllStatuses()) {
      expect(status.frozen).toBe(false);
      expect(status.frozenAt).toBeNull();
      expect(status.sessionId).toBeNull();
    }
  });

  it("freeze 冻结指定入口点", async () => {
    await controller.freeze("employee_api", session, "op-1", "切换冻结");
    const status = controller.getStatus("employee_api");
    expect(status.frozen).toBe(true);
    expect(status.frozenBy).toBe("op-1");
    expect(status.reason).toBe("切换冻结");
    expect(status.sessionId).toBe(session.id);
    expect(status.frozenAt).not.toBeNull();
  });

  it("freeze 重复冻结抛错", async () => {
    await controller.freeze("employee_api", session, "op-1", "切换冻结");
    await expect(controller.freeze("employee_api", session, "op-1", "再次冻结")).rejects.toThrow(
      /已冻结/,
    );
  });

  it("freezeAll 批量冻结所有入口点", async () => {
    await controller.freezeAll(session, "op-1", "切换窗口启动");
    expect(controller.isAllFrozen()).toBe(true);
    for (const ep of ALL_WRITE_ENTRY_POINTS) {
      expect(controller.getStatus(ep).frozen).toBe(true);
      expect(controller.getStatus(ep).sessionId).toBe(session.id);
    }
  });

  it("unfreeze 解冻指定入口点", async () => {
    await controller.freeze("employee_api", session, "op-1", "冻结");
    await controller.unfreeze("employee_api", "op-1", "回滚解冻");
    expect(controller.getStatus("employee_api").frozen).toBe(false);
  });

  it("unfreeze 幂等：未冻结时解冻不抛错", async () => {
    await expect(controller.unfreeze("employee_api", "op-1", "解冻")).resolves.toBeUndefined();
  });

  it("unfreezeAll 批量解冻", async () => {
    await controller.freezeAll(session, "op-1", "冻结");
    await controller.unfreezeAll("op-1", "回滚");
    expect(controller.isAllUnfrozen()).toBe(true);
  });

  it("assertNotFrozen 未冻结时不抛错", () => {
    expect(() => controller.assertNotFrozen("employee_api")).not.toThrow();
  });

  it("assertNotFrozen 冻结时抛 WriteFrozenError", async () => {
    await controller.freeze("employee_api", session, "op-1", "冻结");
    expect(() => controller.assertNotFrozen("employee_api")).toThrow(WriteFrozenError);
    try {
      controller.assertNotFrozen("employee_api");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteFrozenError);
      expect((err as WriteFrozenError).entryPoint).toBe("employee_api");
      expect((err as WriteFrozenError).sessionId).toBe(session.id);
    }
  });

  it("probeInFlight 默认返回已排空", async () => {
    const inFlight = await controller.probeInFlight();
    expect(inFlight.drained).toBe(true);
    expect(inFlight.invocations).toBe(0);
    expect(inFlight.toolCalls).toBe(0);
    expect(inFlight.effects).toBe(0);
    expect(inFlight.jobs).toBe(0);
  });

  it("probeInFlight 使用注册的探测函数", async () => {
    controller.registerInFlightProbe(() => ({
      invocations: 3,
      toolCalls: 2,
      effects: 1,
      jobs: 0,
      drained: false,
    }));
    const inFlight = await controller.probeInFlight();
    expect(inFlight.invocations).toBe(3);
    expect(inFlight.drained).toBe(false);
  });

  it("probeInFlight 支持异步探测函数", async () => {
    controller.registerInFlightProbe(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { invocations: 0, toolCalls: 0, effects: 0, jobs: 0, drained: true };
    });
    const inFlight = await controller.probeInFlight();
    expect(inFlight.drained).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 前置检查
// ═══════════════════════════════════════════════════════════

describe("S13-W04 切换前置检查", () => {
  let store: CutoverSessionStore;

  beforeEach(() => {
    store = new InMemoryCutoverSessionStore();
  });

  it("BackupReadyCheck 通过", async () => {
    const backupProvider: BackupProvider = {
      verifyBackup: async () => ({ ready: true, restorePointId: "rp-001", reason: "" }),
      verifyRestorePoint: async () => true,
    };
    const session = store.createSession("initiator-1");
    const check = new BackupReadyCheck(backupProvider);
    const result = await check.run(session);
    expect(result.passed).toBe(true);
    expect(result.details).toContain("rp-001");
  });

  it("BackupReadyCheck 失败", async () => {
    const backupProvider: BackupProvider = {
      verifyBackup: async () => ({ ready: false, restorePointId: "", reason: "备份任务未完成" }),
      verifyRestorePoint: async () => true,
    };
    const session = store.createSession("initiator-1");
    const check = new BackupReadyCheck(backupProvider);
    const result = await check.run(session);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("备份任务未完成");
  });

  it("BackupReadyCheck 异常处理", async () => {
    const backupProvider: BackupProvider = {
      verifyBackup: async () => {
        throw new Error("连接超时");
      },
      verifyRestorePoint: async () => true,
    };
    const session = store.createSession("initiator-1");
    const check = new BackupReadyCheck(backupProvider);
    const result = await check.run(session);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("连接超时");
  });

  it("RestorePointVerifiedCheck 未设置恢复点时失败", async () => {
    const backupProvider: BackupProvider = {
      verifyBackup: async () => ({ ready: true, restorePointId: "rp-001", reason: "" }),
      verifyRestorePoint: async () => true,
    };
    const session = store.createSession("initiator-1");
    const check = new RestorePointVerifiedCheck(backupProvider);
    const result = await check.run(session);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("未记录备份恢复点");
  });

  it("RestorePointVerifiedCheck 恢复点验证通过", async () => {
    const backupProvider: BackupProvider = {
      verifyBackup: async () => ({ ready: true, restorePointId: "rp-001", reason: "" }),
      verifyRestorePoint: async () => true,
    };
    const session = store.createSession("initiator-1");
    const updated = store.updateSession(session.id, { backupRestorePoint: "rp-001" });
    const check = new RestorePointVerifiedCheck(backupProvider);
    const result = await check.run(updated);
    expect(result.passed).toBe(true);
  });

  it("CapacityPrecheck 通过与失败", async () => {
    const readyProvider: CapacityProvider = {
      checkCapacity: async () => ({ ready: true, details: "容量已预热" }),
    };
    const notReadyProvider: CapacityProvider = {
      checkCapacity: async () => ({ ready: false, details: "Runtime 实例数不足" }),
    };
    const session = store.createSession("initiator-1");

    expect((await new CapacityPrecheck(readyProvider).run(session)).passed).toBe(true);
    expect((await new CapacityPrecheck(notReadyProvider).run(session)).passed).toBe(false);
  });

  it("AlertSilenceCheck 警告级别", async () => {
    const alertProvider: AlertProvider = {
      verifySilence: async () => ({ configured: false, details: "未配置静默" }),
    };
    const session = store.createSession("initiator-1");
    const check = new AlertSilenceCheck(alertProvider);
    const result = await check.run(session);
    expect(result.severity).toBe("warning");
    expect(result.passed).toBe(false);
  });

  it("OnCallOperatorCheck 未指定值守人员失败", async () => {
    const session = store.createSession("initiator-1");
    const check = new OnCallOperatorCheck();
    const result = await check.run(session);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("值守人员未指定");
  });

  it("OnCallOperatorCheck 已指定值守人员通过", async () => {
    const session = store.createSession("initiator-1");
    const updated = store.updateSession(session.id, { onCallOperator: "oncall-1" });
    const check = new OnCallOperatorCheck();
    const result = await check.run(updated);
    expect(result.passed).toBe(true);
    expect(result.details).toContain("oncall-1");
  });

  it("RollbackOwnerCheck 未指定回滚责任人失败", async () => {
    const session = store.createSession("initiator-1");
    const check = new RollbackOwnerCheck();
    const result = await check.run(session);
    expect(result.passed).toBe(false);
  });

  it("runPrechecks 全部通过", async () => {
    const backupProvider: BackupProvider = {
      verifyBackup: async () => ({ ready: true, restorePointId: "rp-001", reason: "" }),
      verifyRestorePoint: async () => true,
    };
    const capacityProvider: CapacityProvider = {
      checkCapacity: async () => ({ ready: true, details: "就绪" }),
    };
    const alertProvider: AlertProvider = {
      verifySilence: async () => ({ configured: true, details: "已配置" }),
    };
    const session = store.createSession("initiator-1");
    const updated = store.updateSession(session.id, {
      onCallOperator: "oncall-1",
      rollbackOwner: "rollback-1",
      backupRestorePoint: "rp-001",
    });

    const checks: Precheck[] = [
      new BackupReadyCheck(backupProvider),
      new RestorePointVerifiedCheck(backupProvider),
      new CapacityPrecheck(capacityProvider),
      new AlertSilenceCheck(alertProvider),
      new OnCallOperatorCheck(),
      new RollbackOwnerCheck(),
    ];

    const report = await runPrechecks(updated, checks);
    expect(report.passed).toBe(true);
    expect(report.failedCount).toBe(0);
    expect(report.passedCount).toBe(5); // 5 个 blocking
    expect(report.warningCount).toBe(0);
    expect(report.results.length).toBe(6);
    expect(report.blockingIssues.length).toBe(0);
  });

  it("runPrechecks 阻断性失败", async () => {
    const backupProvider: BackupProvider = {
      verifyBackup: async () => ({ ready: false, restorePointId: "", reason: "备份未完成" }),
      verifyRestorePoint: async () => true,
    };
    const session = store.createSession("initiator-1");

    const checks: Precheck[] = [new BackupReadyCheck(backupProvider)];
    const report = await runPrechecks(session, checks);
    expect(report.passed).toBe(false);
    expect(report.failedCount).toBe(1);
    expect(report.blockingIssues.length).toBe(1);
    expect(report.blockingIssues[0]).toContain("备份未完成");
  });

  it("runPrechecks 警告不计入阻断", async () => {
    const alertProvider: AlertProvider = {
      verifySilence: async () => ({ configured: false, details: "未配置" }),
    };
    const session = store.createSession("initiator-1");
    const checks: Precheck[] = [new AlertSilenceCheck(alertProvider)];
    const report = await runPrechecks(session, checks);
    expect(report.passed).toBe(true); // 警告不阻断
    expect(report.warningCount).toBe(1);
    expect(report.failedCount).toBe(0);
  });

  it("runPrechecks 检查执行异常被捕获", async () => {
    const throwingCheck: Precheck = {
      name: "异常检查",
      severity: "blocking",
      run: async () => {
        throw new Error("检查爆炸");
      },
    };
    const session = store.createSession("initiator-1");
    const report = await runPrechecks(session, [throwingCheck]);
    expect(report.passed).toBe(false);
    expect(report.failedCount).toBe(1);
    expect(report.results[0]?.details).toContain("检查爆炸");
  });

  it("formatPrecheckReport 生成可读报告", async () => {
    const session = store.createSession("initiator-1");
    const updated = store.updateSession(session.id, { onCallOperator: "oncall-1" });

    const checks: Precheck[] = [new OnCallOperatorCheck(), new RollbackOwnerCheck()];
    const report = await runPrechecks(updated, checks);
    const formatted = formatPrecheckReport(report);
    expect(formatted).toContain("V11 切换前置检查报告");
    expect(formatted).toContain(session.id);
    expect(formatted).toContain("通过: 1");
    expect(formatted).toContain("失败: 1");
    expect(formatted).toContain("阻断性问题");
    expect(formatted).toContain("回滚责任人未指定");
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 回滚控制器
// ═══════════════════════════════════════════════════════════

describe("S13-W04 回滚控制器", () => {
  let store: CutoverSessionStore;
  let writeFreeze: WriteFreezeController;
  let v11Isolator: V11Isolator;
  let rollbackController: RollbackController;

  beforeEach(() => {
    store = new InMemoryCutoverSessionStore();
    writeFreeze = new InMemoryWriteFreezeController();
    v11Isolator = {
      stopNewInvocations: async () => {},
      isolateV11Writes: async () => {},
      verifyIsolated: async () => true,
    };
    rollbackController = new RollbackController({
      sessionStore: store,
      writeFreeze,
      v11Isolator,
    });
  });

  it("isRollbackAllowed 切换窗口内允许回滚", () => {
    expect(isRollbackAllowed("precheck")).toBe(true);
    expect(isRollbackAllowed("backup_ready")).toBe(true);
    expect(isRollbackAllowed("write_frozen")).toBe(true);
    expect(isRollbackAllowed("drained")).toBe(true);
    expect(isRollbackAllowed("incremental_migration")).toBe(true);
    expect(isRollbackAllowed("cutover_ready")).toBe(true);
  });

  it("isRollbackAllowed 终态不允许回滚", () => {
    expect(isRollbackAllowed("idle")).toBe(false);
    expect(isRollbackAllowed("cutover_completed")).toBe(false);
    expect(isRollbackAllowed("rolled_back")).toBe(false);
  });

  it("回滚成功：5 步全部通过", async () => {
    const session = store.createSession("initiator-1");
    const frozen = store.updateSession(session.id, { state: "write_frozen" });
    await writeFreeze.freezeAll(frozen, "op-1", "冻结");

    const result = await rollbackController.rollback(session.id, "op-1", "测试回滚");
    expect(result.success).toBe(true);
    expect(result.fromState).toBe("write_frozen");
    expect(result.steps.length).toBe(4);
    expect(result.steps[0]?.name).toBe("停止 V11 新 Invocation");
    expect(result.steps[1]?.name).toBe("隔离 V11 新写入");
    expect(result.steps[2]?.name).toBe("验证 V11 已隔离");
    expect(result.steps[3]?.name).toBe("解冻旧写入口");
    expect(result.error).toBeNull();

    const updated = store.getSession(session.id);
    expect(updated?.state).toBe("rolled_back");
    expect(updated?.failureReason).toBe("测试回滚");
    expect(updated?.completedAt).not.toBeNull();
    expect(writeFreeze.isAllUnfrozen()).toBe(true);
  });

  it("终态拒绝回滚", async () => {
    const session = store.createSession("initiator-1");
    store.updateSession(session.id, {
      state: "cutover_completed",
      completedAt: new Date().toISOString(),
    });

    const result = await rollbackController.rollback(session.id, "op-1", "尝试回滚");
    expect(result.success).toBe(false);
    expect(result.steps.length).toBe(1);
    expect(result.steps[0]?.name).toBe("回滚条件检查");
    expect(result.error).toContain("不允许回滚");
  });

  it("V11 隔离失败导致回滚失败", async () => {
    const failingIsolator: V11Isolator = {
      stopNewInvocations: async () => {},
      isolateV11Writes: async () => {
        throw new Error("V11 隔离失败");
      },
      verifyIsolated: async () => true,
    };
    const failingController = new RollbackController({
      sessionStore: store,
      writeFreeze,
      v11Isolator: failingIsolator,
    });

    const session = store.createSession("initiator-1");
    store.updateSession(session.id, { state: "write_frozen" });

    const result = await failingController.rollback(session.id, "op-1", "V11 隔离失败");
    expect(result.success).toBe(false);
    expect(result.error).toContain("V11 隔离失败");
    // 状态保持原状（未进入 rolled_back）
    expect(store.getSession(session.id)?.state).toBe("write_frozen");
  });

  it("V11 验证未隔离导致回滚失败", async () => {
    const unverifiedIsolator: V11Isolator = {
      stopNewInvocations: async () => {},
      isolateV11Writes: async () => {},
      verifyIsolated: async () => false,
    };
    const failingController = new RollbackController({
      sessionStore: store,
      writeFreeze,
      v11Isolator: unverifiedIsolator,
    });

    const session = store.createSession("initiator-1");
    store.updateSession(session.id, { state: "incremental_migration" });

    const result = await failingController.rollback(session.id, "op-1", "验证未隔离");
    expect(result.success).toBe(false);
    expect(result.error).toContain("隔离验证失败");
  });

  it("会话不存在抛 RollbackError", async () => {
    await expect(rollbackController.rollback("nonexistent", "op-1", "原因")).rejects.toThrow(
      RollbackError,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 切换编排器
// ═══════════════════════════════════════════════════════════

describe("S13-W04 切换编排器", () => {
  let store: CutoverSessionStore;
  let writeFreeze: WriteFreezeController;
  let rollbackController: RollbackController;
  let prechecks: Precheck[];
  let backupExecutor: BackupExecutor;
  let incrementalMigrationExecutor: IncrementalMigrationExecutor;
  let consistencyVerifier: ConsistencyVerifier;
  let v11EntryOpener: V11EntryOpener;

  beforeEach(() => {
    store = new InMemoryCutoverSessionStore();
    writeFreeze = new InMemoryWriteFreezeController();
    const v11Isolator: V11Isolator = {
      stopNewInvocations: async () => {},
      isolateV11Writes: async () => {},
      verifyIsolated: async () => true,
    };
    rollbackController = new RollbackController({ sessionStore: store, writeFreeze, v11Isolator });

    // 全部通过的前置检查
    const backupProvider: BackupProvider = {
      verifyBackup: async () => ({ ready: true, restorePointId: "rp-001", reason: "" }),
      verifyRestorePoint: async () => true,
    };
    const capacityProvider: CapacityProvider = {
      checkCapacity: async () => ({ ready: true, details: "就绪" }),
    };
    const alertProvider: AlertProvider = {
      verifySilence: async () => ({ configured: true, details: "已配置" }),
    };
    prechecks = [
      new BackupReadyCheck(backupProvider),
      new CapacityPrecheck(capacityProvider),
      new AlertSilenceCheck(alertProvider),
      new OnCallOperatorCheck(),
      new RollbackOwnerCheck(),
    ];

    backupExecutor = {
      createBackup: async () => ({ restorePointId: "rp-exec-001", details: "备份完成" }),
    };
    incrementalMigrationExecutor = {
      runIncrementalMigration: async () => ({
        batchId: "batch-001",
        migratedCount: 100,
        skippedCount: 50,
        anomalyCount: 0,
      }),
    };
    consistencyVerifier = {
      verify: async () => ({ passed: true, details: "一致性核对通过" }),
    };
    v11EntryOpener = {
      openV11Entry: async () => {},
    };
  });

  /** 构造编排器。 */
  function buildOrchestrator(
    overrides?: Partial<{
      backupExecutor: BackupExecutor;
      incrementalMigrationExecutor: IncrementalMigrationExecutor;
      consistencyVerifier: ConsistencyVerifier;
      v11EntryOpener: V11EntryOpener;
      prechecks: Precheck[];
    }>,
  ): CutoverOrchestrator {
    return new CutoverOrchestrator({
      sessionStore: store,
      writeFreeze,
      rollbackController,
      prechecks: overrides?.prechecks ?? prechecks,
      backupExecutor: overrides?.backupExecutor ?? backupExecutor,
      incrementalMigrationExecutor:
        overrides?.incrementalMigrationExecutor ?? incrementalMigrationExecutor,
      consistencyVerifier: overrides?.consistencyVerifier ?? consistencyVerifier,
      v11EntryOpener: overrides?.v11EntryOpener ?? v11EntryOpener,
      drainTimeoutMs: 1000,
      drainPollIntervalMs: 50,
    });
  }

  it("完整切换成功流程", async () => {
    const orchestrator = buildOrchestrator();
    const result = await orchestrator.executeCutover("initiator-1", "oncall-1", "rollback-1");

    expect(result.success).toBe(true);
    expect(result.finalState).toBe("cutover_completed");
    expect(result.rolledBack).toBe(false);
    expect(result.error).toBeNull();
    expect(result.precheckReport?.passed).toBe(true);

    // 验证步骤序列
    const stepNames = result.steps.map((s) => s.stepName);
    expect(stepNames).toContain("状态转换");
    expect(stepNames).toContain("前置检查");
    expect(stepNames).toContain("创建备份");
    expect(stepNames).toContain("冻结旧写入口");
    expect(stepNames).toContain("排空进行中操作");
    expect(stepNames).toContain("最终增量迁移");
    expect(stepNames).toContain("一致性核对");
    expect(stepNames).toContain("开放 V11 入口");

    // 验证会话状态
    const session = store.listSessions()[0];
    expect(session?.state).toBe("cutover_completed");
    expect(session?.onCallOperator).toBe("oncall-1");
    expect(session?.rollbackOwner).toBe("rollback-1");
    expect(session?.backupRestorePoint).toBe("rp-exec-001");
    expect(session?.incrementalBatchId).toBe("batch-001");
    expect(session?.cutoverWindowStartedAt).not.toBeNull();
    expect(session?.completedAt).not.toBeNull();

    // 验证写入冻结状态（切换完成后旧入口保持冻结）
    expect(writeFreeze.isAllFrozen()).toBe(true);
  });

  it("前置检查失败触发回滚", async () => {
    const failingPrechecks: Precheck[] = [
      {
        name: "失败检查",
        severity: "blocking",
        run: async () => ({
          name: "失败检查",
          severity: "blocking",
          passed: false,
          details: "检查失败",
          timestamp: new Date().toISOString(),
        }),
      },
    ];
    const orchestrator = buildOrchestrator({ prechecks: failingPrechecks });

    const result = await orchestrator.executeCutover("initiator-1", "oncall-1", "rollback-1");

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain("前置检查未通过");
    expect(result.finalState).toBe("rolled_back");

    // 验证旧入口已解冻（回滚恢复）
    expect(writeFreeze.isAllUnfrozen()).toBe(true);
  });

  it("备份失败触发回滚", async () => {
    const failingBackup: BackupExecutor = {
      createBackup: async () => {
        throw new Error("备份服务不可用");
      },
    };
    const orchestrator = buildOrchestrator({ backupExecutor: failingBackup });

    const result = await orchestrator.executeCutover("initiator-1", "oncall-1", "rollback-1");

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain("备份服务不可用");
    expect(result.finalState).toBe("rolled_back");
  });

  it("增量迁移存在异常触发回滚", async () => {
    const failingMigration: IncrementalMigrationExecutor = {
      runIncrementalMigration: async () => ({
        batchId: "batch-001",
        migratedCount: 100,
        skippedCount: 50,
        anomalyCount: 5,
      }),
    };
    const orchestrator = buildOrchestrator({ incrementalMigrationExecutor: failingMigration });

    const result = await orchestrator.executeCutover("initiator-1", "oncall-1", "rollback-1");

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain("5 条异常");
  });

  it("一致性核对失败触发回滚", async () => {
    const failingVerifier: ConsistencyVerifier = {
      verify: async () => ({ passed: false, details: "计数不一致" }),
    };
    const orchestrator = buildOrchestrator({ consistencyVerifier: failingVerifier });

    const result = await orchestrator.executeCutover("initiator-1", "oncall-1", "rollback-1");

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain("计数不一致");
  });

  it("V11 入口开放失败触发回滚", async () => {
    const failingOpener: V11EntryOpener = {
      openV11Entry: async () => {
        throw new Error("Gateway 切换失败");
      },
    };
    const orchestrator = buildOrchestrator({ v11EntryOpener: failingOpener });

    const result = await orchestrator.executeCutover("initiator-1", "oncall-1", "rollback-1");

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain("Gateway 切换失败");
  });

  it("排空进行中操作超时触发回滚", async () => {
    // 注册一个永远不排空的探测函数
    writeFreeze.registerInFlightProbe(() => ({
      invocations: 1,
      toolCalls: 0,
      effects: 0,
      jobs: 0,
      drained: false,
    }));
    const orchestrator = buildOrchestrator();

    const result = await orchestrator.executeCutover("initiator-1", "oncall-1", "rollback-1");

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain("排空超时");
  });

  it("步骤历史完整记录", async () => {
    const orchestrator = buildOrchestrator();
    const result = await orchestrator.executeCutover("initiator-1", "oncall-1", "rollback-1");

    const session = store.listSessions()[0];
    expect(session).toBeDefined();
    const steps = store.getSteps(session?.id ?? "");
    // 至少 7 次状态转换（idle→precheck→backup_ready→write_frozen→drained→incremental→ready→completed）
    expect(steps.length).toBeGreaterThanOrEqual(7);
    for (const step of steps) {
      expect(step.success).toBe(true);
      expect(step.operator).toBe("initiator-1");
    }
  });
});
