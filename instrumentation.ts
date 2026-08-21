/**
 * Next.js Instrumentation Hook — 启动时加载环境文件并校验配置。
 *
 * register() 在服务启动时调用一次，且 Next.js 会等它完成后再接收请求，因此校验是 fail-fast 的。
 * 配置的【读文件 + 校验 + 日志】集中在此（仅 nodejs runtime）：
 *   - next build 不会调用 register()，故 build 不读文件、不因缺变量失败、不触发 Turbopack NFT 告警。
 *   - 运行时按 APP_ENV 加载 .env.{APP_ENV}(.local)（只填补空缺、不覆盖平台注入），再校验必填项；
 *     缺失则抛错退出。
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // P2-1:next build 的 collect-page-data 阶段也会调 register(),跳过运行时副作用
    // (assertRuntimeConfig/runMigrations/policy refresh/清扫定时器等启动副作用),避免 build 期
    // 依赖运行时 secret + 连 DB 跑迁移。原注释「next build 不会调用 register()」有误。
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const { APP_ENV, appConfig, assertRuntimeConfig } = await import("./lib/config");
    const { loadAppEnvFiles } = await import("./lib/env-loader");

    loadAppEnvFiles(APP_ENV);
    assertRuntimeConfig();

    // 启动时应用 db 迁移（替代已退役的 ensureSchema 裸 DDL），确保表结构就绪
    const { runMigrations } = await import("./lib/db/migrate");
    await runMigrations();

    // Phase 4-4：迁移就绪后从 DB 刷新 policy 配置缓存（getPolicyConfig 同步读缓存）。
    // 失败 fail-open 沿用默认（policy 是治理便利，非治理目的）。
    const { refreshPolicyConfigFromDB } = await import("./lib/policy/config");
    await refreshPolicyConfigFromDB();

    // Phase 5 Stage B：docker 可用性探测预热（best-effort，不阻塞启动）。
    // defaultType=container 但 docker 不可用 → warmup 内降级 warn；host 模式下探测跳过。
    const { warmupDockerAvailable } = await import("./lib/runtime/container/availability");
    await warmupDockerAvailable();

    // Phase 5 Stage E：启动容器 idle TTL 回收定时器（host 模式空跑，unref 不阻塞退出）。
    const { startIdleSweep } = await import("./lib/runtime/container/manager");
    startIdleSweep();

    // P1-11: 启动时重放审计失败队列(auditFailureLog 原只有入队无消费者)。
    const { replayAuditFailures } = await import("./lib/audit/retry-queue");
    const replayed = await replayAuditFailures().catch((err) => {
      console.error("[instrumentation] replayAuditFailures 启动重放失败:", err);
      return 0;
    });
    if (replayed > 0) {
      console.info(`[instrumentation] replayed ${replayed} audit failures on startup`);
    }

    // V6-M2-7：定时清理旧快照（每小时，unref 不阻塞进程退出）。
    // cleanupOldSnapshots 删超过 retentionDays 的 contextSnapshot。
    // 02-5：legacy 过期记忆清理（cleanupExpiredMemories，删 memoryEntry/memoryEmbedding）
    // 已随 memory 轨删除；正式 Memory Authority 的 memoryState/expiresAt 生命周期由正式链自身管理。
    const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
    const cleanupTimer = setInterval(async () => {
      try {
        const { cleanupOldSnapshots } = await import("./lib/db/queries");
        const snapshots = await cleanupOldSnapshots();
        if (snapshots > 0) {
          console.info(`[instrumentation] cleanup: ${snapshots} old snapshots`);
        }
      } catch (e) {
        console.warn("[instrumentation] cleanup sweep failed:", e);
      }
    }, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();

    // P1-11: 定时重放审计失败队列(每小时),补齐 auditFailureLog 的消费者。
    const AUDIT_REPLAY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
    const auditReplayTimer = setInterval(async () => {
      try {
        const { replayAuditFailures: replay } = await import("./lib/audit/retry-queue");
        const n = await replay();
        if (n > 0) console.info(`[instrumentation] audit replay: ${n} rows`);
      } catch (e) {
        console.warn("[instrumentation] audit replay sweep failed:", e);
      }
    }, AUDIT_REPLAY_INTERVAL_MS);
    auditReplayTimer.unref();

    // 状态机兜底 sweep：deploying 状态定时轮询 CI/CD 确认（防 gitPush 成功后
    // deliverySummary 未调用导致永久悬空）。02-3：移除 legacy thread delivering→failed
    // 超时扫描（正式 Thread 无 delivering/failed 状态机；"交付超时扫描"后续在正式
    // Deployment/Execution/Delivery Authority 上重新实现）。
    const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const sweepTimer = setInterval(async () => {
      try {
        const { sweepDeployingStatuses } = await import("./lib/deploy/cicd-target");
        await sweepDeployingStatuses();
      } catch (e) {
        console.warn("[instrumentation] state machine sweep failed:", e);
      }
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();

    // V10 Phase 2：V9 浏览器 idle 释放 sweep 和 retention 清理 sweep 已删除。
    // 原 V9 在此启动 browserIdleTimer（每分钟释放 idle Playwright context）和
    // browserRetentionTimer（每小时清理过期 UserBrowserProfile / BrowserSession /
    // BrowserDownload）。V10 删除服务端用户浏览器链路后，这些定时器无数据可扫，
    // 相关 DB 表由破坏性 migration 删除。Desktop 浏览器的 idle/retention 由
    // Desktop 本地管理（Phase 3+），不经 Server instrumentation。

    // V10 Phase 5：启动 Agent Bridge WebSocket 服务器（仅生产环境）。
    // Desktop 通过 WebSocket 连接 + ed25519 challenge-response 认证后，
    // Server 可向其分发浏览器操作 RPC。端口通过 SNOW_BRIDGE_PORT 环境变量
    // 配置，默认 3002。开发/测试环境不启动（Desktop 端可独立 mock）。
    if (appConfig.isProd || process.env.SNOW_BRIDGE_PORT) {
      const { BridgeServer, setBridgeServer } = await import("./lib/desktop-bridge/bridge-server");
      const bridgePort = Number.parseInt(process.env.SNOW_BRIDGE_PORT ?? "3002", 10);
      const bridgeServer = new BridgeServer({ port: bridgePort });
      await bridgeServer.start();
      setBridgeServer(bridgeServer);
      console.log(`[snowharness:bridge] Agent Bridge server started on port ${bridgePort}`);
    }
  }
}
