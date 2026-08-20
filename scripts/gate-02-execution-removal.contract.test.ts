import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Gate 02 — 旧本地执行体系移除契约测试（RED 阶段）。
 *
 * 业务不变量：正式员工会话只由
 *   POST /api/v1/threads/{thread_id}/turns
 *     → lib/runtime/employee-turn-dispatcher.ts
 *     → 正式 Invocation / Attempt / ExecutionBinding 路径执行；
 * 正式管理排障只使用 /admin/api/v1/threads|invocations|jobs|tool-calls|effects。
 *
 * 已经失去 POST chat 入口的旧本地执行体系（ThreadRun / BackgroundTask /
 * SubagentRun / buildTools / 启动清扫器 / 旧 run/message/stream/cancel 路由）
 * 必须整体消失，不得继续以旧未版本化 API、旧实现、旧 DB Symbol 或旧 Studio 面板存活。
 *
 * 本文件是架构 authority contract：只读源码 / 检查路径，不执行任何业务逻辑。
 * 路径判断基于仓库根目录（process.cwd()），避免依赖 shell cwd 偶然性。
 *
 * 注意：当前为 Gate 02 的 RED 阶段，旧实现仍存在，故「禁止集合」断言必须失败；
 * 同时「正式路径正向保护」断言必须通过，以证明失败不是测试环境错误。
 */

const ROOT = process.cwd();

/** 把仓库相对路径解析为绝对路径。 */
const rooted = (...parts: string[]): string => join(ROOT, ...parts);

/** 递归列出某相对路径下所有文件（排除常见生成目录），返回仓库相对路径。 */
function sourceFiles(rel: string): string[] {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [relative(ROOT, abs)];
  return readdirSync(abs).flatMap((entry) => {
    if (["node_modules", ".git", ".next", "build", "dist", "__pycache__"].includes(entry)) {
      return [];
    }
    return sourceFiles(relative(ROOT, join(abs, entry)));
  });
}

/** 读取仓库相对路径的源码文本；不存在返回 ""。 */
function readSource(rel: string): string {
  if (!existsSync(rooted(rel))) return "";
  return readFileSync(rooted(rel), "utf8");
}

/** 断言一个仓库相对路径必须不存在，失败信息列出命中路径。 */
function expectAbsent(rel: string, reason: string): void {
  expect(existsSync(rooted(rel)), `${reason} 必须已删除，但存在：${rel}`).toBe(false);
}

/**
 * 断言某个文件内容不得出现任一禁止模式（Symbol 级禁止）。
 * 失败信息列出具体命中的 pattern，而不是含糊的「存在旧实现」。
 */
function expectSourceFreeFrom(
  source: string,
  rel: string,
  forbidden: readonly string[],
  reason: string,
): void {
  const hits = forbidden.filter((p) => source.includes(p));
  expect(hits, `${reason}\n  文件: ${rel}\n  命中禁止模式: ${hits.join(", ") || "(无)"}`).toEqual(
    [],
  );
}

