import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V5-B1：前台 workspace 文件内容 API（catch-all path）守卫与隔离。
 *
 * 重点测试：
 * - owner + workspace.read → 200 + { path, content, stat }
 * - 文件不存在 → 404
 * - 内部目录下的路径 → 404（不暴露存在性，防枚举）
 * - 非 owner → 404（先于 workspace 权限判定）
 * - 越界 / symlink → 400 invalid_path
 */

const studio = vi.hoisted(() => ({
  resolveStudioPrincipal: vi.fn(),
  hasStudioAction: vi.fn(),
}));
const resolver = vi.hoisted(() => ({ authErrorResponse: vi.fn() }));
const queries = vi.hoisted(() => ({ requireThreadForUser: vi.fn() }));
const ws = vi.hoisted(() => {
  class FakeWorkspacePathError extends Error {}
  class FakeRevisionConflict extends Error {
    constructor(
      public currentRevision: string,
      public currentContent: string,
    ) {
      super("conflict");
    }
  }
  return {
    WorkspacePathError: FakeWorkspacePathError,
    WorkspaceRevisionConflict: FakeRevisionConflict,
    contentTypeForPath: vi.fn(),
    isInternalPath: vi.fn(),
    readWorkspaceFile: vi.fn(),
    readWorkspaceFileBytes: vi.fn(),
    workspaceStat: vi.fn(),
    writeWorkspaceFileWithRevision: vi.fn(),
  };
});

vi.mock("@/lib/identity/studio-access", () => ({
  resolveStudioPrincipal: studio.resolveStudioPrincipal,
  hasStudioAction: studio.hasStudioAction,
}));
vi.mock("@/lib/identity/resolver", () => ({
  authErrorResponse: resolver.authErrorResponse,
}));
vi.mock("@/lib/db/queries", () => ({ requireThreadForUser: queries.requireThreadForUser }));
vi.mock("@/lib/workspace", () => ({
  WorkspacePathError: ws.WorkspacePathError,
  WorkspaceRevisionConflict: ws.WorkspaceRevisionConflict,
  contentTypeForPath: ws.contentTypeForPath,
  isInternalPath: ws.isInternalPath,
  readWorkspaceFile: ws.readWorkspaceFile,
  readWorkspaceFileBytes: ws.readWorkspaceFileBytes,
  workspaceStat: ws.workspaceStat,
  writeWorkspaceFileWithRevision: ws.writeWorkspaceFileWithRevision,
}));

import { GET, PUT } from "@/app/api/threads/[id]/workspace/[...path]/route";
import { NextRequest } from "next/server";

/** requireThreadWorkspaceRead/Write 内部 resolveStudioPrincipal 返回的 principal。 */
const PRINCIPAL = {
  id: "u1",
  email: "a@x",
  name: "A",
  externalId: "u1",
  createdAt: new Date(),
  userIdentityId: "u1",
  tenantId: "t1",
};

type NextInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

function req(url: string, init?: NextInit) {
  return new NextRequest(url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  studio.resolveStudioPrincipal.mockResolvedValue(PRINCIPAL);
  resolver.authErrorResponse.mockReturnValue(null);
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  studio.hasStudioAction.mockResolvedValue(true);
  // 默认非内部路径；具体用例可覆盖
  ws.isInternalPath.mockReturnValue(false);
  // raw 模式默认返回 image/png；具体用例可覆盖
  ws.contentTypeForPath.mockReturnValue("image/png");
});

