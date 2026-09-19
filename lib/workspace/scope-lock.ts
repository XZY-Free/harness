/**
 * 受管 Workspace scope 的跨进程临界区（A07 决策一）。
 *
 * ## 为什么替换掉旧实现
 *
 * 旧实现用 `mkdir` 的原子性做互斥量，于是"回收"只能靠 `rename` 走别人的锁目录。
 * 审查报告点出的是**路径替换竞争**：读完持有者记录到真正 `rename` 之间有一个间隙，
 * 锁目录可以在该间隙里被重建，于是两个恢复者都会认为自己取得了锁；
 * 再次读一次 `holderId` 也不是文件系统 CAS。
 *
 * 现在锁落在**稳定文件**的 inode 上（`flock(LOCK_EX)` + `O_CLOEXEC`）：
 *
 * - 持锁进程被 SIGKILL → OS 在进程退出时释放，**不需要**任何"过期持有者回收"；
 * - 本模块**从不** rename / unlink / 按 mtime 删除锁文件；
 * - 等待是非阻塞尝试 + 有界异步等待，不会阻塞事件循环；
 * - 取消/超时只让**等待者**失败，绝不触碰现有持有者的锁。
 *
 * 持有者诊断 JSON（`<lock>.holder.json`）只用于排障，**不赋予任何抢锁权**。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
  WorkspaceLockAcquireResult,
  WorkspaceLockFileIdentity,
  WorkspaceLockHandle,
} from "../../native/workspace-lock";

const NATIVE_MODULE_DIR = /* turbopackIgnore: true */ join(
  process.cwd(),
  "native",
  "workspace-lock",
);

interface NativeBinding {
  openAndTryLock(stablePath: string): WorkspaceLockAcquireResult;
  unlockAndClose(handle: WorkspaceLockHandle): { state: "released" | "already_released" };
  isReleased(handle: WorkspaceLockHandle): boolean;
  lockFileIdentity(stablePath: string): WorkspaceLockFileIdentity;
}

/** 默认等待上限（毫秒）。 */
export const SCOPE_LOCK_TIMEOUT_MS = 10_000;
/** 两次非阻塞尝试之间的等待（毫秒）。 */
export const SCOPE_LOCK_RETRY_MS = 15;

/** 锁文件的稳定名字（同 scope 的所有 Broker 进程必须算出同一个路径）。 */
export const SCOPE_LOCK_FILE_NAME = "scope.lock";
/** 持有者诊断文件名（**不是**锁本身）。 */
export const SCOPE_LOCK_HOLDER_FILE_NAME = "scope.lock.holder.json";

/** 内核锁不可用（未构建原生模块 / 平台无等价实现）——这是环境错误，不是"占用"。 */
export class ScopeLockUnavailableError extends Error {
  readonly code = "ScopeLockUnavailable";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScopeLockUnavailableError";
  }
}

/** 等待超时或他人持有：**可重试**,调用方不得据此写任何结论。 */
export class ScopeLockBusyError extends Error {
  readonly code = "ScopeLockBusy";
  constructor(
    readonly lockPath: string,
    readonly waitedMs: number,
    readonly holderDiagnostic: string | null,
  ) {
    super(
      `Workspace scope 锁在 ${waitedMs}ms 内不可取得：${lockPath}${
        holderDiagnostic ? `（持有者诊断：${holderDiagnostic}）` : ""
      }`,
    );
    this.name = "ScopeLockBusyError";
  }
}

let cachedBinding: NativeBinding | null = null;

