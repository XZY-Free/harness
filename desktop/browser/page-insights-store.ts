/**
 * V10 Phase 7-3：页面洞察缓冲存储（纯逻辑）。
 *
 * 按 threadId+tabId 缓冲 Console 和 Network 事件，供 browser.getConsole /
 * browser.getNetwork 命令查询。
 *
 * 设计要点：
 * - 纯逻辑，不依赖 electron / CDP，可在 vitest 中完整测试
 * - Console 条目追加式存储（时序保留），Network 条目按 requestId 更新
 * - 提供 level/filter/limit 过滤，与 redaction 模块的 DEFAULT_LIMITS 对齐
 * - clearTab/clearThread 在 tab/thread 关闭时调用，防止内存泄漏
 *
 * 安全约束：
 * - Network body 不在缓冲中保留（body 需通过单独 Artifact 流程获取）
 * - Console text 原样保留（由 redaction 模块在 RPC 返回前脱敏）
 */

import type { ConsoleEntry, NetworkEntry } from "../../lib/desktop/redaction";

/** 缓冲中的网络条目（包含内部状态，查询时转换为 NetworkEntry）。 */
interface BufferedNetworkEntry {
  requestId: string;
  url: string;
  method: string;
  status: number;
  statusText?: string;
  mimeType?: string;
  headers?: Record<string, string>;
  /** 请求发起时间戳（ms），用于计算 duration 和 slow 过滤。 */
  timestamp: number;
  /** 响应完成时间戳（ms），用于计算 duration。 */
  finishedAt?: number;
  /** 请求失败标记。 */
  failed?: boolean;
  /** 失败原因。 */
  errorText?: string;
  /** 响应体大小（字节），来自 loadingFinished.encodedDataLength。 */
  encodedDataLength?: number;
}

/** 慢请求阈值（ms），与架构文档 §7 "slow" 过滤一致。 */
const SLOW_REQUEST_THRESHOLD_MS = 1000;

/**
 * 页面洞察缓冲存储。
 *
 * 管理 Console 和 Network 事件的内存缓冲，按 threadId+tabId 隔离。
 */
export class PageInsightsStore {
  private consoleByTab = new Map<string, ConsoleEntry[]>();
  private networkByTab = new Map<string, Map<string, BufferedNetworkEntry>>();

  // ── Console ──

  /**
   * 追加 Console 条目到指定 tab 的缓冲。
   */
  addConsoleEntry(threadId: string, tabId: string, entry: ConsoleEntry): void {
    const key = this.key(threadId, tabId);
    let entries = this.consoleByTab.get(key);
    if (!entries) {
      entries = [];
      this.consoleByTab.set(key, entries);
    }
    entries.push(entry);
  }

  /**
   * 查询指定 tab 的 Console 条目。
   *
   * @param level - 过滤级别：
   *   - "error"：仅 error + pageerror
   *   - "warning+"：error + pageerror + warning
   *   - undefined：全部
   * @param limit - 最大条目数（默认 50，与 DEFAULT_LIMITS.maxConsoleEntries 一致）
   */
  getConsoleEntries(
    threadId: string,
    tabId: string,
    level?: "error" | "warning+",
    limit?: number,
  ): ConsoleEntry[] {
    const key = this.key(threadId, tabId);
    const entries = this.consoleByTab.get(key);
    if (!entries || entries.length === 0) return [];

    const filtered = filterConsoleByLevel(entries, level);
    const max = limit && limit > 0 ? limit : 50;
    return filtered.slice(-max);
  }

  // ── Network ──

