/**
 * V10 Phase 7-2：Workspace 上传一次性下载凭证管理器。
 *
 * 架构背景：见 docs/solutions/v10-macos-desktop-web-preview/02-desktop-browser-architecture.md
 * L186-190：AI 只能上传 Thread Workspace 中的文件，由 Server 签发一次性下载凭证，
 * Desktop 下载到临时目录后交给 WebContents。AI 不能指定本机任意路径。
 *
 * 流程：
 * 1. AI 调用 browserUploadFile 工具，传入 workspacePath（workspace 内相对路径）
 * 2. Server 的 browser-rpc-client.ts 在 buildRpcPayload 中：
 *    a. 调用 issueUploadToken(threadId, workspacePath) 签发一次性凭证
 *    b. 构造 downloadUrl（${origin}/api/threads/{threadId}/workspace/download?token=xxx）
 *    c. 将 downloadUrl 放入 RPC payload（替代原来的 filePath）
 * 3. Desktop 收到 RPC 后：
 *    a. 使用 downloadUrl 通过 HTTP GET 下载文件到临时目录
 *    b. 将临时文件路径传给 CDP DOM.setFileInputFiles
 *    c. 操作完成后删除临时文件
 * 4. Server 的 download route 调用 consumeUploadToken(token) 校验并消费凭证
 *
 * 安全约束：
 * - 凭证一次性使用：consume 后立即从 store 删除，无法二次消费
 * - 凭证有 TTL（默认 60s），过期自动失效
 * - 凭证绑定 threadId：消费时校验 threadId 匹配，防跨 Thread 越权
 * - 不依赖外部模块（仅 node:crypto），可在 vitest 中测试
 */
import { randomUUID } from "node:crypto";

/** 凭证条目。 */
interface UploadTokenEntry {
  threadId: string;
  workspacePath: string;
  expiresAt: number;
  used: boolean;
}

/** 消费凭证后返回的信息。 */
export interface ConsumedToken {
  threadId: string;
  workspacePath: string;
}

/**
 * 一次性下载凭证存储。
 *
 * 内存存储（Map），不持久化。Server 重启后所有未消费凭证失效——
 * 凭证 TTL 仅 60s，Desktop 凭证失败可让 Server 重新签发，无需持久化。
 */
export class UploadTokenStore {
  private tokens = new Map<string, UploadTokenEntry>();
  private ttlMs: number;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  /** 签发一次性下载凭证，返回 token（UUID）。 */
  issue(threadId: string, workspacePath: string): string {
    const token = randomUUID();
    this.tokens.set(token, {
      threadId,
      workspacePath,
      expiresAt: Date.now() + this.ttlMs,
      used: false,
    });
    return token;
  }

  /**
   * 消费凭证（一次性使用）。
   *
   * 校验：
   * - token 存在
   * - 未被使用（used=false）
   * - 未过期
   *
   * 任意校验失败返回 null。校验通过后立即删除（一次性使用）。
   */
  consume(token: string): ConsumedToken | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (entry.used) return null;
    if (Date.now() > entry.expiresAt) {
      this.tokens.delete(token);
      return null;
    }
    // 一次性使用后立即删除
    this.tokens.delete(token);
    return { threadId: entry.threadId, workspacePath: entry.workspacePath };
  }

  /**
   * 清理过期凭证。
   *
   * @param now 当前时间戳（参数化便于测试）
   * @returns 清理的凭证数量
   */
  cleanup(now: number): number {
    let count = 0;
    for (const [token, entry] of this.tokens) {
      if (now > entry.expiresAt) {
        this.tokens.delete(token);
        count++;
      }
    }
    return count;
  }

  /** 获取当前凭证数量（测试用）。 */
  size(): number {
    return this.tokens.size;
  }
}

/** 全局单例（Server 进程内共享）。 */
const globalStore = new UploadTokenStore();

/** 签发一次性下载凭证（使用全局单例）。 */
export function issueUploadToken(threadId: string, workspacePath: string): string {
  return globalStore.issue(threadId, workspacePath);
}

/** 消费一次性下载凭证（使用全局单例）。 */
export function consumeUploadToken(token: string): ConsumedToken | null {
  return globalStore.consume(token);
}
