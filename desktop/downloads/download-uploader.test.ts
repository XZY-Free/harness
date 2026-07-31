import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadFileToWorkspace } from "./download-uploader";

/**
 * V10 Phase 7-1：download-uploader 单元测试。
 *
 * 验证：
 * - 成功上传返回 { ok: true, workspacePath }
 * - 失败返回 { ok: false, error }
 * - 进度回调被调用（uploadedBytes 单调递增，totalBytes 等于文件大小）
 * - 使用 application/octet-stream + X-File-Name 头
 * - body 是 ReadStream
 *
 * 不真实发起 HTTP，使用 vi.fn() mock 全局 fetch。
 */

// 保存原始 fetch 引用，便于 afterEach 恢复
const originalFetch = globalThis.fetch;

const TEST_TMP_DIR = resolve(tmpdir(), "snowharness-uploader-test");

beforeEach(async () => {
  await rm(TEST_TMP_DIR, { recursive: true, force: true });
  await mkdir(TEST_TMP_DIR, { recursive: true });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(TEST_TMP_DIR, { recursive: true, force: true });
});

/** 创建测试用本机文件，返回路径。 */
async function createTestFile(name: string, content: string): Promise<string> {
  const filePath = join(TEST_TMP_DIR, name);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

describe("uploadFileToWorkspace", () => {
  it("成功上传返回 ok + workspacePath", async () => {
    const filePath = await createTestFile("report.pdf", "PDF-CONTENT");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, data: { workspacePath: "downloads/report.pdf", size: 12 } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await uploadFileToWorkspace({
      config: { serverOrigin: "http://localhost:3000", authToken: "token-abc" },
      threadId: "thread-1",
      filePath,
      fileName: "report.pdf",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspacePath).toBe("downloads/report.pdf");
    }

    // 验证 fetch 调用参数
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMock.mock.calls[0];
    const url = callArgs?.[0] as string;
    const init = callArgs?.[1] as RequestInit;
    expect(url).toBe("http://localhost:3000/api/threads/thread-1/workspace/upload");
    expect(init.method).toBe("POST");
    // Content-Type 必须为 octet-stream（直接传 stream，不让整个文件入内存）
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/octet-stream");
    // X-File-Name 头携带 URL-encoded 文件名
    expect(headers["x-file-name"]).toBe(encodeURIComponent("report.pdf"));
    // Authorization 头携带 Bearer token
    expect(headers.authorization).toBe("Bearer token-abc");
    // body 应为 stream（不是 Buffer/String）
    expect(init.body).toBeDefined();
    expect(typeof init.body).toBe("object");
  });

  it("HTTP 4xx 返回 ok=false + error", async () => {
    const filePath = await createTestFile("bad.txt", "x");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "forbidden", message: "无权限" } }), {
        status: 403,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await uploadFileToWorkspace({
      config: { serverOrigin: "http://localhost:3000" },
      threadId: "t1",
      filePath,
      fileName: "bad.txt",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
      expect(result.workspacePath).toBeNull();
    }
  });

  it("HTTP 5xx 返回 ok=false + error", async () => {
    const filePath = await createTestFile("err.txt", "y");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await uploadFileToWorkspace({
      config: { serverOrigin: "http://localhost:3000" },
      threadId: "t1",
      filePath,
      fileName: "err.txt",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("500");
    }
  });

  it("网络异常（fetch reject）返回 ok=false + error", async () => {
    const filePath = await createTestFile("net.txt", "z");
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await uploadFileToWorkspace({
      config: { serverOrigin: "http://localhost:3000" },
      threadId: "t1",
      filePath,
      fileName: "net.txt",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ECONNREFUSED");
    }
  });

  it("进度回调被调用，uploadedBytes 单调递增", async () => {
    // 写入较大文件以触发多次 'data' 事件
    const bigContent = "x".repeat(64 * 1024);
    const filePath = await createTestFile("big.bin", bigContent);
    // mock fetch：实际消费 body stream 触发 'data' 事件后再返回响应
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      // 消费 body stream（与真实 fetch 行为一致）
      const body = init.body as unknown as { on?: (event: string, cb: () => void) => void };
      if (body && typeof body.on === "function") {
        await new Promise<void>((resolve) => {
          body.on("end", () => resolve());
        });
      }
      return new Response(
        JSON.stringify({ ok: true, data: { workspacePath: "downloads/big.bin", size: 65536 } }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const progressCalls: Array<{ uploaded: number; total: number }> = [];
    const result = await uploadFileToWorkspace({
      config: { serverOrigin: "http://localhost:3000" },
      threadId: "t1",
      filePath,
      fileName: "big.bin",
      onProgress: (uploaded, total) => {
        progressCalls.push({ uploaded, total });
      },
    });

    expect(result.ok).toBe(true);
    // 进度至少被调用过一次
    expect(progressCalls.length).toBeGreaterThan(0);
    // 最后一次的 uploaded 等于 total
    const last = progressCalls[progressCalls.length - 1];
    expect(last).toBeDefined();
    expect(last?.uploaded).toBe(last?.total);
    expect(last?.total).toBe(65536);
    // uploadedBytes 单调非递减
    for (let i = 1; i < progressCalls.length; i++) {
      const prev = progressCalls[i - 1];
      const curr = progressCalls[i];
      if (prev && curr) {
        expect(curr.uploaded).toBeGreaterThanOrEqual(prev.uploaded);
      }
    }
  });

  it("不传 authToken 时不携带 Authorization 头", async () => {
    const filePath = await createTestFile("a.txt", "abc");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, data: { workspacePath: "downloads/a.txt", size: 3 } }),
        {
          status: 200,
        },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await uploadFileToWorkspace({
      config: { serverOrigin: "http://localhost:3000" },
      threadId: "t1",
      filePath,
      fileName: "a.txt",
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("成功响应但缺少 workspacePath 字段时返回 ok=false", async () => {
    const filePath = await createTestFile("a.txt", "abc");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, data: { size: 3 } }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await uploadFileToWorkspace({
      config: { serverOrigin: "http://localhost:3000" },
      threadId: "t1",
      filePath,
      fileName: "a.txt",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it("文件不存在时返回 ok=false + error", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await uploadFileToWorkspace({
      config: { serverOrigin: "http://localhost:3000" },
      threadId: "t1",
      filePath: join(TEST_TMP_DIR, "nonexistent-file.txt"),
      fileName: "x.txt",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
