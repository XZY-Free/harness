/**
 * V10 Phase 4：Session partition 管理器。
 *
 * 管理 Electron Session partition 名称：
 * - App Session（SnowHarness BrowserWindow）：persist:snowharness-app
 * - Browser Profile Session（外部 WebContentsView）：persist:snowharness-browser-{userId}
 * - Incognito Session：snowharness-incognito-{threadId}-{nonce}
 *
 * 同一 userId 的 Thread 共享 Browser Profile partition（共享登录态）。
 * 隐身 session 不使用 persist: 前缀，关闭后数据不持久化。
 * App Session 和 Browser Profile Session 完全隔离。
 *
 * 参考架构：docs/solutions/v10-macos-desktop-web-preview/02-desktop-browser-architecture.md §5。
 */

/** App Session partition（SnowHarness BrowserWindow 使用） */
export const APP_SESSION_PARTITION = "persist:snowharness-app";

/** Browser Profile partition 前缀 */
export const BROWSER_PARTITION_PREFIX = "persist:snowharness-browser-";

/** Incognito partition 前缀（不加 persist:） */
export const INCOGNITO_PARTITION_PREFIX = "snowharness-incognito-";

/** userId 规范化（只保留 [a-zA-Z0-9_-]，其余替换为下划线） */
export function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 生成 Browser Profile partition 名称（同一 userId 共享） */
export function getBrowserPartition(userId: string): string {
  return `${BROWSER_PARTITION_PREFIX}${sanitizeUserId(userId)}`;
}

/** 生成 Incognito partition 名称（每次创建唯一，关闭后销毁） */
export function getIncognitoPartition(threadId: string, nonce?: string): string {
  const sanitizedThread = sanitizeUserId(threadId);
  const n = nonce ?? Date.now().toString(36);
  return `${INCOGNITO_PARTITION_PREFIX}${sanitizedThread}-${n}`;
}

/** 判断 partition 是否为 persist:（持久化） */
export function isPersistentPartition(partition: string): boolean {
  return partition.startsWith("persist:");
}

/** 判断 partition 是否为 App Session */
export function isAppSession(partition: string): boolean {
  return partition === APP_SESSION_PARTITION;
}

/** 判断 partition 是否为 Browser Profile */
export function isBrowserProfile(partition: string): boolean {
  return partition.startsWith(BROWSER_PARTITION_PREFIX);
}

/** 判断 partition 是否为 Incognito */
export function isIncognito(partition: string): boolean {
  return partition.startsWith(INCOGNITO_PARTITION_PREFIX);
}

/**
 * SessionManager - 管理 userId 到 partition 的映射。
 *
 * 纯逻辑模块。Electron Session.fromPartition() 调用由 BrowserController 负责。
 * 这里只管理映射关系和 incognito 生命周期追踪。
 */
export class SessionManager {
  /** userId → browser partition 映射 */
  private userPartitions = new Map<string, string>();
  /** 活跃的 incognito partitions（threadId → Set<partition>） */
  private incognitoPartitions = new Map<string, Set<string>>();

  /** 获取或创建 userId 对应的 Browser Profile partition */
  getOrCreateBrowserPartition(userId: string): string {
    let partition = this.userPartitions.get(userId);
    if (!partition) {
      partition = getBrowserPartition(userId);
      this.userPartitions.set(userId, partition);
    }
    return partition;
  }

  /** 创建 incognito partition 并追踪 */
  createIncognitoPartition(threadId: string, nonce?: string): string {
    const partition = getIncognitoPartition(threadId, nonce);
    let set = this.incognitoPartitions.get(threadId);
    if (!set) {
      set = new Set();
      this.incognitoPartitions.set(threadId, set);
    }
    set.add(partition);
    return partition;
  }

  /** 销毁 Thread 的所有 incognito partitions（关闭最后一个隐身 tab 时调用） */
  destroyIncognitoPartitions(threadId: string): string[] {
    const set = this.incognitoPartitions.get(threadId);
    if (!set) return [];
    const destroyed = [...set];
    this.incognitoPartitions.delete(threadId);
    return destroyed;
  }

  /** 获取 Thread 的活跃 incognito partitions 数量 */
  getIncognitoCount(threadId: string): number {
    return this.incognitoPartitions.get(threadId)?.size ?? 0;
  }

  /** 移除 userId 的 Browser Profile（用户退出登录时调用） */
  removeBrowserProfile(userId: string): boolean {
    return this.userPartitions.delete(userId);
  }

  /** 获取所有已注册的 userId 列表 */
  getUserIds(): string[] {
    return [...this.userPartitions.keys()];
  }
}
