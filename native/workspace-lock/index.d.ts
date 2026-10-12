/**
 * workspace-lock 原生模块类型（A07 决策一）。
 *
 * 语义见 `native/workspace-lock/src/mutex.cc` 顶部注释与
 * `docs/topic02/nexharness-topic02-repair/specs/A07-physical-writer.md` 决策一。
 */

/** 一个已取得的内核锁句柄（POSIX open file description 上的 `flock(LOCK_EX)`）。 */
export type WorkspaceLockHandle = object;

export type WorkspaceLockAcquireResult =
  | { readonly state: "held"; readonly handle: WorkspaceLockHandle }
  /** 他人持有：调用方按有界等待重试，**不得** rename/unlink 锁文件。 */
  | { readonly state: "busy" };

export type WorkspaceLockReleaseResult = {
  readonly state: "released" | "already_released";
};

export interface WorkspaceLockFileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly exists: boolean;
}

/**
 * 非阻塞地取得稳定锁文件的排他锁。
 *
 * 抛出（而不是返回 busy）：真实系统错误（权限、路径非法、平台不支持）。
 * `unsupported_platform` 表示当前平台没有等价实现 —— 不提供"总是成功"的假接口。
 */
export function openAndTryLock(stablePath: string): WorkspaceLockAcquireResult;

/** 释放并关闭句柄。幂等。 */
export function unlockAndClose(handle: WorkspaceLockHandle): WorkspaceLockReleaseResult;

/** 句柄是否已释放（诊断用）。 */
export function isReleased(handle: WorkspaceLockHandle): boolean;

/** 锁文件的 inode 身份（诊断用：证明锁文件不被 rename/unlink/recreate）。 */
export function lockFileIdentity(stablePath: string): WorkspaceLockFileIdentity;

/** 以受管根目录描述符为锚写入；拒绝祖先及最终符号链接。 */
export function secureWriteFile(
  root: string,
  relativePath: string,
  content: string,
): { readonly state: "written" };

/** 以受管根目录描述符为锚删除普通文件；拒绝祖先及最终符号链接。 */
export function secureDeleteFile(
  root: string,
  relativePath: string,
): { readonly state: "deleted" | "absent" };

export const BINARY_PATHS: readonly string[];
