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
    // (assertRuntimeConfig/runMigrations/清扫定时器等启动副作用),避免 build 期
    // 依赖运行时 secret + 连 DB 跑迁移。原注释「next build 不会调用 register()」有误。
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const { APP_ENV, appConfig, assertRuntimeConfig } = await import("./lib/config");
    const { loadAppEnvFiles } = await import("./lib/env-loader");

    loadAppEnvFiles(APP_ENV);
    assertRuntimeConfig();

    // 启动时应用 db 迁移（替代已退役的 ensureSchema 裸 DDL），确保表结构就绪
    const { runMigrations } = await import("./lib/db/migrate");
    await runMigrations();

    // Phase 5 Stage B：docker 可用性探测预热（best-effort，不阻塞启动）。
    // defaultType=container 但 docker 不可用 → warmup 内降级 warn；host 模式下探测跳过。
    const { warmupDockerAvailable } = await import("./lib/runtime/container/availability");
    await warmupDockerAvailable();

    // Phase 5 Stage E：启动容器 idle TTL 回收定时器（host 模式空跑，unref 不阻塞退出）。
    const { startIdleSweep } = await import("./lib/runtime/container/manager");
    startIdleSweep();

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
