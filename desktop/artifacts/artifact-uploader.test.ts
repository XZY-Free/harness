import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ArtifactUploadConfig, uploadArtifact } from "./artifact-uploader";

/**
 * V10 Phase 7-3：Artifact 上传器单元测试。
 *
 * 验证：
 * - 文件不存在 / 非文件 → 失败
 * - HTTP 请求构造（URL、headers、method）
 * - 响应解析（成功返回 workspacePath + size）
 * - 网络异常 → 失败
 * - HTTP 非 2xx → 失败
 * - 响应 JSON 缺少字段 → 失败
 */

// 保存原始 fetch
const originalFetch = globalThis.fetch;

/** 创建会消费 body stream 的 mock fetch */
function createFetchMock(response: Response | Error): typeof globalThis.fetch {
  return vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
    // 消费 body stream（createReadStream），防止异步打开文件导致 ENOENT
    const body = options.body as NodeJS.ReadableStream | null;
    if (body && typeof body === "object" && typeof body.on === "function") {
      // 附加 error handler 防止 uncaught exception
      body.on("error", () => {});
      // 触发数据读取（消费流）
      body.on("data", () => {});
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }) as unknown as typeof globalThis.fetch;
}

describe("uploadArtifact", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "snowharness-artifact-test-"));

  afterAll(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** 创建测试用临时文件 */
  function createTempFile(name: string, content: string): string {
    const filePath = join(tempDir, name);
    writeFileSync(filePath, content, { mode: 0o600 });
    return filePath;
  }

  /** 构造成功的 Response */
  function makeOkResponse(workspacePath: string, size: number): Response {
    return new Response(JSON.stringify({ ok: true, data: { workspacePath, size } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  /** 构造失败的 Response */
  function makeErrorResponse(status: number, statusText: string): Response {
    return new Response(
      JSON.stringify({ ok: false, error: { code: "test_error", message: statusText } }),
      { status, statusText },
    );
  }

  it("成功上传返回 workspacePath 和 size", async () => {
    const filePath = createTempFile("screenshot.png", "fake-png-data");
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    globalThis.fetch = createFetchMock(makeOkResponse("artifacts/screenshot.png", 14));

    const result = await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath,
      fileName: "screenshot-thread-1-tab-1-1234.png",
    });

    expect(result.ok).toBe(true);
    expect(result.workspacePath).toBe("artifacts/screenshot.png");
    expect(result.size).toBe(14);
  });

  it("构造正确的 URL", async () => {
    const filePath = createTempFile("dom.json", "{}");
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    const mockFetch = createFetchMock(makeOkResponse("artifacts/dom.json", 2));
    globalThis.fetch = mockFetch;

    await uploadArtifact({
      config,
      threadId: "thread-abc",
      filePath,
      fileName: "dom.json",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("http://localhost:3000/api/threads/thread-abc/workspace/artifact");
  });

  it("构造正确的 headers（含 X-File-Name URL encode）", async () => {
    const filePath = createTempFile("headers-test.txt", "data");
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    const mockFetch = createFetchMock(makeOkResponse("artifacts/test.txt", 4));
    globalThis.fetch = mockFetch;

    await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath,
      fileName: "screenshot-测试.png",
    });

    const call = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const options = call[1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["x-file-name"]).toBe(encodeURIComponent("screenshot-测试.png"));
  });

  it("设置 Authorization 头（当提供 authToken）", async () => {
    const filePath = createTempFile("auth-test.txt", "data");
    const config: ArtifactUploadConfig = {
      serverOrigin: "http://localhost:3000",
      authToken: "test-token-123",
    };
    const mockFetch = createFetchMock(makeOkResponse("artifacts/test.txt", 4));
    globalThis.fetch = mockFetch;

    await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath,
      fileName: "test.txt",
    });

    const call = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const options = call[1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token-123");
  });

  it("不设置 Authorization 头（当未提供 authToken）", async () => {
    const filePath = createTempFile("noauth-test.txt", "data");
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    const mockFetch = createFetchMock(makeOkResponse("artifacts/test.txt", 4));
    globalThis.fetch = mockFetch;

    await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath,
      fileName: "test.txt",
    });

    const call = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const options = call[1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("使用 POST 方法", async () => {
    const filePath = createTempFile("method-test.txt", "data");
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    const mockFetch = createFetchMock(makeOkResponse("artifacts/test.txt", 4));
    globalThis.fetch = mockFetch;

    await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath,
      fileName: "test.txt",
    });

    const call = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const options = call[1] as RequestInit;
    expect(options.method).toBe("POST");
  });

  it("文件不存在返回失败", async () => {
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    const mockFetch = createFetchMock(makeOkResponse("artifacts/file.png", 0));
    globalThis.fetch = mockFetch;

    const result = await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath: "/nonexistent/path/file.png",
      fileName: "file.png",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("无法读取文件");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("路径是目录返回失败", async () => {
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    const mockFetch = createFetchMock(makeOkResponse("artifacts/dir.png", 0));
    globalThis.fetch = mockFetch;

    const result = await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath: tempDir,
      fileName: "dir.png",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("路径不是文件");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("HTTP 非 2xx 返回失败", async () => {
    const filePath = createTempFile("error-test.txt", "data");
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    globalThis.fetch = createFetchMock(makeErrorResponse(403, "Forbidden"));

    const result = await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath,
      fileName: "test.txt",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 403");
    expect(result.error).toContain("Forbidden");
  });

  it("网络异常返回失败", async () => {
    const filePath = createTempFile("network-test.txt", "data");
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    globalThis.fetch = createFetchMock(new Error("ECONNREFUSED"));

    const result = await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath,
      fileName: "test.txt",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("上传请求失败");
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("响应缺少 data 字段返回失败", async () => {
    const filePath = createTempFile("nodata-test.txt", "data");
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    globalThis.fetch = createFetchMock(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath,
      fileName: "test.txt",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("data");
  });

  it("响应缺少 workspacePath 字段返回失败", async () => {
    const filePath = createTempFile("nopath-test.txt", "data");
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    globalThis.fetch = createFetchMock(
      new Response(JSON.stringify({ ok: true, data: { size: 4 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath,
      fileName: "test.txt",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("workspacePath");
  });

  it("响应 JSON 解析失败返回错误", async () => {
    const filePath = createTempFile("jsonfail-test.txt", "data");
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    globalThis.fetch = createFetchMock(
      new Response("not valid json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath,
      fileName: "test.txt",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("响应解析失败");
  });

  it("响应缺少 size 时使用本机文件大小", async () => {
    const filePath = createTempFile("nosize-test.txt", "12345678");
    const config: ArtifactUploadConfig = { serverOrigin: "http://localhost:3000" };
    globalThis.fetch = createFetchMock(
      new Response(JSON.stringify({ ok: true, data: { workspacePath: "artifacts/test.txt" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await uploadArtifact({
      config,
      threadId: "thread-1",
      filePath,
      fileName: "test.txt",
    });

    expect(result.ok).toBe(true);
    expect(result.size).toBe(8);
  });
});