function loadNativeBinding(): NativeBinding {
  if (cachedBinding) return cachedBinding;
  try {
    const require = createRequire(/* turbopackIgnore: true */ join(NATIVE_MODULE_DIR, "index.cjs"));
    cachedBinding = require(NATIVE_MODULE_DIR) as NativeBinding;
    return cachedBinding;
  } catch (error) {
    throw new ScopeLockUnavailableError(
      `workspace-lock 原生 provider 不可用：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** scope 的稳定锁文件路径。`grantsRoot` 由 Broker 按 scopeDigest 派生。 */
export function scopeLockFilePath(grantsRoot: string): string {
  return join(grantsRoot, SCOPE_LOCK_FILE_NAME);
}

/** 锁文件身份（诊断/证据：证明锁文件不被 rename / unlink / recreate）。 */
export function scopeLockIdentity(lockPath: string): WorkspaceLockFileIdentity {
  return loadNativeBinding().lockFileIdentity(lockPath);
}

export interface AcquiredScopeLock {
  readonly lockPath: string;
  readonly holderId: string;
  /** 幂等释放；进程退出时由 OS 兜底。 */
  release(): void;
}

function writeHolderDiagnostic(lockPath: string, holder: ScopeLockHolderDiagnostic): void {
  try {
    writeFileSync(`${lockPath}.holder.json`, `${JSON.stringify(holder)}\n`, "utf8");
  } catch {
    // 诊断信息尽力而为：写不进去不影响持锁（锁由内核持有，不由这个文件表达）。
  }
}

export interface ScopeLockHolderDiagnostic {
  holderId: string;
  pid: number;
  hostIdentity: string | null;
  acquiredAt: string;
}

/**
 * **非阻塞**尝试取得 scope 内核锁。
 *
 * - 取得 → 返回可释放句柄；
 * - 他人持有 → 返回 `null`（调用方按自己的有界等待重试）；
 * - 原生 provider 不可用/系统错误 → 抛 `ScopeLockUnavailableError`。
 *
 * 本函数**不会**因为任何理由去 rename/unlink 锁文件。
 */
export function tryAcquireScopeLock(input: {
  lockPath: string;
  hostIdentity?: string | null;
}): AcquiredScopeLock | null {
  const binding = loadNativeBinding();
  mkdirSync(dirname(input.lockPath), { recursive: true });
  const result = binding.openAndTryLock(input.lockPath);
  if (result.state === "busy") return null;
  const handle = result.handle;
  const holderId = `lock:${process.pid}:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  writeHolderDiagnostic(input.lockPath, {
    holderId,
    pid: process.pid,
    hostIdentity: input.hostIdentity ?? null,
    acquiredAt: new Date().toISOString(),
  });
  let released = false;
  return {
    lockPath: input.lockPath,
    holderId,
    release() {
      if (released) return;
      released = true;
      binding.unlockAndClose(handle);
    },
  };
}

function readHolderDiagnostic(lockPath: string): string | null {
  try {
    // 同步小文件读取：仅用于超时报错文案，不参与任何抢锁判定。
    const raw = readFileSync(`${lockPath}.holder.json`, "utf8");
    const parsed = JSON.parse(raw) as ScopeLockHolderDiagnostic;
    return `pid=${parsed.pid} host=${parsed.hostIdentity ?? "unknown"} since=${parsed.acquiredAt}`;
  } catch {
    return null;
  }
}

/**
 * 在 scope 内核临界区内执行 `run()`。
 *
 * - 整个异步临界区结束后才解锁/关闭句柄；
 * - 等待超时抛 `ScopeLockBusyError`（可重试占用），**不**删除/rename 任何锁文件；
 * - 非阻塞尝试 + 异步 `delay`，不会堵住事件循环（heartbeat 保持可用）。
 */
export async function withScopeLock<T>(input: {
  lockPath: string;
  hostIdentity?: string | null;
  timeoutMs?: number;
  retryMs?: number;
  run: () => Promise<T>;
}): Promise<T> {
  const timeoutMs = input.timeoutMs ?? SCOPE_LOCK_TIMEOUT_MS;
  const retryMs = input.retryMs ?? SCOPE_LOCK_RETRY_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  for (;;) {
    const acquired = tryAcquireScopeLock({
      lockPath: input.lockPath,
      hostIdentity: input.hostIdentity ?? null,
    });
    if (acquired) {
      try {
        return await input.run();
      } finally {
        acquired.release();
      }
    }
    if (Date.now() >= deadline) {
      throw new ScopeLockBusyError(
        input.lockPath,
        Date.now() - startedAt,
        readHolderDiagnostic(input.lockPath),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

/** 原生 provider 是否已就绪（用于启动自检与验收门禁；不吞掉构建缺失）。 */
export function scopeLockProviderAvailable(): boolean {
  try {
    loadNativeBinding();
    return true;
  } catch {
    return false;
  }
}

/** 只读探测：锁文件是否存在（诊断用）。 */
export function scopeLockFileExists(lockPath: string): boolean {
  return existsSync(lockPath);
}
