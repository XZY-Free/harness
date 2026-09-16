/**
 * Canonical Routes Guard — Foundation Batch F18/F19 扩展。
 *
 * Authority（工程包 sections/canonical-layout.md Route Plan 表 +
 * sections/residual-removal.md §14 + 任务书 §十二 / §三十七）：
 *
 * 锁定 F3-F6 已完成的 4 棵 v1 route 树 MOVE 成果，防止后续开发回归：
 * 1. app/{admin/api,api,gateway,runtime}/v1/ 4 个目录保持不存在
 * 2. 生产代码 URL 字面量不含 /admin/api/v1/、/api/v1/、/gateway/v1/、/runtime/v1/
 * 3. OpenAPI 契约 (docs/contracts/openapi.json) 不含 v1 路径
 * 4. lib/http.ts AUDIENCE_PREFIX 4 个值全部无 v1 后缀
 * 5. Route handler params 类型声明与 destructure 使用 lowerCamelCase
 *    （生产代码不含 `params.xxx_id` 点访问模式）
 * 6. /chat/new 保持不存在（F2 已锁定，此处再次正向断言）
 * 7. Runtime Event 唯一正式入口收敛检查（app/gateway/runtime-events/route.ts
 *    在 Runtime Batch DELETE 前允许存在，但不得有第二条 /runtime/invocations/
 *    {id}/events 入口）
 *
 * 精确例外（§四十一 允许）：
 * - 本 Guard 文件自身（regex 持有禁止字符串）
 * - docs/V12/ 工程包与历史交接叙事
 * - docs/topic-01/ Topic-01 历史归档
 * - docs/implementation/topic-01-<name>/ Topic-01 历史实施笔记
 * - scripts/architecture-gate-rules.test.ts 中 gate 规则测试的 mock 文档路径
 *   （负向测试构造假设违规路径来验证 gate 检测能力）
 * - lib/artifacts/test-support/*.ts 中 DSSE predicateType URI
 *   `https://snowharness.dev/conformance/runtime/v1`（Conformance suiteRevision
 *   独立版本域，naming-rules item 2）
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const PRODUCTION_SCAN_ROOTS = ["app", "components", "desktop", "lib", "scripts", "e2e"] as const;

const SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".next-e2e",
  "dist",
  "build",
  "output",
  ".omc",
  "__pycache__",
]);

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|mjs|js|json|yml)$/;

/** 允许保留 v1 路径字符串的精确例外（§四十一 负向测试 + 外部 URI 标准）。 */
const V1_PATH_EXCEPTIONS = new Set([
  "lib/architecture/canonical-routes.test.ts", // 本 Guard 自身
  "lib/architecture/canonical-naming.test.ts", // 姊妹 Guard
  "scripts/architecture-gate-rules.test.ts", // gate 规则负向测试 mock 路径
  "scripts/repository-architecture.contract.test.ts", // 已含 v11 白名单
  "lib/artifacts/test-support/attempt-runtime-publication-with-attestation-without-trusted-run.ts", // DSSE predicateType
]);

function walkSourceFiles(root: string): string[] {
  const absolute = join(ROOT, root);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry)) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.test(full)) continue;
      out.push(relative(ROOT, full));
    }
  };
  if (statSync(absolute).isDirectory()) walk(absolute);
  else if (SOURCE_EXTENSIONS.test(absolute)) out.push(relative(ROOT, absolute));
  return out;
}

function readProductionSources(): Array<{ path: string; content: string }> {
  return PRODUCTION_SCAN_ROOTS.flatMap(walkSourceFiles)
    .filter((path) => !V1_PATH_EXCEPTIONS.has(path))
    .map((path) => ({ path, content: readFileSync(join(ROOT, path), "utf8") }));
}

// ─── Guard 1: 4 棵 v1 目录树保持不存在 ─────────────────────