  /**
   * 缓冲 Network.requestWillBeSent 事件（请求发起）。
   */
  bufferNetworkRequest(
    threadId: string,
    tabId: string,
    requestId: string,
    params: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      timestamp: number;
    },
  ): void {
    const key = this.key(threadId, tabId);
    let tabNetwork = this.networkByTab.get(key);
    if (!tabNetwork) {
      tabNetwork = new Map();
      this.networkByTab.set(key, tabNetwork);
    }
    tabNetwork.set(requestId, {
      requestId,
      url: params.url,
      method: params.method,
      status: 0,
      headers: params.headers,
      timestamp: params.timestamp,
    });
  }

  /**
   * 缓冲 Network.responseReceived 事件（响应头到达）。
   */
  bufferNetworkResponse(
    threadId: string,
    tabId: string,
    requestId: string,
    params: {
      status: number;
      statusText?: string;
      mimeType?: string;
      headers?: Record<string, string>;
    },
  ): void {
    const key = this.key(threadId, tabId);
    const tabNetwork = this.networkByTab.get(key);
    if (!tabNetwork) return;
    const entry = tabNetwork.get(requestId);
    if (!entry) return;
    entry.status = params.status;
    entry.statusText = params.statusText;
    entry.mimeType = params.mimeType;
    if (params.headers) {
      entry.headers = { ...entry.headers, ...params.headers };
    }
  }

  /**
   * 标记 Network.loadingFinished（请求成功完成）。
   */
  finalizeNetworkEntry(
    threadId: string,
    tabId: string,
    requestId: string,
    params: { timestamp: number; encodedDataLength?: number },
  ): void {
    const key = this.key(threadId, tabId);
    const tabNetwork = this.networkByTab.get(key);
    if (!tabNetwork) return;
    const entry = tabNetwork.get(requestId);
    if (!entry) return;
    entry.finishedAt = params.timestamp;
    entry.encodedDataLength = params.encodedDataLength;
    entry.failed = false;
  }

  /**
   * 标记 Network.loadingFailed（请求失败）。
   */
  failNetworkEntry(
    threadId: string,
    tabId: string,
    requestId: string,
    params: { timestamp: number; errorText?: string; blockedReason?: string },
  ): void {
    const key = this.key(threadId, tabId);
    const tabNetwork = this.networkByTab.get(key);
    if (!tabNetwork) return;
    const entry = tabNetwork.get(requestId);
    if (!entry) return;
    entry.finishedAt = params.timestamp;
    entry.failed = true;
    entry.errorText = params.errorText ?? params.blockedReason ?? "unknown error";
  }

  /**
   * 查询指定 tab 的 Network 条目。
   *
   * @param filter - 过滤条件：
   *   - "failed"：仅失败请求
   *   - "slow"：仅 duration > 1000ms 的请求
   *   - undefined：全部
   * @param limit - 最大条目数（默认 50）
   */
  getNetworkEntries(
    threadId: string,
    tabId: string,
    filter?: "failed" | "slow",
    limit?: number,
  ): NetworkEntry[] {
    const key = this.key(threadId, tabId);
    const tabNetwork = this.networkByTab.get(key);
    if (!tabNetwork || tabNetwork.size === 0) return [];

    const entries = Array.from(tabNetwork.values());
    const filtered = filterNetworkByFilter(entries, filter);
    const max = limit && limit > 0 ? limit : 50;
    // 按时间戳降序（最新在前），然后截断
    const sorted = filtered.sort((a, b) => b.timestamp - a.timestamp);
    return sorted.slice(0, max).map(toNetworkEntry);
  }

  // ── 清理 ──

  /**
   * 清理指定 tab 的所有缓冲（tab 关闭时调用）。
   */
  clearTab(threadId: string, tabId: string): void {
    const key = this.key(threadId, tabId);
    this.consoleByTab.delete(key);
    this.networkByTab.delete(key);
  }

  /**
   * 清理指定 thread 的所有缓冲（thread 关闭时调用）。
   * @returns 清理的 tab 数量
   */
  clearThread(threadId: string): number {
    let cleared = 0;
    const prefix = `${threadId}:`;
    for (const key of [...this.consoleByTab.keys(), ...this.networkByTab.keys()]) {
      if (key.startsWith(prefix)) {
        this.consoleByTab.delete(key);
        this.networkByTab.delete(key);
        cleared += 1;
      }
    }
    return cleared;
  }

  /**
   * 获取指定 tab 的 Console 条目数（测试用）。
   */
  consoleCount(threadId: string, tabId: string): number {
    return this.consoleByTab.get(this.key(threadId, tabId))?.length ?? 0;
  }

  /**
   * 获取指定 tab 的 Network 条目数（测试用）。
   */
  networkCount(threadId: string, tabId: string): number {
    return this.networkByTab.get(this.key(threadId, tabId))?.size ?? 0;
  }

  private key(threadId: string, tabId: string): string {
    return `${threadId}:${tabId}`;
  }
}

/**
 * 按 level 过滤 Console 条目。
 *
 * - "error"：仅 error + pageerror
 * - "warning+"：error + pageerror + warning
 * - undefined：全部
 */
function filterConsoleByLevel(
  entries: ConsoleEntry[],
  level: "error" | "warning+" | undefined,
): ConsoleEntry[] {
  if (level === undefined) return entries;
  if (level === "error") {
    return entries.filter((e) => e.level === "error" || e.level === "pageerror");
  }
  // warning+
  return entries.filter(
    (e) => e.level === "error" || e.level === "pageerror" || e.level === "warning",
  );
}

/**
 * 按 filter 过滤 Network 条目。
 *
 * - "failed"：仅 failed === true
 * - "slow"：仅 duration > SLOW_REQUEST_THRESHOLD_MS
 * - undefined：全部
 */
function filterNetworkByFilter(
  entries: BufferedNetworkEntry[],
  filter: "failed" | "slow" | undefined,
): BufferedNetworkEntry[] {
  if (filter === undefined) return entries;
  if (filter === "failed") {
    return entries.filter((e) => e.failed === true);
  }
  // slow
  return entries.filter((e) => {
    if (e.finishedAt === undefined) return false;
    return e.finishedAt - e.timestamp > SLOW_REQUEST_THRESHOLD_MS;
  });
}

/**
 * 将内部 BufferedNetworkEntry 转换为对外 NetworkEntry。
 *
 * body 始终为 null（body 需通过 Artifact 流程单独获取）。
 */
function toNetworkEntry(entry: BufferedNetworkEntry): NetworkEntry {
  const duration = entry.finishedAt !== undefined ? entry.finishedAt - entry.timestamp : undefined;
  return {
    url: entry.url,
    method: entry.method,
    status: entry.status,
    statusText: entry.statusText,
    mimeType: entry.mimeType,
    headers: entry.headers,
    body: null,
    duration,
  };
}
