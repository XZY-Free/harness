/**
 * dependency-cruiser 架构规则配置。
 *
 * 规则来源: SnowHarness 01专题后续四批改造总方案 §二十八 + §9.4 收口
 *
 * 层次:
 * - Domain: 只允许同领域 Domain + 纯类型 + Node 标准库纯计算
 * - Application: 只允许 Domain + Store Port + Shared
 * - Persistence: 只允许实现 Application 定义的 Port
 * - API Route: 只允许 Application Service + 错误映射 + 身份授权
 * - 禁止: 循环依赖, Production→TestSupport, 正式控制面→lib/v11
 *
 * §9.4 收口:
 * - API→DB 全部 error（不再 warn）
 * - 嵌套领域目录遵守相同规则
 * - Application 不得直接 import Drizzle/MySQL
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ─── Domain 规则 ──────────────────────────────
    {
      name: "domain-no-persistence",
      comment: "Domain 不得依赖 Persistence（含嵌套领域目录）",
      severity: "error",
      from: { path: "^lib/[^/]+(/[^/]+)*/domain/" },
      to: { path: "^lib/[^/]+(/[^/]+)*/persistence/" },
    },
    {
      name: "domain-no-infrastructure",
      comment: "Domain 不得依赖 Infrastructure (db, crypto impl)",
      severity: "error",
      from: { path: "^lib/[^/]+(/[^/]+)*/domain/" },
      to: { path: "^lib/(db|crypto|persistence)/" },
    },
    {
      name: "domain-no-nextjs",
      comment: "Domain 不得依赖 Next.js",
      severity: "error",
      from: { path: "^lib/[^/]+(/[^/]+)*/domain/" },
      to: { path: "^next/" },
    },
    {
      name: "domain-no-app-route",
      comment: "Domain 不得依赖 App Route",
      severity: "error",
      from: { path: "^lib/[^/]+(/[^/]+)*/domain/" },
      to: { path: "^app/" },
    },
    {
      name: "domain-no-test-support",
      comment: "Domain 不得依赖 Test Support",
      severity: "error",
      from: { path: "^lib/[^/]+(/[^/]+)*/domain/" },
      to: { path: "^lib/[^/]+/test-support/" },
    },
    {
      name: "domain-no-v11",
      comment: "正式 Domain 不得依赖 lib/v11（含嵌套目录）",
      severity: "error",
      from: {
        path: "^lib/(agents|runtimes|routes|executions|artifacts|publications|control-plane)/([^/]+/)*domain/",
      },
      to: { path: "^lib/v11/" },
    },

    // ─── Application 规则 ─────────────────────────
    {
      name: "application-no-mysql-store",
      comment: "Application Service 不得直接依赖 MySQL Store 实现（含嵌套目录）",
      severity: "error",
      from: { path: "^lib/[^/]+(/[^/]+)*/application/" },
      to: { path: "^lib/[^/]+(/[^/]+)*/persistence/mysql-" },
    },
    {
      name: "application-no-drizzle",
      comment: "§9.4: Application Service 不得直接 import Drizzle ORM",
      severity: "error",
      from: { path: "^lib/[^/]+(/[^/]+)*/application/" },
      to: { path: "^drizzle-orm/" },
    },
    {
      name: "application-no-nextjs",
      comment: "Application Service 不得依赖 Next.js",
      severity: "error",
      from: { path: "^lib/[^/]+(/[^/]+)*/application/" },
      to: { path: "^next/" },
    },
    {
      name: "application-no-http-response",
      comment: "Application Service 不得直接构造 HTTP Response",
      severity: "error",
      from: { path: "^lib/[^/]+(/[^/]+)*/application/" },
      to: { path: "^lib/http" },
    },

    // ─── Persistence 规则 ────────────────────────
    {
      name: "persistence-no-application-service",
      comment: "Persistence 不得反向调用 Application Service",
      severity: "error",
      from: { path: "^lib/[^/]+(/[^/]+)*/persistence/" },
      to: { path: "^lib/[^/]+(/[^/]+)*/application/" },
    },
    {
      name: "persistence-no-api-route",
      comment: "Persistence 不得 Import API Route",
      severity: "error",
      from: { path: "^lib/[^/]+(/[^/]+)*/persistence/" },
      to: { path: "^app/" },
    },

    // ─── API Route 规则 ──────────────────────────
    {
      name: "api-no-drizzle-schema",
      comment: "§9.4: API Route 不得直接依赖 Drizzle Schema (error)",
      severity: "error",
      from: { path: "^app/" },
      to: { path: "^lib/persistence/schema/" },
    },
    {
      name: "api-no-mysql-store",
      comment: "§9.4: API Route 不得直接依赖 MySQL Store (error)",
      severity: "error",
      from: { path: "^app/" },
      to: { path: "^lib/[^/]+(/[^/]+)*/persistence/mysql-" },
    },
    {
      name: "api-no-db-client",
      comment: "§9.4: API Route 不得直接使用 db client (error)",
      severity: "error",
      from: { path: "^app/" },
      to: { path: "^lib/db/client" },
    },

    // ─── 通用规则 ────────────────────────────────
    {
      name: "no-circular",
      comment: "禁止循环依赖",
      severity: "error",
      from: { path: "^lib/" },
      to: { path: "^lib/", circular: true },
    },
    {
      name: "production-no-test-support",
      comment: "Production 代码不得引用 Test Support",
      severity: "error",
      from: { path: "^lib/[^/]+(/[^/]+)*/(domain|application|persistence)/" },
      to: { path: "^lib/[^/]+/test-support/" },
    },
    {
      name: "stable-no-v11",
      comment: "正式稳定模块不得引用 lib/v11",
      severity: "error",
      from: {
        path: "^lib/(agents|runtimes|routes|executions|artifacts|publications|control-plane|crypto|routes/projection)/",
      },
      to: { path: "^lib/v11/" },
    },
  ],

  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: {
      path: "\\.test\\.(ts|tsx)$|\\.spec\\.(ts|tsx)$|__mocks__/",
    },
    reporter: "text",
  },
};