/** 是否声明导出了给定名字（export const / export function / export async function）。 */
function exportsSymbol(source: string, name: string): boolean {
  return new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${name}\\b`).test(source);
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. 正向保护：正式路径必须存在，证明测试环境正确（这些必须通过）。
// ─────────────────────────────────────────────────────────────────────────────

describe("Gate 02 正向保护：正式路径必须存在（不应被误删）", () => {
  it("正式员工 turn route 存在且真实调用 dispatchEmployeeTurn", () => {
    const route = "app/api/v1/threads/[thread_id]/turns/route.ts";
    const src = readSource(route);
    expect(src, `正式 turn route 必须存在：${route}`).not.toBe("");
    expect(src, `${route} 必须导入 dispatchEmployeeTurn`).toContain("dispatchEmployeeTurn");
    expect(src, `${route} 必须真实调用 dispatchEmployeeTurn（而不是只导入）`).toMatch(
      /dispatchEmployeeTurn\s*\(/,
    );
  });

  it("正式员工 turn dispatcher 存在", () => {
    const file = "lib/runtime/employee-turn-dispatcher.ts";
    const src = readSource(file);
    expect(src, `正式 dispatcher 必须存在：${file}`).not.toBe("");
    expect(src, `${file} 必须导出 dispatchEmployeeTurn`).toMatch(
      /export\s+async\s+function\s+dispatchEmployeeTurn\s*\(/,
    );
  });

  it("正式 admin 排障入口 threads/invocations/jobs/tool-calls/effects 存在", () => {
    const required = [
      "app/admin/api/v1/threads/route.ts",
      "app/admin/api/v1/threads/[thread_id]/route.ts",
      "app/admin/api/v1/invocations/[invocation_id]/route.ts",
      "app/admin/api/v1/jobs/route.ts",
      "app/admin/api/v1/jobs/[job_id]/route.ts",
      "app/admin/api/v1/tool-calls/[tool_call_id]/route.ts",
      "app/admin/api/v1/effects/[effect_id]/route.ts",
    ];
    for (const rel of required) {
      expect(existsSync(rooted(rel)), `正式 admin 排障入口必须存在：${rel}`).toBe(true);
    }
  });

  it("旧 chat 入口已删除；关键新式 runtime/provider/workspace/preview 保留", () => {
    expect(existsSync(rooted("app/api/chat/route.ts")), "旧 POST chat 入口必须已删除").toBe(false);
    for (const rel of [
      "lib/ai/provider.ts",
      "lib/skill/matcher.ts",
      "lib/runtime/preview-runtime.ts",
      "lib/runtime/execution-runtime.ts",
    ]) {
      expect(existsSync(rooted(rel)), `生产路径必须保留：${rel}`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. 旧未版本化执行入口最终不存在（含全局 stream 对旧 runner status 的依赖）。
// ─────────────────────────────────────────────────────────────────────────────

describe("Gate 02：旧未版本化执行入口必须消失", () => {
  it("app/api/threads 下旧 run/message/stream/cancel 执行路由不存在", () => {
    const forbidden = [
      "app/api/threads/[id]/cancel/route.ts",
      "app/api/threads/[id]/messages/route.ts",
      "app/api/threads/[id]/runs/[runId]/route.ts",
      "app/api/threads/[id]/stream/route.ts",
    ];
    for (const rel of forbidden) {
      expectAbsent(rel, "旧未版本化执行路由");
    }
  });

  it("全局 app/api/threads/stream 若保留，不得依赖/暴露旧 runner status", () => {
    const rel = "app/api/threads/stream/route.ts";
    if (!existsSync(rooted(rel))) return; // 已删除 → 满足
    const src = readSource(rel);
    expectSourceFreeFrom(
      src,
      rel,
      ["thread-runner", "onThreadStatusChange", "runStatus", "threadRunner"],
      "全局 stream 不得再依赖旧 runner status（允许保留通用事件总线）",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 旧执行实现最终不存在。
// ─────────────────────────────────────────────────────────────────────────────

describe("Gate 02：旧执行实现必须消失", () => {
  it("旧 thread-runner / background-task-registry / ai tools / subagent / mcp tools 文件不存在", () => {
    const forbiddenFiles = [
      "lib/runtime/thread-runner.ts",
      "lib/runtime/background-task-registry.ts",
      "lib/ai/tool-runtime.ts",
      "lib/ai/tools.ts",
      "lib/mcp/tools.ts",
    ];
    for (const rel of forbiddenFiles) {
      expectAbsent(rel, "旧执行实现文件");
    }
  });

  it("lib/ai/tools/ 下不再存在旧执行工具文件", () => {
    const files = sourceFiles("lib/ai/tools").filter((f) => f.endsWith(".ts"));
    expect(files, `lib/ai/tools/ 下旧执行工具文件必须消失，仍存在：${files.join(", ")}`).toEqual(
      [],
    );
  });

  it("lib/subagent/ 下不再存在旧执行模型文件", () => {
    const files = sourceFiles("lib/subagent").filter((f) => f.endsWith(".ts"));
    expect(files, `lib/subagent/ 下旧执行模型必须消失，仍存在：${files.join(", ")}`).toEqual([]);
  });

  it("正式 dispatcher 不依赖旧 lib/ai/tools 与 thread-runner", () => {
    const src = readSource("lib/runtime/employee-turn-dispatcher.ts");
    expectSourceFreeFrom(
      src,
      "lib/runtime/employee-turn-dispatcher.ts",
      ["@/lib/ai/tools", "thread-runner", "background-task-registry"],
      "正式 dispatcher 不得耦合旧本地执行实现",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. instrumentation.ts 不再导入/调用旧清扫逻辑。
// ─────────────────────────────────────────────────────────────────────────────

describe("Gate 02：instrumentation.ts 不再启动旧清扫器", () => {
  it("不引用 background-task-registry / thread-runner / subagent / 旧清扫查询", () => {
    const rel = "instrumentation.ts";
    const src = readSource(rel);
    const forbidden = [
      "background-task-registry",
      "thread-runner",
      "markOrphansOnStartup",
      "markOrphanBackgroundTasksOnStartup",
      "markOrphanSubagentRunsOnStartup",
      "reapStaleThreads",
      "startReaper",
      "markStaleThreadRuns",
    ];
    expectSourceFreeFrom(src, rel, forbidden, "启动清扫器必须消失");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Preview / container / runtime 不再引用 background-task-registry，
//    也不再暴露 startBackground / stopBackground。
// ─────────────────────────────────────────────────────────────────────────────

describe("Gate 02：Preview/container/runtime 无旧后台任务耦合", () => {
  it("preview / container / runtime types 不引用 background-task-registry 且无 startBackground/stopBackground", () => {
    const rels = [
      "lib/runtime/preview-runtime.ts",
      "lib/runtime/container/manager.ts",
      "lib/runtime/execution-runtime.ts",
      "lib/runtime/types.ts",
    ];
    const forbidden = ["background-task-registry", "startBackground", "stopBackground"];
    for (const rel of rels) {
      const src = readSource(rel);
      expectSourceFreeFrom(src, rel, forbidden, "Preview/container/runtime 不得耦合旧后台任务 API");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. lib/db/schema.ts / lib/db/queries.ts 不再导出旧 Symbol / 旧查询。
// ─────────────────────────────────────────────────────────────────────────────

describe("Gate 02：DB schema/queries 不再暴露旧 Symbol 与旧查询", () => {
  it("schema.ts 不再导出 backgroundTask/subagent*/threadRun/runTranscriptChunk/threadRunSkill 表", () => {
    const rel = "lib/db/schema.ts";
    const src = readSource(rel);
    const forbiddenTables = [
      "backgroundTask",
      "subagentDefinition",
      "subagentRun",
      "threadRun",
      "runTranscriptChunk",
      "threadRunSkill",
    ];
    const exported = forbiddenTables.filter((name) => exportsSymbol(src, name));
    expect(exported, `schema.ts 不得导出旧表，仍导出：${exported.join(", ")}`).toEqual([]);
  });

  it("queries.ts 不再导出旧 backgroundTask 查询", () => {
    const rel = "lib/db/queries.ts";
    const src = readSource(rel);
    const forbidden = [
      "createBackgroundTask",
      "getBackgroundTask",
      "listBackgroundTasksByThread",
      "updateBackgroundTask",
      "listActiveBackgroundTasksByThread",
      "listActiveBackgroundTasks",
      "markOrphanBackgroundTasksOnStartup",
    ];
    const exported = forbidden.filter((name) => exportsSymbol(src, name));
    expect(
      exported,
      `queries.ts 不得导出旧 backgroundTask 查询，仍导出：${exported.join(", ")}`,
    ).toEqual([]);
  });

  it("queries.ts 不再导出旧 subagent 查询", () => {
    const rel = "lib/db/queries.ts";
    const src = readSource(rel);
    const forbidden = [
      "createSubagentDefinition",
      "getSubagentDefinition",
      "listSubagentDefinitions",
      "createSubagentRun",
      "getSubagentRun",
      "listSubagentRunsByThread",
      "listActiveSubagentRunsByThread",
      "listAllRunningSubagentRuns",
      "markOrphanSubagentRunsOnStartup",
      "updateSubagentRun",
      "cleanupOldSubagentRuns",
    ];
    const exported = forbidden.filter((name) => exportsSymbol(src, name));
    expect(exported, `queries.ts 不得导出旧 subagent 查询，仍导出：${exported.join(", ")}`).toEqual(
      [],
    );
  });

  it("queries.ts 不再导出旧 ThreadRun / transcript / skill 查询", () => {
    const rel = "lib/db/queries.ts";
    const src = readSource(rel);
    const forbidden = [
      "createThreadRun",
      "markThreadRunRunning",
      "heartbeatThreadRun",
      "completeThreadRun",
      "failThreadRun",
      "cancelThreadRun",
      "markStaleThreadRuns",
      "getLatestThreadRun",
      "getActiveThreadRun",
      "getThreadRunByIdForUser",
      "appendRunTranscriptChunk",
      "listRunTranscriptChunks",
      "saveThreadRunSkills",
      "listThreadRunSkillsByRun",
      "listThreadRunSkillsByThread",
    ];
    const exported = forbidden.filter((name) => exportsSymbol(src, name));
    expect(
      exported,
      `queries.ts 不得导出旧 ThreadRun/transcript/skill 查询，仍导出：${exported.join(", ")}`,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Studio 不再暴露 BackgroundTask / SubagentRun 旧面板与 API。
// ─────────────────────────────────────────────────────────────────────────────

describe("Gate 02：Studio 不再暴露旧 BackgroundTask/SubagentRun 面板与 API", () => {
  it("Studio 旧面板与旧 API 路由不存在（不涉及正式 Thread/Turn/Invocation/Job 排障页）", () => {
    const forbidden = [
      "components/studio/background-task-panel.tsx",
      "components/studio/subagent-panel.tsx",
      "app/studio/api/threads/[id]/tasks/route.ts",
      "app/studio/api/threads/[id]/subagents/route.ts",
      "app/studio/api/threads/[id]/subagents/[runId]/cancel/route.ts",
    ];
    for (const rel of forbidden) {
      expectAbsent(rel, "Studio 旧 BackgroundTask/SubagentRun 面板或 API");
    }
  });
});
