import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { backgroundTaskConfig } from "@/lib/config";
import { workspaceRoot } from "@/lib/workspace";

/**
 * Stage A：后台任务日志文件读写（蓝图 §12 / plan ）。
 *
 * 日志是 append-only 且可能很大，**不落 DB blob**，落文件。logPath 为相对路径
 * `.snow/runtime/{threadId}/tasks/{taskId}.log`，按 runtimeType 解析为不同绝对路径：
 * - host 模式：解析到平台运行时目录（非用户 workspace），`<hostLogDir>/.snow/runtime/...`
 * - container 模式：容器内进程只能写 bind mount 的 `/workspace`，故日志落
 * `workspaces/{threadId}/.snow/runtime/...`（host 经 bind mount 直读）。
 *
 * 读取支持 offset / tail / window，单次读取受 `maxLogReadBytes`（默认 64KB）限长，
 * 不把全量日志塞进模型上下文。
 */

/** 日志相对路径前缀（host / container 共用，相对各自根目录）。 */
const LOG_REL_PREFIX = ".snow/runtime";

/** 构造相对日志路径：`.snow/runtime/{threadId}/tasks/{taskId}.log`。 */
export function relativeLogPath(threadId: string, taskId: string): string {
  return `${LOG_REL_PREFIX}/${threadId}/tasks/${taskId}.log`.split("/").join(sep);
}

/** host 模式绝对日志路径：解析到平台运行时目录（非 workspace）。 */
export function resolveHostLogPath(threadId: string, taskId: string): string {
  return resolve(backgroundTaskConfig.hostLogDir, relativeLogPath(threadId, taskId));
}

/** container 模式绝对日志路径：解析到 workspace bind mount（host 侧直读）。 */
export function resolveContainerLogPath(threadId: string, taskId: string): string {
  return resolve(workspaceRoot(threadId), relativeLogPath(threadId, taskId));
}

/** 按已存储的相对 logPath 与 runtimeType 解析绝对路径（readTaskLogs 用）。 */
export function resolveLogPath(logPath: string, runtimeType: string, threadId: string): string {
  // host：相对平台目录；container：相对 workspace 根（bind mount）
  const base =
    runtimeType === "container" ? workspaceRoot(threadId) : backgroundTaskConfig.hostLogDir;
  return resolve(base, logPath);
}

/**
 * 流式追加日志：自动建父目录，append 写入。
 * 写入失败 best-effort 不抛（长跑进程的日志中断不应导致任务崩溃）。
 *
 * 日志轮转。追加前检查文件大小，超 `backgroundTaskConfig.maxLogFileSize`
 * 则保留尾部一半（最近日志），丢弃头部，防长跑进程日志无限增长撑爆磁盘。
 */
export async function appendLog(absPath: string, chunk: string): Promise<void> {
  try {
    await mkdir(dirname(absPath), { recursive: true });
    const cap = backgroundTaskConfig.maxLogFileSize;
    if (cap > 0) {
      const size = await stat(absPath)
        .then((s) => s.size)
        .catch(() => 0);
      if (size > cap) {
        // 轮转：保留尾部 cap/2 字节
        const keep = Math.floor(cap / 2);
        const buf = Buffer.alloc(keep);
        const fhRead = await open(absPath, "r");
        try {
          await fhRead.read(buf, 0, keep, size - keep);
        } finally {
          await fhRead.close();
        }
        const fhWrite = await open(absPath, "w");
        try {
          await fhWrite.writeFile(buf);
        } finally {
          await fhWrite.close();
        }
      }
    }
    const fh = await open(absPath, "a");
    try {
      await fh.writeFile(chunk);
    } finally {
      await fh.close();
    }
  } catch {
    // best-effort：日志写入失败不阻断主流程
  }
}

export interface ReadLogOpts {
  /** 起始字节偏移（默认 0）。 */
  offset?: number;
  /** 返回最后 N 字节（覆盖 offset/window）。 */
  tail?: number;
  /** 返回 [offset, offset+window) 字节。缺省则返回到文件尾。 */
  window?: number;
  /** 单次返回上限（默认 backgroundTaskConfig.maxLogReadBytes）。超出截断并置 truncated。 */
  maxBytes?: number;
}

export interface ReadLogResult {
  /** 实际读取到的内容（可能被 maxBytes 截断）。 */
  content: string;
  /** 文件总字节数（截断前的原始大小）。 */
  totalBytes: number;
  /** 是否因 maxBytes 截断。 */
  truncated: boolean;
  /** 本次读取的起始字节偏移。 */
  offset: number;
}

/**
 * 读取日志片段。
 *
 * 优先级：tail > window > offset。`truncated` 仅当「自然应读长度」超过 maxBytes 时为 true
 * （即被 maxBytes 截断）；window / tail 恰好满足时不截断。
 *
 * - tail：返回最后 min(tail, maxBytes) 字节；自然长度 = min(tail, size)。
 * tail > maxBytes 时返回最后 maxBytes 字节并 truncated=true。
 * - window：返回 [offset, offset + min(window, maxBytes))；自然长度 = min(window, size-offset)。
 * - offset only：返回 [offset, offset + min(size-offset, maxBytes))；自然长度 = size-offset。
 *
 * 文件不存在 / 越界 offset → 返回空内容 + 对应 totalBytes（0 或真实大小），truncated=false。
 */
export async function readLog(absPath: string, opts: ReadLogOpts = {}): Promise<ReadLogResult> {
  const maxBytes = opts.maxBytes ?? backgroundTaskConfig.maxLogReadBytes;
  const size = await stat(absPath)
    .then((s) => s.size)
    .catch(() => null);

  // 文件不存在
  if (size === null) {
    return { content: "", totalBytes: 0, truncated: false, offset: opts.offset ?? 0 };
  }

  // tail：最后 N 字节。自然长度 = min(tail, size)；被 maxBytes 截断时返回最后 maxBytes 字节。
  if (opts.tail !== undefined && opts.tail > 0) {
    const natural = Math.min(opts.tail, size);
    const cap = Math.min(natural, maxBytes);
    const start = size - cap; // tail 永远贴文件尾
    const truncated = natural > cap;
    const content = await readRange(absPath, start, cap);
    return { content, totalBytes: size, truncated, offset: start };
  }

  const start = Math.max(0, opts.offset ?? 0);
  // 越界 offset → 空内容
  if (start >= size) {
    return { content: "", totalBytes: size, truncated: false, offset: start };
  }

  const available = size - start;
  const natural =
    opts.window !== undefined && opts.window > 0 ? Math.min(opts.window, available) : available;
  const cap = Math.min(natural, maxBytes);
  const truncated = natural > cap;
  const content = await readRange(absPath, start, cap);
  return { content, totalBytes: size, truncated, offset: start };
}

/** 读取 [start, start + len) 字节（len 已受 maxBytes 约束）。len<=0 返回空串。 */
async function readRange(absPath: string, start: number, len: number): Promise<string> {
  if (len <= 0) return "";
  const buf = Buffer.alloc(len);
  const fh = await open(absPath, "r");
  try {
    await fh.read(buf, 0, len, start);
  } finally {
    await fh.close();
  }
  return buf.toString("utf8");
}

/** 仅供测试：直接读全量文件为字符串（不受 maxBytes 约束）。 */
export async function readFullLog(absPath: string): Promise<string> {
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return "";
  }
}
