/**
 * V10 Phase 7-1：下载记录管理器。
 *
 * 管理浏览器下载的生命周期：从 Electron Session 的 `will-download` 事件捕获下载项，
 * 跟踪进度，最终流式上传到 Server 的 Thread workspace `downloads/` 目录。
 *
 * 本模块为纯逻辑模块，不依赖 electron，可在 vitest 中测试。
 * Electron 集成（事件监听、文件系统操作）由 BrowserController 处理。
 *
 * 状态流转：
 *   pending → downloading → completed → uploading → uploaded
 *                       ↘ failed                    ↘ upload_failed
 *                       ↘ cancelled
 *
 * 不变性：
 * - savedPath 在 completeDownload 后保持不变（即使后续上传失败也不抹除）
 * - workspacePath 在 completeUpload 后保持不变
 * - 失败时只设置 error 字段，不伪装 completed
 */

/** 下载状态。 */
export type DownloadState =
  | "pending"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled"
  | "uploading"
  | "uploaded"
  | "upload_failed";

/** 下载记录。 */
export interface DownloadRecord {
  id: string;
  threadId: string;
  tabId: string;
  fileName: string;
  url: string;
  mimeType: string;
  totalBytes: number;
  receivedBytes: number;
  state: DownloadState;
  savedPath: string | null;
  workspacePath: string | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
  uploadedAt: number | null;
}

/** 创建下载记录时的入参。 */
export interface CreateDownloadParams {
  threadId: string;
  tabId: string;
  fileName: string;
  url: string;
  mimeType: string;
  totalBytes: number;
}

/** 自增 ID 计数器（模块级，避免在测试间重复）。 */
let downloadIdCounter = 0;

/** 生成下载 ID：基于时间戳 + 自增计数器，保证进程内唯一。 */
function generateDownloadId(): string {
  downloadIdCounter += 1;
  return `dl-${Date.now().toString(36)}-${downloadIdCounter.toString(36)}`;
}

/**
 * 下载管理器（纯逻辑）。
 *
 * 维护 `downloads` 主索引与 `byThread` 二级索引，支持按 thread 高效列举与清理。
 */
export class DownloadManager {
  private downloads = new Map<string, DownloadRecord>();
  private byThread = new Map<string, Set<string>>();

  /** 创建下载记录。 */
  createDownload(params: CreateDownloadParams): DownloadRecord {
    const record: DownloadRecord = {
      id: generateDownloadId(),
      threadId: params.threadId,
      tabId: params.tabId,
      fileName: params.fileName,
      url: params.url,
      mimeType: params.mimeType,
      totalBytes: params.totalBytes,
      receivedBytes: 0,
      state: "pending",
      savedPath: null,
      workspacePath: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      uploadedAt: null,
    };
    this.downloads.set(record.id, record);
    this.getThreadSet(record.threadId).add(record.id);
    return record;
  }

  /** 更新下载进度。状态置为 downloading。 */
  updateProgress(id: string, receivedBytes: number): DownloadRecord | null {
    const record = this.downloads.get(id);
    if (!record) return null;
    record.receivedBytes = receivedBytes;
    record.state = "downloading";
    return record;
  }

  /** 标记本机下载完成。设置 savedPath，状态置为 completed。 */
  completeDownload(id: string, savedPath: string): DownloadRecord | null {
    const record = this.downloads.get(id);
    if (!record) return null;
    record.savedPath = savedPath;
    record.state = "completed";
    record.completedAt = Date.now();
    return record;
  }

  /** 标记下载失败。设置 error，状态置为 failed。 */
  failDownload(id: string, error: string): DownloadRecord | null {
    const record = this.downloads.get(id);
    if (!record) return null;
    record.error = error;
    record.state = "failed";
    record.completedAt = Date.now();
    return record;
  }

  /** 标记下载取消。状态置为 cancelled。 */
  cancelDownload(id: string): DownloadRecord | null {
    const record = this.downloads.get(id);
    if (!record) return null;
    record.state = "cancelled";
    record.completedAt = Date.now();
    return record;
  }

  /** 标记开始上传。状态置为 uploading。 */
  startUpload(id: string): DownloadRecord | null {
    const record = this.downloads.get(id);
    if (!record) return null;
    record.state = "uploading";
    return record;
  }

  /** 标记上传完成。设置 workspacePath，状态置为 uploaded。 */
  completeUpload(id: string, workspacePath: string): DownloadRecord | null {
    const record = this.downloads.get(id);
    if (!record) return null;
    record.workspacePath = workspacePath;
    record.state = "uploaded";
    record.uploadedAt = Date.now();
    return record;
  }

  /** 标记上传失败。设置 error，状态置为 upload_failed。 */
  failUpload(id: string, error: string): DownloadRecord | null {
    const record = this.downloads.get(id);
    if (!record) return null;
    record.error = error;
    record.state = "upload_failed";
    return record;
  }

  /** 获取单个下载记录。 */
  getDownload(id: string): DownloadRecord | null {
    return this.downloads.get(id) ?? null;
  }

  /** 列出 Thread 的下载记录，按 createdAt 降序（最新在前）。 */
  listDownloads(threadId: string): DownloadRecord[] {
    const ids = this.byThread.get(threadId);
    if (!ids || ids.size === 0) return [];
    const records: DownloadRecord[] = [];
    for (const id of ids) {
      const record = this.downloads.get(id);
      if (record) records.push(record);
    }
    records.sort((a, b) => b.createdAt - a.createdAt);
    return records;
  }

  /** 清理 Thread 的下载记录（tab 关闭 / thread 销毁时调用）。返回清理条数。 */
  clearThread(threadId: string): number {
    const ids = this.byThread.get(threadId);
    if (!ids || ids.size === 0) return 0;
    const count = ids.size;
    for (const id of ids) {
      this.downloads.delete(id);
    }
    this.byThread.delete(threadId);
    return count;
  }

  /** 获取或创建 thread 对应的下载 ID 集合。 */
  private getThreadSet(threadId: string): Set<string> {
    let set = this.byThread.get(threadId);
    if (!set) {
      set = new Set();
      this.byThread.set(threadId, set);
    }
    return set;
  }
}
