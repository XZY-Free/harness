/**
 * V10 Phase 7-6：本地临时文件注册表（纯逻辑）。
 *
 * 跟踪 Desktop 端产生的本地临时文件，使 closeThread / 进程退出 / 取消时
 * 能批量清理孤儿文件。
 *
 * 设计：
 * - 与 DownloadManager 同构——纯内存 Map，零文件系统依赖，单测易写
 * - key 是 filePath（同一路径只跟踪一次；幂等 register 更新 category）
 * - 唯一约束：register 返回的 entry 是值对象（不可变快照），调用方修改不影响内部状态
 *
 * 三类临时文件：
 * - screenshot：browser-controller.captureScreenshot 写入 os.tmpdir() 的截图
 * - download：will-download 完成后保存到 savedPath 的下载文件
 * - artifact：未来由 artifact-uploader 上传后待清理的中间文件
 *
 * 生命周期：
 *   captureScreenshot / will-download → register
 *   uploadDownload 成功 → unregister（实际 unlink 由调用方执行）
 *   will-download cancelled/interrupted → unregister + unlink 部分写入文件
 *   closeThread → clearThread(threadId) 返回条目，调用方批量 unlink
 *   app.before-quit → clearAll() 返回所有条目，调用方批量 unlink
 */

/** 临时文件类别。 */
export type TempFileCategory = "screenshot" | "download" | "artifact";

/** 单个临时文件的注册信息（值对象，不可变）。 */
export interface TempFileEntry {
  /** 所属 Thread ID。 */
  threadId: string;
  /** 本机文件绝对路径。 */
  filePath: string;
  /** 文件类别。 */
  category: TempFileCategory;
  /** 注册时间戳（Date.now()）。 */
  registeredAt: number;
}

/**
 * 临时文件注册表——纯逻辑，无文件系统依赖。
 *
 * 不直接 unlink——调用方拿条目后用 temp-cleanup 模块执行 unlink。
 * 这样测试时无需 mock fs，集成测试用真实 os.tmpdir() 验证。
 */
export class TempFileRegistry {
  /** key: filePath → entry（filePath 全局唯一，文件只能归属一个 thread） */
  private readonly entries = new Map<string, TempFileEntry>();

  /**
   * 注册一个临时文件。
   *
   * 幂等：同 filePath 已存在则更新 threadId/category/registeredAt，
   * 不创建重复条目（防止因 register 两次导致 clearThread 漏删 / 重复删除）。
   */
  register(threadId: string, filePath: string, category: TempFileCategory): TempFileEntry {
    const entry: TempFileEntry = {
      threadId,
      filePath,
      category,
      registeredAt: Date.now(),
    };
    this.entries.set(filePath, entry);
    return { ...entry };
  }

  /**
   * 移除 filePath 的注册条目。
   * @returns 被移除的 entry（已存在）；未注册返回 undefined
   */
  unregister(filePath: string): TempFileEntry | undefined {
    const entry = this.entries.get(filePath);
    if (!entry) return undefined;
    this.entries.delete(filePath);
    return { ...entry };
  }

  /** 是否已注册。 */
  has(filePath: string): boolean {
    return this.entries.has(filePath);
  }

  /**
   * 列出指定 thread 的所有条目（按注册时间升序）。
   * 返回新数组与值拷贝，调用方修改不影响内部状态。
   */
  listByThread(threadId: string): TempFileEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.threadId === threadId)
      .sort((a, b) => a.registeredAt - b.registeredAt)
      .map((e) => ({ ...e }));
  }

  /**
   * 移除并返回指定 thread 的所有条目。
   * 调用方负责对返回的条目执行 fs.unlink。
   */
  clearThread(threadId: string): TempFileEntry[] {
    const removed: TempFileEntry[] = [];
    for (const [filePath, entry] of this.entries) {
      if (entry.threadId === threadId) {
        removed.push({ ...entry });
        this.entries.delete(filePath);
      }
    }
    return removed.sort((a, b) => a.registeredAt - b.registeredAt);
  }

  /**
   * 移除并返回所有 thread 的所有条目。
   * 用于 app.before-quit 兜底清理。
   */
  clearAll(): TempFileEntry[] {
    const removed = [...this.entries.values()].map((e) => ({ ...e }));
    this.entries.clear();
    return removed.sort((a, b) => a.registeredAt - b.registeredAt);
  }

  /** 当前已注册条目总数。 */
  size(): number {
    return this.entries.size;
  }
}
