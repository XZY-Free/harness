import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** RouteRevision / RouteActivation 历史表唯一写入口是 append；任何 drizzle UPDATE 路径都违规。 */
const HISTORY_UPDATE_PATTERN = /\.update\(\s*(?:routeRevision|routeActivation)\b/;

function listSourceFiles(path: string): string[] {
  if (!existsSyncDir(path)) return [];
  return readdirSync(path).flatMap((entry) => {
    const full = join(path, entry);
    if (["node_modules", ".git", ".next", "dist", "build"].includes(entry)) return [];
    try {
      const stat = readdirSync(full, { withFileTypes: true });
      return stat ? listSourceFiles(full) : [];
    } catch {
      return /\.ts$/.test(full) ? [full] : [];
    }
  });
}

function existsSyncDir(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * V12 冻结架构：Route 历史表 append-only 不再依赖 DB TRIGGER（drizzle 干净初始迁移
 * 无法表达 trigger，历史触发器已随干净基线折叠移除）。语义强度不变——由唯一写入口
 * 在 store 层强制：canonical store 只暴露 appendRevision / appendActivation，
 * 生产作用域不存在任何对两张历史表的 UPDATE 路径。
 */
describe("Route 历史表 append-only 基线约束", () => {
  it("干净初始迁移不含 TRIGGER，历史表仍由唯一 0000 基线创建", () => {
    const baseline = readFileSync(join(ROOT, "drizzle/0000_initial_schema.sql"), "utf8");
    expect(baseline).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(baseline).not.toContain("prevent_update");
    expect(baseline).toContain("CREATE TABLE `RouteRevision`");
    expect(baseline).toContain("CREATE TABLE `RouteActivation`");
  });

  it("canonical store 接口只暴露 appendRevision/appendActivation，无历史表 UPDATE 入口", () => {
    const storeInterface = readFileSync(
      join(ROOT, "lib/routes/persistence/route-set-activation-store.ts"),
      "utf8",
    );
    expect(storeInterface).toContain("appendRevision(");
    expect(storeInterface).toContain("appendActivation(");
    expect(storeInterface).not.toMatch(
      /update(?:Revision|Activation|RouteRevision|RouteActivation)/,
    );
  });

  it("MySQL store 对历史表只 INSERT（append），从不 UPDATE", () => {
    const store = readFileSync(
      join(ROOT, "lib/routes/persistence/mysql-route-set-activation-store.ts"),
      "utf8",
    );
    expect(store).toContain("insert(routeRevision)");
    expect(store).toContain("insert(routeActivation)");
    expect(HISTORY_UPDATE_PATTERN.test(store)).toBe(false);
    // DeploymentRoute / RouteSet 投影表是唯一允许 UPDATE 的状态载体。
    expect(store).toContain("update(deploymentRouteTable)");
  });

  it("生产作用域（lib/app/scripts）不存在 RouteRevision/RouteActivation 的 UPDATE 路径", () => {
    const files = [
      ...listSourceFiles(join(ROOT, "lib")),
      ...listSourceFiles(join(ROOT, "app")),
      ...listSourceFiles(join(ROOT, "scripts")),
    ].filter((file) => !file.endsWith("route-history-append-only.test.ts"));
    const violations = files.filter((file) =>
      HISTORY_UPDATE_PATTERN.test(readFileSync(file, "utf8")),
    );
    expect(violations).toEqual([]);
  });
});
