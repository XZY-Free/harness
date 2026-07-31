import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 05-P2-8：StaticPreviewRuntime 鉴权测试。
 *
 * createStaticServer 校验 ?token= 或 X-Preview-Token 头匹配，不符返回 403。
 * 本测试启动真实 http.Server（经 StaticPreviewRuntime.start），用 http 客户端发请求验证：
 * - 无 token → 403
 * - 错误 token → 403
 * - 正确 token（query 或 X-Preview-Token header）→ 200
 * mock workspace.readWorkspaceFile 返回固定内容，避免依赖真实文件系统。
 */

const ws = vi.hoisted(() => ({
  readWorkspaceFile: vi.fn(),
  safeJoin: vi.fn((threadId: string, rel: string) => `/tmp/ws-${threadId}/${rel}`),
  workspaceRoot: vi.fn((id: string) => `/tmp/ws-${id}`),
}));

vi.mock("@/lib/workspace", () => ws);

// mock 掉 DevServerPreviewRuntime 的依赖（preview-runtime.ts 顶部 import 全模块）
vi.mock("@/lib/runtime/container/docker-cli", () => ({ execDetached: vi.fn() }));
vi.mock("@/lib/runtime/container/manager", () => ({
  startContainer: vi.fn(),
  stopContainerById: vi.fn(),
}));
vi.mock("@/lib/runtime/container/start-options", () => ({
  prepareContainerStartOptions: vi.fn(),
}));
vi.mock("@/lib/runtime/preview-probe", () => ({ probePreviewUrl: vi.fn() }));
vi.mock("@/lib/runtime/background-task-registry", () => ({
  stopAllByThread: vi.fn().mockResolvedValue(undefined),
}));

import { get } from "node:http";
import { closeAllPreviews, staticPreviewRuntime } from "@/lib/runtime/preview-runtime";

const TID = "thread-static-auth";

function httpRequest(
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ hostname: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
  });
}

/** V9 阶段 5：带响应头返回的请求变体（用于断言 Set-Cookie）。 */
function httpRequestFull(
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const req = get({ hostname: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    req.on("error", reject);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  closeAllPreviews();
  // 默认 readWorkspaceFile 返回 HTML 内容（鉴权通过后走到这里）
  ws.readWorkspaceFile.mockResolvedValue(Buffer.from("<h1>preview</h1>"));
});

afterEach(() => {
  closeAllPreviews();
});

describe("StaticPreviewRuntime 鉴权（05-P2-8）", () => {
  it("start 返回的 token 用于后续请求鉴权", async () => {
    const handle = await staticPreviewRuntime.start(TID);
    expect(handle.token).toBeTruthy();
    expect(typeof handle.token).toBe("string");
    expect(handle.port).toBeGreaterThan(0);
  });

  it("无 token → 403 Forbidden", async () => {
    const handle = await staticPreviewRuntime.start(TID);
    const r = await httpRequest(handle.port, "/");
    expect(r.status).toBe(403);
    expect(r.body).toBe("Forbidden");
  });

  it("错误 token（query）→ 403 Forbidden", async () => {
    const handle = await staticPreviewRuntime.start(TID);
    const r = await httpRequest(handle.port, "/?token=wrong-token");
    expect(r.status).toBe(403);
    expect(r.body).toBe("Forbidden");
  });

  it("错误 token（X-Preview-Token header）→ 403 Forbidden", async () => {
    const handle = await staticPreviewRuntime.start(TID);
    const r = await httpRequest(handle.port, "/", { "x-preview-token": "wrong-token" });
    expect(r.status).toBe(403);
  });

  it("正确 token（query ?token=）→ 200 + 文件内容", async () => {
    const handle = await staticPreviewRuntime.start(TID);
    const r = await httpRequest(handle.port, `/?token=${handle.token}`);
    expect(r.status).toBe(200);
    expect(r.body).toBe("<h1>preview</h1>");
  });

  it("正确 token（X-Preview-Token header）→ 200 + 文件内容", async () => {
    const handle = await staticPreviewRuntime.start(TID);
    const r = await httpRequest(handle.port, "/", {
      "x-preview-token": handle.token ?? "",
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe("<h1>preview</h1>");
  });

  it("正确 token 但文件不存在 → 404（鉴权通过，走文件查找）", async () => {
    ws.readWorkspaceFile.mockResolvedValueOnce(null);
    const handle = await staticPreviewRuntime.start(TID);
    const r = await httpRequest(handle.port, `/?token=${handle.token}`);
    expect(r.status).toBe(404);
  });

  it("safeJoin 抛错（路径越界）→ 403（即使 token 正确）", async () => {
    ws.safeJoin.mockImplementationOnce(() => {
      throw new Error("path escape");
    });
    const handle = await staticPreviewRuntime.start(TID);
    const r = await httpRequest(handle.port, `/?token=${handle.token}`);
    expect(r.status).toBe(403);
  });
});

describe("StaticPreviewRuntime cookie 鉴权（V9 阶段 5）", () => {
  it("token 经 query 传入 → 200 + Set-Cookie preview-token", async () => {
    const handle = await staticPreviewRuntime.start(TID);
    const r = await httpRequestFull(handle.port, `/?token=${handle.token}`);
    expect(r.status).toBe(200);
    const setCookie = r.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr).toContain(`preview-token=${handle.token}`);
    expect(cookieStr).toContain("HttpOnly");
    expect(cookieStr).toContain("Path=/");
  });

  it("token 经 header 传入 → 200 但不 Set-Cookie（仅 query 触发）", async () => {
    const handle = await staticPreviewRuntime.start(TID);
    const r = await httpRequestFull(handle.port, "/", {
      "x-preview-token": handle.token ?? "",
    });
    expect(r.status).toBe(200);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("子资源带 cookie（无 query/header token）→ 200（cookie 鉴权）", async () => {
    const handle = await staticPreviewRuntime.start(TID);
    // 首次 query 触发 Set-Cookie
    const first = await httpRequestFull(handle.port, `/?token=${handle.token}`);
    expect(first.status).toBe(200);
    // 模拟浏览器存下 cookie 后，子资源请求只带 cookie
    const r = await httpRequest(handle.port, "/style.css", {
      cookie: `preview-token=${handle.token}`,
    });
    expect(r.status).toBe(200);
  });

  it("错误 cookie → 403", async () => {
    const handle = await staticPreviewRuntime.start(TID);
    const r = await httpRequest(handle.port, "/", { cookie: "preview-token=wrong" });
    expect(r.status).toBe(403);
  });

  it("已带正确 cookie 时即使 query 也带 token → 不重复 Set-Cookie", async () => {
    const handle = await staticPreviewRuntime.start(TID);
    const r = await httpRequestFull(handle.port, `/?token=${handle.token}`, {
      cookie: `preview-token=${handle.token}`,
    });
    expect(r.status).toBe(200);
    // cookie 已存在 → 不再 Set-Cookie
    expect(r.headers["set-cookie"]).toBeUndefined();
  });
});
