import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { backgroundTaskConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

/**
 * Stage A：QA 证据落盘 + 事件 payload 构造（plan / §5）。
 *
 * 证据**不落 DB blob**，落文件（对齐 后台任务日志的 artifact 模式）：
 * - 截图：`.snow/runtime/{threadId}/qa/{checkId}.png`
 * - console/network/a11y/verdict JSON：`.snow/runtime/{threadId}/qa/{checkId}.json`
 *
 * 路径解析：浏览器/gate **在 host 侧**跑（container 模式也打映射端口，不在容器内装浏览器），
 * 故 QA 证据恒落 host 平台目录 `backgroundTaskConfig.hostLogDir`（`.snow/runtime`，已 gitignore、
 * 不被静态 preview server 服务）。这与 的 container→workspace 限制不同——那样是因为
 * 容器进程只能写 bind mount；QA 写者是 host 进程，无此约束，统一 host 目录更简单且不污染用户工作区。
 */

/**
 * ：QA schema 类型从 `lib/desktop/qa-schema` 统一导出（Server/Desktop 共享）。
 * 保留 `@/lib/qa/artifact` 的现有导入路径兼容。
 */
import type {
  QaCheckFailedPayload,
  QaCheckId,
  QaCheckKind,
  QaCheckPassedPayload,
  QaFailure,
  QaRunner,
} from "@/lib/desktop/qa-schema";

export type {
  QaCheckFailedPayload,
  QaCheckId,
  QaCheckKind,
  QaCheckPassedPayload,
  QaFailure,
  QaRunner,
} from "@/lib/desktop/qa-schema";

/** 构造 QA 证据目录绝对路径：`{hostLogDir}/{threadId}/qa/`。 */
export function resolveQaDir(threadId: string): string {
  return resolve(backgroundTaskConfig.hostLogDir, threadId, "qa");
}

/** 构造单个 QA 证据文件绝对路径。 */
export function resolveQaPath(threadId: string, fileName: string): string {
  return resolve(resolveQaDir(threadId), fileName);
}

/** 构造截图文件名。 */
export function screenshotFileName(checkId: QaCheckId, viewport?: number): string {
  return viewport ? `${checkId}-${viewport}.png` : `${checkId}.png`;
}

/** 构造报告 JSON 文件名。 */
export function reportFileName(checkId: QaCheckId): string {
  return `${checkId}.json`;
}

/**
 * 保存截图 buffer 到 artifact，返回**相对 hostLogDir 的相对路径**（供事件 payload /
 * Studio 引用，不暴露绝对文件系统路径）。写入失败 best-effort 返回 null（不阻断 gate）。
 */
export async function saveScreenshot(
  threadId: string,
  checkId: QaCheckId,
  buffer: Buffer,
  viewport?: number,
): Promise<string | null> {
  const name = screenshotFileName(checkId, viewport);
  const abs = resolveQaPath(threadId, name);
  try {
    await mkdir(resolveQaDir(threadId), { recursive: true });
    await writeFile(abs, buffer);
    return relQaPath(threadId, name);
  } catch (error) {
    logger.warn("[qa] 截图落盘失败（best-effort）", {
      threadId,
      checkId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * 保存报告 JSON 到 artifact，返回相对路径（同上）。写入失败 best-effort 返回 null。
 */
export async function saveQaReport(
  threadId: string,
  checkId: QaCheckId,
  report: unknown,
): Promise<string | null> {
  const name = reportFileName(checkId);
  const abs = resolveQaPath(threadId, name);
  try {
    await mkdir(resolveQaDir(threadId), { recursive: true });
    await writeFile(abs, JSON.stringify(report, null, 2), "utf8");
    return relQaPath(threadId, name);
  } catch (error) {
    logger.warn("[qa] 报告落盘失败（best-effort）", {
      threadId,
      checkId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 相对 hostLogDir 的 QA 路径（事件 payload artifactPath 用，不暴露绝对路径）。 */
export function relQaPath(threadId: string, fileName: string): string {
  return `${threadId}/qa/${fileName}`;
}

/** Studio 代理读证据：按相对路径读回 buffer（不存在返回 null）。 */
export async function readQaArtifact(threadId: string, fileName: string): Promise<Buffer | null> {
  try {
    // fileName 可能是相对路径（threadId/qa/x.png）或裸文件名；统一解析到 QA 目录内，
    // 并做词法边界校验，防 `..` 越界读 hostLogDir 外文件。
    const dir = resolveQaDir(threadId);
    const safe = resolve(dir, fileName);
    if (safe !== dir && !safe.startsWith(`${dir}/`)) return null;
    // : 防 symlink 越界——realpath 解析符号链接后再校验在 QA 目录内,
    // 防攻击者在 QA 目录植入 symlink 读取宿主任意文件。
    const real = await realpath(safe);
    const realDir = await realpath(dir);
    if (real !== realDir && !real.startsWith(`${realDir}/`)) return null;
    return await readFile(safe);
  } catch {
    return null;
  }
}

/**
 * 清理 thread 的全部 QA 证据文件（截图 + 报告 JSON）。
 *
 * 原 QA 只写不删，thread 删除/废弃后 .snow/runtime/{threadId}/qa/ 长期累积占磁盘。
 * 本函数物理删除整个 QA 目录；由 retention（终态 thread 明细清理）+ 显式 thread 删除调用。
 * best-effort：删除失败不抛（log warn）。
 */
export async function cleanupQaArtifacts(threadId: string): Promise<void> {
  const dir = resolveQaDir(threadId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn("[qa] 清理 QA 证据失败（best-effort）", {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── QA 趋势/历史聚合 ──────────────────────────

/** QA 检查统计（供 Studio 展示通过率/平均耗时/常见失败）。 */
export type QaStats = {
  totalChecks: number;
  passed: number;
  failed: number;
  passRate: number; // 0-1
  avgDurationMs: number;
  byKind: Record<string, { total: number; passed: number; failed: number }>;
  commonFailures: Array<{ type: string; count: number }>;
};

/**
 * 聚合 qa.check_passed / qa.check_failed 事件为统计。
 * 纯函数：输入事件列表，输出 QaStats。供 Studio API 调用。
 */
export function computeQaStats(events: Array<{ type: string; payload: unknown }>): QaStats {
  let totalChecks = 0;
  let passed = 0;
  let failed = 0;
  let totalDuration = 0;
  const byKind: Record<string, { total: number; passed: number; failed: number }> = {};
  const failureTypeCount = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "qa.check_passed" && e.type !== "qa.check_failed") continue;
    const p = (e.payload ?? {}) as {
      kind?: string;
      durationMs?: number;
      failures?: Array<{ type?: string }>;
    };
    totalChecks++;
    totalDuration += typeof p.durationMs === "number" ? p.durationMs : 0;
    const kind = p.kind ?? "unknown";
    if (!byKind[kind]) byKind[kind] = { total: 0, passed: 0, failed: 0 };
    byKind[kind].total++;
    if (e.type === "qa.check_passed") {
      passed++;
      byKind[kind].passed++;
    } else {
      failed++;
      byKind[kind].failed++;
      for (const f of p.failures ?? []) {
        if (f?.type) failureTypeCount.set(f.type, (failureTypeCount.get(f.type) ?? 0) + 1);
      }
    }
  }
  const commonFailures = [...failureTypeCount.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return {
    totalChecks,
    passed,
    failed,
    passRate: totalChecks > 0 ? passed / totalChecks : 0,
    avgDurationMs: totalChecks > 0 ? Math.round(totalDuration / totalChecks) : 0,
    byKind,
    commonFailures,
  };
}

// ─── 事件 payload 构造 ───────────────────────────────────────
// ：QaFailure / QaCheckPassedPayload / QaCheckFailedPayload 类型
// 已从 `lib/desktop/qa-schema` 统一导入（含 runner 字段），此处仅保留构造函数。

export function buildQaPassedPayload(input: {
  checkId: QaCheckId;
  kind: QaCheckKind;
  viewports: number[];
  durationMs: number;
  artifactPath?: string | null;
  runner?: QaRunner;
}): QaCheckPassedPayload {
  return {
    checkId: input.checkId,
    kind: input.kind,
    viewports: input.viewports,
    durationMs: input.durationMs,
    artifactPath: input.artifactPath ?? null,
    ...(input.runner ? { runner: input.runner } : {}),
  };
}

export function buildQaFailedPayload(input: {
  checkId: QaCheckId;
  kind: QaCheckKind;
  viewports: number[];
  failures: QaFailure[];
  durationMs: number;
  artifactPath?: string | null;
  runner?: QaRunner;
}): QaCheckFailedPayload {
  return {
    checkId: input.checkId,
    kind: input.kind,
    viewports: input.viewports,
    failures: input.failures,
    durationMs: input.durationMs,
    artifactPath: input.artifactPath ?? null,
    ...(input.runner ? { runner: input.runner } : {}),
  };
}