describe("GET /api/threads/[id]/workspace/[...path] (V5-B1 前台)", () => {
  it("owner + workspace.read → 200 + { path, content, stat }", async () => {
    ws.readWorkspaceFile.mockResolvedValue("# README\nhello");
    ws.workspaceStat.mockResolvedValue({
      size: 12,
      mtime: new Date("2026-06-30"),
      isDirectory: false,
    });
    const res = await GET(req("http://localhost/api/threads/t1/workspace/README.md"), {
      params: Promise.resolve({ id: "t1", path: ["README.md"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.path).toBe("README.md");
    expect(body.data.content).toBe("# README\nhello");
    expect(body.data.stat.size).toBe(12);
    expect(ws.readWorkspaceFile).toHaveBeenCalledWith("t1", "README.md");
  });

  it("多层路径 → path 用 / 拼接", async () => {
    ws.readWorkspaceFile.mockResolvedValue("app code");
    ws.workspaceStat.mockResolvedValue({ size: 8, mtime: new Date(), isDirectory: false });
    await GET(req("http://localhost/api/threads/t1/workspace/src/app.js"), {
      params: Promise.resolve({ id: "t1", path: ["src", "app.js"] }),
    });
    expect(ws.readWorkspaceFile).toHaveBeenCalledWith("t1", "src/app.js");
  });

  it("文件不存在 → 404 file_not_found", async () => {
    ws.workspaceStat.mockResolvedValue(null);
    const res = await GET(req("http://localhost/api/threads/t1/workspace/missing.txt"), {
      params: Promise.resolve({ id: "t1", path: ["missing.txt"] }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("file_not_found");
    expect(ws.workspaceStat).toHaveBeenCalledWith("t1", "missing.txt");
    expect(ws.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("内部目录下的路径 → 404（不暴露存在性）", async () => {
    ws.isInternalPath.mockReturnValue(true);
    const res = await GET(req("http://localhost/api/threads/t1/workspace/.snow/secret.log"), {
      params: Promise.resolve({ id: "t1", path: [".snow", "secret.log"] }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("file_not_found");
    // 内部路径早退，不读文件、不调 stat
    expect(ws.readWorkspaceFile).not.toHaveBeenCalled();
    expect(ws.workspaceStat).not.toHaveBeenCalled();
  });

  it("node_modules 下的路径也视为内部目录 → 404", async () => {
    ws.isInternalPath.mockReturnValue(true);
    const res = await GET(
      req("http://localhost/api/threads/t1/workspace/node_modules/react/index.js"),
      {
        params: Promise.resolve({ id: "t1", path: ["node_modules", "react", "index.js"] }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("非 owner → 404，先于 workspace 权限判定（不泄露）", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/api/threads/tOther/workspace/README.md"), {
      params: Promise.resolve({ id: "tOther", path: ["README.md"] }),
    });
    expect(res.status).toBe(404);
    expect(studio.hasStudioAction).not.toHaveBeenCalled();
    expect(ws.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("无 workspace.read → 403", async () => {
    studio.hasStudioAction.mockResolvedValue(false);
    const res = await GET(req("http://localhost/api/threads/t1/workspace/README.md"), {
      params: Promise.resolve({ id: "t1", path: ["README.md"] }),
    });
    expect(res.status).toBe(403);
    expect(ws.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("readWorkspaceFile 路径安全错误（越界 / symlink）→ 400 invalid_path", async () => {
    ws.workspaceStat.mockResolvedValue({ size: 1, mtime: new Date(), isDirectory: false });
    ws.readWorkspaceFile.mockRejectedValue(new ws.WorkspacePathError("非法路径（越界工作区）"));
    const res = await GET(req("http://localhost/api/threads/t1/workspace/..%2Fescape.txt"), {
      params: Promise.resolve({ id: "t1", path: ["..", "escape.txt"] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_path");
  });

  it("普通 workspace 异常不应伪装成 invalid_path", async () => {
    ws.workspaceStat.mockResolvedValue({ size: 1, mtime: new Date(), isDirectory: false });
    ws.readWorkspaceFile.mockRejectedValue(new Error("disk full"));
    await expect(
      GET(req("http://localhost/api/threads/t1/workspace/README.md"), {
        params: Promise.resolve({ id: "t1", path: ["README.md"] }),
      }),
    ).rejects.toThrow("disk full");
  });
});

describe("GET /api/threads/[id]/workspace/[...path]?raw=1 (V5-B2 raw mode)", () => {
  it("raw=1 + owner → 200 + Content-Type + 原始字节，不调文本读取", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    ws.workspaceStat.mockResolvedValue({
      size: bytes.byteLength,
      mtime: new Date(),
      isDirectory: false,
    });
    ws.readWorkspaceFileBytes.mockResolvedValue(bytes);
    ws.contentTypeForPath.mockReturnValue("image/png");
    const res = await GET(req("http://localhost/api/threads/t1/workspace/logo.png?raw=1"), {
      params: Promise.resolve({ id: "t1", path: ["logo.png"] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // 字节流应被原样回写（Buffer/Uint8Array 都可作为 BodyInit）
    const buf = await res.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(bytes);
    expect(ws.readWorkspaceFile).not.toHaveBeenCalled();
    expect(ws.workspaceStat).toHaveBeenCalledWith("t1", "logo.png");
    expect(ws.readWorkspaceFileBytes).toHaveBeenCalledWith("t1", "logo.png");
    expect(ws.contentTypeForPath).toHaveBeenCalledWith("logo.png");
  });

  it("raw=1 文件不存在 → 404 file_not_found（不调 contentTypeForPath）", async () => {
    ws.readWorkspaceFileBytes.mockResolvedValue(null);
    const res = await GET(req("http://localhost/api/threads/t1/workspace/missing.png?raw=1"), {
      params: Promise.resolve({ id: "t1", path: ["missing.png"] }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("file_not_found");
    expect(ws.contentTypeForPath).not.toHaveBeenCalled();
  });

  it("raw=1 内部目录路径 → 404（不调 readWorkspaceFileBytes，防枚举）", async () => {
    ws.isInternalPath.mockReturnValue(true);
    const res = await GET(req("http://localhost/api/threads/t1/workspace/.snow/secret.log?raw=1"), {
      params: Promise.resolve({ id: "t1", path: [".snow", "secret.log"] }),
    });
    expect(res.status).toBe(404);
    expect(ws.readWorkspaceFileBytes).not.toHaveBeenCalled();
    expect(ws.contentTypeForPath).not.toHaveBeenCalled();
  });

  it("raw=1 非 owner → 404，先于 raw 读取（不泄露）", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(req("http://localhost/api/threads/tOther/workspace/logo.png?raw=1"), {
      params: Promise.resolve({ id: "tOther", path: ["logo.png"] }),
    });
    expect(res.status).toBe(404);
    expect(ws.readWorkspaceFileBytes).not.toHaveBeenCalled();
  });

  it("raw=1 越界路径 → 400 invalid_path", async () => {
    ws.readWorkspaceFileBytes.mockRejectedValue(
      new ws.WorkspacePathError("非法路径（越界工作区）"),
    );
    const res = await GET(req("http://localhost/api/threads/t1/workspace/..%2Fescape?raw=1"), {
      params: Promise.resolve({ id: "t1", path: ["..", "escape"] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_path");
  });

  it("raw=1 多层路径 + svg → Content-Type=image/svg+xml", async () => {
    const svg = "<svg></svg>";
    ws.readWorkspaceFileBytes.mockResolvedValue(new TextEncoder().encode(svg));
    ws.contentTypeForPath.mockReturnValue("image/svg+xml");
    const res = await GET(req("http://localhost/api/threads/t1/workspace/assets/logo.svg?raw=1"), {
      params: Promise.resolve({ id: "t1", path: ["assets", "logo.svg"] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(ws.readWorkspaceFileBytes).toHaveBeenCalledWith("t1", "assets/logo.svg");
    expect(ws.contentTypeForPath).toHaveBeenCalledWith("assets/logo.svg");
  });

  it("raw=0 / 缺省 raw 参数 → 不走 raw 分支，走 JSON 信封", async () => {
    ws.readWorkspaceFile.mockResolvedValue("# README");
    ws.workspaceStat.mockResolvedValue({ size: 8, mtime: new Date(), isDirectory: false });
    const res = await GET(req("http://localhost/api/threads/t1/workspace/README.md"), {
      params: Promise.resolve({ id: "t1", path: ["README.md"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toBe("# README");
    expect(ws.readWorkspaceFileBytes).not.toHaveBeenCalled();
  });

  it("iframe 子资源请求（Sec-Fetch-Dest: style）→ 自动走 raw 分支，支持 HTML 相对 CSS", async () => {
    const css = "body{color:red}";
    ws.readWorkspaceFileBytes.mockResolvedValue(new TextEncoder().encode(css));
    ws.contentTypeForPath.mockReturnValue("text/css; charset=utf-8");
    const res = await GET(
      req("http://localhost/api/threads/t1/workspace/styles.css", {
        headers: { "sec-fetch-dest": "style" },
      }),
      {
        params: Promise.resolve({ id: "t1", path: ["styles.css"] }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await res.text()).toBe(css);
    expect(ws.readWorkspaceFileBytes).toHaveBeenCalledWith("t1", "styles.css");
    expect(ws.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("raw=1 普通异常（非 WorkspacePathError）应抛出而非伪装成 invalid_path", async () => {
    ws.readWorkspaceFileBytes.mockRejectedValue(new Error("io error"));
    await expect(
      GET(req("http://localhost/api/threads/t1/workspace/logo.png?raw=1"), {
        params: Promise.resolve({ id: "t1", path: ["logo.png"] }),
      }),
    ).rejects.toThrow("io error");
  });
});

describe("PUT /api/threads/[id]/workspace/[...path] (V9 阶段 4)", () => {
  function putReq(url: string, body: unknown) {
    return req(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("owner + workspace.write + revision 匹配 → 200 + stat", async () => {
    ws.writeWorkspaceFileWithRevision.mockResolvedValue({
      size: 11,
      mtime: new Date("2026-07-09"),
      isDirectory: false,
      revision: "11:1783569464",
    });
    const res = await PUT(
      putReq("http://localhost/api/threads/t1/workspace/src/app.js", {
        content: "new content",
        revision: "8:1783569400",
      }),
      { params: Promise.resolve({ id: "t1", path: ["src", "app.js"] }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.path).toBe("src/app.js");
    expect(body.data.stat.revision).toBe("11:1783569464");
    expect(ws.writeWorkspaceFileWithRevision).toHaveBeenCalledWith(
      "t1",
      "src/app.js",
      "new content",
      "8:1783569400",
    );
  });

  it("revision 不匹配 → 409 + 当前内容（供前端 diff/merge）", async () => {
    ws.writeWorkspaceFileWithRevision.mockRejectedValue(
      new ws.WorkspaceRevisionConflict("11:1783569464", "AI changed content"),
    );
    const res = await PUT(
      putReq("http://localhost/api/threads/t1/workspace/src/app.js", {
        content: "user edit",
        revision: "8:1783569400",
      }),
      { params: Promise.resolve({ id: "t1", path: ["src", "app.js"] }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("revision_conflict");
    expect(body.error.currentRevision).toBe("11:1783569464");
    expect(body.error.currentContent).toBe("AI changed content");
  });

  it("非 owner → 404，先于写入（不泄露）", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await PUT(
      putReq("http://localhost/api/threads/tOther/workspace/README.md", { content: "x" }),
      { params: Promise.resolve({ id: "tOther", path: ["README.md"] }) },
    );
    expect(res.status).toBe(404);
    expect(ws.writeWorkspaceFileWithRevision).not.toHaveBeenCalled();
  });

  it("无 workspace.write → 403", async () => {
    studio.hasStudioAction.mockResolvedValue(false);
    const res = await PUT(
      putReq("http://localhost/api/threads/t1/workspace/README.md", { content: "x" }),
      { params: Promise.resolve({ id: "t1", path: ["README.md"] }) },
    );
    expect(res.status).toBe(403);
    expect(ws.writeWorkspaceFileWithRevision).not.toHaveBeenCalled();
  });

  it("内部目录路径 → 404（不暴露存在性）", async () => {
    ws.isInternalPath.mockReturnValue(true);
    const res = await PUT(
      putReq("http://localhost/api/threads/t1/workspace/.snow/secret.log", { content: "x" }),
      { params: Promise.resolve({ id: "t1", path: [".snow", "secret.log"] }) },
    );
    expect(res.status).toBe(404);
    expect(ws.writeWorkspaceFileWithRevision).not.toHaveBeenCalled();
  });

  it("content 非字符串 → 400 invalid_body", async () => {
    const res = await PUT(
      putReq("http://localhost/api/threads/t1/workspace/README.md", { content: 123 }),
      { params: Promise.resolve({ id: "t1", path: ["README.md"] }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_body");
  });

  it("越界路径 → 400 invalid_path", async () => {
    ws.writeWorkspaceFileWithRevision.mockRejectedValue(new ws.WorkspacePathError("非法路径"));
    const res = await PUT(
      putReq("http://localhost/api/threads/t1/workspace/..%2Fescape", { content: "x" }),
      { params: Promise.resolve({ id: "t1", path: ["..", "escape"] }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_path");
  });
});
