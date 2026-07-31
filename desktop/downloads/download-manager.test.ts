import { beforeEach, describe, expect, it } from "vitest";
import { DownloadManager, type DownloadRecord, type DownloadState } from "./download-manager";

/**
 * V10 Phase 7-1：DownloadManager 单元测试。
 *
 * 验证下载记录的生命周期：
 * - createDownload 创建记录，状态为 pending
 * - updateProgress 更新 receivedBytes，状态为 downloading
 * - completeDownload 设置 savedPath，状态为 completed
 * - failDownload 设置 error，状态为 failed
 * - cancelDownload 状态为 cancelled
 * - startUpload 状态为 uploading
 * - completeUpload 设置 workspacePath，状态为 uploaded
 * - failUpload 状态为 upload_failed
 * - listDownloads 按 threadId 过滤，按 createdAt 降序
 * - clearThread 清理指定 thread 的所有记录
 * - 不存在的 id 返回 null
 */

describe("DownloadManager", () => {
  let manager: DownloadManager;

  beforeEach(() => {
    manager = new DownloadManager();
  });

  describe("createDownload", () => {
    it("创建记录，状态为 pending", () => {
      const record = manager.createDownload({
        threadId: "thread-1",
        tabId: "tab-1",
        fileName: "report.pdf",
        url: "https://example.com/report.pdf",
        mimeType: "application/pdf",
        totalBytes: 1024,
      });

      expect(record.id).toBeTruthy();
      expect(record.threadId).toBe("thread-1");
      expect(record.tabId).toBe("tab-1");
      expect(record.fileName).toBe("report.pdf");
      expect(record.url).toBe("https://example.com/report.pdf");
      expect(record.mimeType).toBe("application/pdf");
      expect(record.totalBytes).toBe(1024);
      expect(record.receivedBytes).toBe(0);
      expect(record.state).toBe("pending");
      expect(record.savedPath).toBeNull();
      expect(record.workspacePath).toBeNull();
      expect(record.error).toBeNull();
      expect(record.createdAt).toBeGreaterThan(0);
      expect(record.completedAt).toBeNull();
      expect(record.uploadedAt).toBeNull();
    });

    it("totalBytes 可为 -1 表示未知大小", () => {
      const record = manager.createDownload({
        threadId: "thread-1",
        tabId: "tab-1",
        fileName: "video.mp4",
        url: "https://example.com/video.mp4",
        mimeType: "video/mp4",
        totalBytes: -1,
      });
      expect(record.totalBytes).toBe(-1);
    });

    it("每次创建记录 id 唯一", () => {
      const r1 = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 10,
      });
      const r2 = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "b.txt",
        url: "https://b.com/b.txt",
        mimeType: "text/plain",
        totalBytes: 20,
      });
      expect(r1.id).not.toBe(r2.id);
    });
  });

  describe("updateProgress", () => {
    it("更新 receivedBytes 并将状态置为 downloading", () => {
      const record = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 100,
      });

      const updated = manager.updateProgress(record.id, 50);
      expect(updated).not.toBeNull();
      expect(updated?.receivedBytes).toBe(50);
      expect(updated?.state).toBe("downloading");
    });

    it("不存在的 id 返回 null", () => {
      const result = manager.updateProgress("nonexistent-id", 50);
      expect(result).toBeNull();
    });

    it("多次更新累计 receivedBytes", () => {
      const record = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 100,
      });

      manager.updateProgress(record.id, 30);
      manager.updateProgress(record.id, 60);
      const final = manager.updateProgress(record.id, 100);
      expect(final?.receivedBytes).toBe(100);
    });
  });

  describe("completeDownload", () => {
    it("设置 savedPath 并将状态置为 completed", () => {
      const record = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 100,
      });
      manager.updateProgress(record.id, 100);

      const updated = manager.completeDownload(record.id, "/tmp/snowharness/a.txt");
      expect(updated).not.toBeNull();
      expect(updated?.savedPath).toBe("/tmp/snowharness/a.txt");
      expect(updated?.state).toBe("completed");
      expect(updated?.receivedBytes).toBe(100);
      expect(updated?.completedAt).not.toBeNull();
      expect(updated?.completedAt).toBeGreaterThan(0);
    });

    it("不存在的 id 返回 null", () => {
      const result = manager.completeDownload("nonexistent-id", "/tmp/x");
      expect(result).toBeNull();
    });
  });

  describe("failDownload", () => {
    it("设置 error 并将状态置为 failed", () => {
      const record = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 100,
      });

      const updated = manager.failDownload(record.id, "网络中断");
      expect(updated).not.toBeNull();
      expect(updated?.error).toBe("网络中断");
      expect(updated?.state).toBe("failed");
      expect(updated?.completedAt).not.toBeNull();
    });

    it("不存在的 id 返回 null", () => {
      const result = manager.failDownload("nonexistent-id", "err");
      expect(result).toBeNull();
    });
  });

  describe("cancelDownload", () => {
    it("将状态置为 cancelled", () => {
      const record = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 100,
      });

      const updated = manager.cancelDownload(record.id);
      expect(updated).not.toBeNull();
      expect(updated?.state).toBe("cancelled");
      expect(updated?.completedAt).not.toBeNull();
    });

    it("不存在的 id 返回 null", () => {
      const result = manager.cancelDownload("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  describe("startUpload", () => {
    it("将状态置为 uploading", () => {
      const record = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 100,
      });
      manager.completeDownload(record.id, "/tmp/a.txt");

      const updated = manager.startUpload(record.id);
      expect(updated).not.toBeNull();
      expect(updated?.state).toBe("uploading");
    });

    it("不存在的 id 返回 null", () => {
      const result = manager.startUpload("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  describe("completeUpload", () => {
    it("设置 workspacePath 并将状态置为 uploaded", () => {
      const record = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 100,
      });
      manager.completeDownload(record.id, "/tmp/a.txt");
      manager.startUpload(record.id);

      const updated = manager.completeUpload(record.id, "downloads/a.txt");
      expect(updated).not.toBeNull();
      expect(updated?.workspacePath).toBe("downloads/a.txt");
      expect(updated?.state).toBe("uploaded");
      expect(updated?.uploadedAt).not.toBeNull();
      expect(updated?.uploadedAt).toBeGreaterThan(0);
    });

    it("不存在的 id 返回 null", () => {
      const result = manager.completeUpload("nonexistent-id", "downloads/x.txt");
      expect(result).toBeNull();
    });
  });

  describe("failUpload", () => {
    it("设置 error 并将状态置为 upload_failed", () => {
      const record = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 100,
      });
      manager.completeDownload(record.id, "/tmp/a.txt");
      manager.startUpload(record.id);

      const updated = manager.failUpload(record.id, "Server 拒绝上传");
      expect(updated).not.toBeNull();
      expect(updated?.error).toBe("Server 拒绝上传");
      expect(updated?.state).toBe("upload_failed");
    });

    it("不存在的 id 返回 null", () => {
      const result = manager.failUpload("nonexistent-id", "err");
      expect(result).toBeNull();
    });
  });

  describe("getDownload", () => {
    it("获取单个下载记录", () => {
      const record = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 100,
      });

      const fetched = manager.getDownload(record.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(record.id);
    });

    it("不存在的 id 返回 null", () => {
      expect(manager.getDownload("nonexistent")).toBeNull();
    });
  });

  describe("listDownloads", () => {
    it("按 threadId 过滤", () => {
      manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 10,
      });
      manager.createDownload({
        threadId: "t2",
        tabId: "tab2",
        fileName: "b.txt",
        url: "https://b.com/b.txt",
        mimeType: "text/plain",
        totalBytes: 20,
      });
      manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "c.txt",
        url: "https://c.com/c.txt",
        mimeType: "text/plain",
        totalBytes: 30,
      });

      const t1Downloads = manager.listDownloads("t1");
      const t2Downloads = manager.listDownloads("t2");

      expect(t1Downloads).toHaveLength(2);
      expect(t2Downloads).toHaveLength(1);
      expect(t2Downloads[0]?.fileName).toBe("b.txt");
    });

    it("按 createdAt 降序（最新在前）", async () => {
      const r1 = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "first.txt",
        url: "https://a.com/first.txt",
        mimeType: "text/plain",
        totalBytes: 10,
      });
      // 确保时间戳递增
      await new Promise((resolve) => setTimeout(resolve, 5));
      const r2 = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "second.txt",
        url: "https://b.com/second.txt",
        mimeType: "text/plain",
        totalBytes: 20,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const r3 = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "third.txt",
        url: "https://c.com/third.txt",
        mimeType: "text/plain",
        totalBytes: 30,
      });

      const downloads = manager.listDownloads("t1");
      expect(downloads).toHaveLength(3);
      expect(downloads[0]?.id).toBe(r3.id);
      expect(downloads[1]?.id).toBe(r2.id);
      expect(downloads[2]?.id).toBe(r1.id);
    });

    it("无记录返回空数组", () => {
      const downloads = manager.listDownloads("nonexistent-thread");
      expect(downloads).toEqual([]);
    });
  });

  describe("clearThread", () => {
    it("清理指定 thread 的所有记录", () => {
      manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 10,
      });
      manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "b.txt",
        url: "https://b.com/b.txt",
        mimeType: "text/plain",
        totalBytes: 20,
      });
      manager.createDownload({
        threadId: "t2",
        tabId: "tab2",
        fileName: "c.txt",
        url: "https://c.com/c.txt",
        mimeType: "text/plain",
        totalBytes: 30,
      });

      const cleared = manager.clearThread("t1");
      expect(cleared).toBe(2);
      expect(manager.listDownloads("t1")).toEqual([]);
      // t2 不受影响
      expect(manager.listDownloads("t2")).toHaveLength(1);
    });

    it("清理不存在的 thread 返回 0", () => {
      const cleared = manager.clearThread("nonexistent");
      expect(cleared).toBe(0);
    });
  });

  describe("状态流转约束", () => {
    it("failUpload 不抹除已上传的 savedPath", () => {
      const record = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 100,
      });
      manager.completeDownload(record.id, "/tmp/snowharness/a.txt");
      manager.startUpload(record.id);
      const failed = manager.failUpload(record.id, "Server 5xx");
      expect(failed?.savedPath).toBe("/tmp/snowharness/a.txt");
      expect(failed?.state).toBe("upload_failed");
    });

    it("completeUpload 不抹除 savedPath", () => {
      const record = manager.createDownload({
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 100,
      });
      manager.completeDownload(record.id, "/tmp/snowharness/a.txt");
      manager.startUpload(record.id);
      const uploaded = manager.completeUpload(record.id, "downloads/a.txt");
      expect(uploaded?.savedPath).toBe("/tmp/snowharness/a.txt");
      expect(uploaded?.workspacePath).toBe("downloads/a.txt");
    });
  });

  describe("DownloadState 类型覆盖", () => {
    it("所有状态可赋值给 DownloadState", () => {
      const states: DownloadState[] = [
        "pending",
        "downloading",
        "completed",
        "failed",
        "cancelled",
        "uploading",
        "uploaded",
        "upload_failed",
      ];
      expect(states).toHaveLength(8);
      expect(new Set(states).size).toBe(8);
    });

    it("DownloadRecord 字段类型完整", () => {
      const record: DownloadRecord = {
        id: "x",
        threadId: "t1",
        tabId: "tab1",
        fileName: "a.txt",
        url: "https://a.com/a.txt",
        mimeType: "text/plain",
        totalBytes: 100,
        receivedBytes: 0,
        state: "pending",
        savedPath: null,
        workspacePath: null,
        error: null,
        createdAt: Date.now(),
        completedAt: null,
        uploadedAt: null,
      };
      expect(record.state).toBe("pending");
    });
  });
});