describe("Canonical Routes Guard (Foundation F3-F6 成果锁定)", () => {
  it("app/{admin/api,api,gateway,runtime}/v1/ 4 个目录全部不存在", () => {
    const forbidden = ["app/admin/api/v1", "app/api/v1", "app/gateway/v1", "app/runtime/v1"];
    const existing = forbidden.filter((p) => existsSync(join(ROOT, p)));
    expect(existing).toEqual([]);
  });

  it("canonical 目录存在且非空（正向断言 F3-F6 成果）", () => {
    const required = ["app/admin/api", "app/api", "app/gateway", "app/runtime"];
    for (const dir of required) {
      expect(existsSync(join(ROOT, dir)), `${dir} 必须存在`).toBe(true);
      const entries = readdirSync(join(ROOT, dir));
      expect(entries.length, `${dir} 必须非空`).toBeGreaterThan(0);
      // v1 子目录不得复现
      expect(entries, `${dir} 不得含 v1 子目录`).not.toContain("v1");
    }
  });

  // ─── Guard 2: 生产代码 URL 字面量不含 v1 前缀 ────────────

  it("生产代码 URL 字面量不含 /admin/api/v1/ /api/v1/ /gateway/v1/ /runtime/v1/", () => {
    const forbidden = [
      /\/admin\/api\/v1\//,
      /(?<!admin)\/api\/v1\//,
      /\/gateway\/v1\//,
      /\/runtime\/v1\//,
    ];
    const offenders = readProductionSources().flatMap(({ path, content }) =>
      forbidden.filter((re) => re.test(content)).map((re) => ({ path, pattern: re.source })),
    );
    expect(offenders).toEqual([]);
  });

  it("生产代码 import 路径不含 @/app/{admin/api,api,gateway,runtime}/v1/", () => {
    const forbidden = [
      /@\/app\/admin\/api\/v1\//,
      /@\/app\/api\/v1\//,
      /@\/app\/gateway\/v1\//,
      /@\/app\/runtime\/v1\//,
    ];
    const offenders = readProductionSources().flatMap(({ path, content }) =>
      forbidden.filter((re) => re.test(content)).map((re) => ({ path, pattern: re.source })),
    );
    expect(offenders).toEqual([]);
  });

  // ─── Guard 3: OpenAPI 契约不含 v1 路径 ───────────────────

  it("docs/contracts/openapi.json 所有 path 不含 /v1/ 前缀", () => {
    const openapi = JSON.parse(readFileSync(join(ROOT, "docs/contracts/openapi.json"), "utf8")) as {
      paths?: Record<string, unknown>;
    };
    const paths = Object.keys(openapi.paths ?? {});
    const offenders = paths.filter(
      (p) =>
        p.startsWith("/admin/api/v1/") ||
        p.startsWith("/api/v1/") ||
        p.startsWith("/gateway/v1/") ||
        p.startsWith("/runtime/v1/"),
    );
    expect(offenders).toEqual([]);
    // 正向：canonical 路径存在
    expect(paths.some((p) => p.startsWith("/admin/api/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/api/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/gateway/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/runtime/"))).toBe(true);
  });

  // ─── Guard 4: AUDIENCE_PREFIX 常量无 v1 后缀 ─────────────

  it("lib/http.ts AUDIENCE_PREFIX 4 个值全部无 v1 后缀", () => {
    const source = readFileSync(join(ROOT, "lib/http.ts"), "utf8");
    // 匹配 AUDIENCE_PREFIX 对象字面量
    const match = source.match(/AUDIENCE_PREFIX[^=]*=\s*\{([^}]+)\}/);
    expect(match, "AUDIENCE_PREFIX 必须存在").not.toBeNull();
    const body = match?.[1] ?? "";
    expect(body).not.toMatch(/\/v1["'`]/);
    // 正向：4 个 canonical prefix 存在
    expect(body).toContain('employee: "/api"');
    expect(body).toContain('runtime: "/runtime"');
    expect(body).toContain('gateway: "/gateway"');
    expect(body).toContain('admin: "/admin/api"');
  });

  // ─── Guard 5: Route handler params 使用 lowerCamelCase ──

  it("4 棵 canonical route 树内不含 params.xxx_id 点访问（handler 已迁 lowerCamelCase）", () => {
    const routeTrees = ["app/admin/api", "app/api", "app/gateway", "app/runtime"];
    const offenders: Array<{ path: string; match: string }> = [];
    for (const tree of routeTrees) {
      const files = walkSourceFiles(tree).filter((p) => p.endsWith("route.ts"));
      for (const file of files) {
        const content = readFileSync(join(ROOT, file), "utf8");
        // 匹配 params.xxx_id 或 params?.xxx_id（snake_case 后缀 _id）
        const matches = content.matchAll(/\bparams\??\.(\w+_id)\b/g);
        for (const m of matches) {
          offenders.push({ path: file, match: m[0] });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("4 棵 canonical route 树内 param 文件夹全部 lowerCamelCase（无 [xxx_id] 形式）", () => {
    const routeTrees = ["app/admin/api", "app/api", "app/gateway", "app/runtime"];
    const offenders: string[] = [];
    for (const tree of routeTrees) {
      const walk = (dir: string): void => {
        const abs = join(ROOT, dir);
        if (!existsSync(abs)) return;
        for (const entry of readdirSync(abs)) {
          const full = join(dir, entry);
          // 检查 [xxx_id] 形式的 param 文件夹
          if (/^\[[a-z]+(?:_[a-z]+)+\]$/.test(entry)) {
            offenders.push(full);
          }
          if (statSync(join(ROOT, full)).isDirectory()) walk(full);
        }
      };
      walk(tree);
    }
    expect(offenders).toEqual([]);
  });

  // ─── Guard 6: /chat/new 保持不存在 ───────────────────────

  it("/chat/new 路由保持不存在（F2 锁定，无 redirect、无 alias）", () => {
    expect(existsSync(join(ROOT, "app/chat/new"))).toBe(false);
    expect(existsSync(join(ROOT, "app/chat/new/page.tsx"))).toBe(false);
    // /chat 本身必须存在
    expect(existsSync(join(ROOT, "app/chat/page.tsx"))).toBe(true);
  });

  // ─── Guard 7: Runtime Event 唯一正式入口 ──────────────────

  it("Runtime Event 入口收敛到 canonical Runtime Ingress", () => {
    const runtimeEventPaths = [
      "app/runtime/invocations/[invocationId]/events/batch/route.ts",
      "app/runtime/invocations/[invocationId]/events/route.ts",
      "app/gateway/runtime-events/route.ts",
    ];
    const existing = runtimeEventPaths.filter((p) => existsSync(join(ROOT, p)));
    const allRouteFiles = walkSourceFiles("app").filter((p) => p.endsWith("route.ts"));
    const eventRoutes = allRouteFiles.filter(
      (p) => /\/events?\/(?:batch\/)?route\.ts$/.test(p) || /runtime-events\/route\.ts$/.test(p),
    );
    // SSE、admin projection 和 Job domain event routes 不是 Runtime Ingress。
    const allowed = new Set([
      "app/runtime/invocations/[invocationId]/events/route.ts",
      "app/api/threads/[threadId]/events/route.ts", // SSE 员工前端事件流，不是 Runtime Ingress
      "app/admin/api/invocations/[invocationId]/ingress/route.ts", // admin 只读投影
      "app/admin/api/event-delivery/[failureId]/route.ts",
      "app/admin/api/event-quarantines/[failureId]/resolve/route.ts",
      "app/admin/api/audit-events/[eventId]/route.ts",
      "app/admin/api/threads/[threadId]/events/route.ts",
      "app/admin/api/jobs/[jobId]/events/route.ts", // Job Domain 事件 admin 只读投影
    ]);
    const unexpected = eventRoutes.filter((p) => !allowed.has(p));
    expect(unexpected, `不得有白名单外的 Runtime Event 入口: ${unexpected.join(", ")}`).toEqual([]);
    expect(existing).toEqual(["app/runtime/invocations/[invocationId]/events/route.ts"]);
    expect(eventRoutes).toContain("app/runtime/invocations/[invocationId]/events/route.ts");
  });
});
