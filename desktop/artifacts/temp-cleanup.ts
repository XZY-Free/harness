/**
 * V10 Phase 7-6：临时文件清理工具。
 *
 * 提供 safeUnlink、cleanupTempFiles、cleanupThreadTempFiles、cleanupAllTempFiles 四个函数：
 * - safeUnlink：单文件删除，ENOENT 幂等，其他错误静默返回 false（清理失败不阻断主流程）
 * - cleanupTempFiles：批量删除，并发 unlink，返回成功清理的条目数
 * - cleanupThreadTempFiles：从 registry 清空并清理指定 thread 的所有条目
 * - cleanupAllTempFiles：从 registry 清空并清理所有 thread 的所有条目（进程退出兜底）
 *
 * 设计约束：
 * - 不依赖 logger（保持纯函数，桌面 main 进程可在外层包日志）
 * - 不抛错（清理失败记录由调用方决定）
 * - cleanupThreadTempFiles/cleanupAllTempFiles 把 registry.clear + cleanupTempFiles 组合，
 *   避免调用方遗漏 unregister 步骤导致孤儿注册条目
 */

import { promises as fs } from "node:fs";
import type { TempFileEntry, TempFileRegistry } from "./temp-file-registry";

/**
 * 安全 unlink 单个文件。
 *
 * @returns true 表示文件已不存在（删除成功或本来就不存在）；
 *          false 表示删除失败（权限不足、路径是目录等）
 */
export async function safeUnlink(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      // 文件不存在视为已清理（幂等）
      return true;
    }
    // 其他错误（EISDIR、EACCES、EPERM 等）静默忽略——清理失败不阻断主流程
    return false;
  }
}

/**
 * 批量清理临时文件：并发 unlink 所有条目。
 *
 * @param entries 来自 TempFileRegistry.clearThread / clearAll 的条目列表
 * @returns 成功清理的条目数（safeUnlink 返回 true 的数量）
 */
export async function cleanupTempFiles(entries: TempFileEntry[]): Promise<number> {
  if (entries.length === 0) return 0;
  const results = await Promise.allSettled(entries.map((e) => safeUnlink(e.filePath)));
  return results.filter((r) => r.status === "fulfilled" && r.value === true).length;
}

/**
 * 清空 registry 中指定 thread 的所有条目并 unlink 对应文件。
 *
 * 用于 BrowserController.closeThread——确保 thread 关闭时其所有临时文件被清理。
 * registry.clearThread 返回条目后立即执行 cleanupTempFiles，保证原子性
 * （即使部分 unlink 失败，registry 条目也已移除，不残留孤儿注册）。
 *
 * @returns 成功清理的条目数
 */
export async function cleanupThreadTempFiles(
  registry: TempFileRegistry,
  threadId: string,
): Promise<number> {
  const entries = registry.clearThread(threadId);
  return cleanupTempFiles(entries);
}

/**
 * 清空 registry 中所有 thread 的所有条目并 unlink 对应文件。
 *
 * 用于 app.before-quit 兜底清理——进程退出前尽力清理所有未跟踪的临时文件。
 *
 * @returns 成功清理的条目数
 */
export async function cleanupAllTempFiles(registry: TempFileRegistry): Promise<number> {
  const entries = registry.clearAll();
  return cleanupTempFiles(entries);
}
