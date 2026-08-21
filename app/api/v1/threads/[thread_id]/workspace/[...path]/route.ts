import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getRequestId, jsonError, jsonOk, resourceNotFound } from "@/lib/http";
import {
  WorkspacePathError,
  WorkspaceRevisionConflict,
  contentTypeForPath,
  isInternalPath,
  readWorkspaceFile,
  readWorkspaceFileBytes,
  workspaceStat,
  writeWorkspaceFileWithRevision,
} from "@/lib/workspace";
import type { NextRequest } from "next/server";

/**
 * 前台 workspace 文件内容 API（正式 v1，catch-all path）。
 *
 * GET /api/v1/threads/{thread_id}/workspace/[...path] → 读文件内容 + stat（含 revision）。
 * GET /api/v1/threads/{thread_id}/workspace/[...path]?raw=1 → 直接返回原始字节 + Content-Type，
 *   供 `<img>` / `<iframe>` / `<source>` 等直接加载。
 * PUT /api/v1/threads/{thread_id}/workspace/[...path] → 写文件内容（revision-aware）。
 *
 * 鉴权：员工身份（Employee API 不走 action scope），经 Thread.ownerUserId 鉴权；
 * GET/PUT 均 owner 即可（正式无 write 动作门禁）；不存在 / 非 owner / 已删除一律 404。
 *
 * 安全口径：
 * - safeJoin / symlink / realpath 防护仍在 lib/workspace.ts 各函数内
 * - isInternalPath：内部目录（.snow/.git/node_modules 等）下的文件一律 404，不暴露存在性
 *
 * GET 响应（默认 JSON 信封）：{ ok: true, data: { path, content, stat:{size,mtime,isDirectory,revision} } }
 *   - 404 文件不存在 / 内部目录下的路径（不区分，防枚举）
 *   - 400 invalid_path（越界 / symlink）
 *
 * PUT 请求体：{ content: string, revision?: string }
 *   - revision 提供：与当前文件 revision 不匹配 → 409 conflict（携带当前内容+revision）
 *   - revision 匹配或为空 → 原子写入，返回 { ok:true, data:{ path, stat } }
 *   - 400 invalid_path（越界 / symlink / 内部目录）
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ thread_id: string; path: string[] }> },
) {
  const { thread_id, path } = await params;
  const requestId = getRequestId(req);

  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(req.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const thread = await getThreadById(principal.tenantId, thread_id);
  if (
    !thread ||
    thread.ownerUserId !== principal.userIdentityId ||
    thread.lifecycleState === "deleted"
  ) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${thread_id}`);
  }

  const relPath = path.join("/");

  // 内部目录下的文件一律返回 404（不暴露存在性）
  if (isInternalPath(relPath)) {
    return jsonError(404, "file_not_found", "文件不存在");
  }

  const rawMode = shouldReturnRaw(req);

  // X42/X43 修复：先 stat 检查文件大小，超阈值不返回完整 content（服务端保护）
  const MAX_SERVE_SIZE = 1024 * 1024; // 1MB：与前端 MAX_EDITABLE_SIZE / MAX_PREVIEW_SIZE 一致

  try {
    if (rawMode) {
      // V5-B2：raw 模式——读字节，按扩展名映射 Content-Type，直接返回二进制响应。
      // X42 修复：raw 模式同样受 size 上限保护。
      const preStat = await workspaceStat(thread_id, relPath);
      if (preStat === null) {
        return jsonError(404, "file_not_found", "文件不存在");
      }
      if (preStat.size > MAX_SERVE_SIZE) {
        return jsonError(413, "too_large", "文件过大，请下载查看");
      }
      const bytes = await readWorkspaceFileBytes(thread_id, relPath);
      if (bytes === null) {
        return jsonError(404, "file_not_found", "文件不存在");
      }
      const contentType = contentTypeForPath(relPath);
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "content-type": contentType,
          // raw 资源默认不缓存（workspace 文件随时会被工具覆盖）。
          "cache-control": "no-store",
        },
      });
    }

    // X42/X43 修复：JSON 模式先 stat，超阈值返回 too_large 标记（不带 content）
    const stat = await workspaceStat(thread_id, relPath);
    if (stat === null) {
      return jsonError(404, "file_not_found", "文件不存在");
    }
    if (stat.size > MAX_SERVE_SIZE) {
      return jsonOk({ path: relPath, content: null, stat, too_large: true });
    }
    const content = await readWorkspaceFile(thread_id, relPath);
    if (content === null) {
      return jsonError(404, "file_not_found", "文件不存在");
    }
    return jsonOk({ path: relPath, content, stat });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return jsonError(400, "invalid_path", error.message);
    }
    throw error;
  }
}

function shouldReturnRaw(req: NextRequest): boolean {
  if (req.nextUrl.searchParams.get("raw") === "1") return true;
  const fetchDest = req.headers.get("sec-fetch-dest");
  return (
    fetchDest === "style" || fetchDest === "image" || fetchDest === "font" || fetchDest === "script"
  );
}

/**
 * 写入工作区文件（revision-aware，支持冲突检测）。
 *
 * 请求体：{ content: string, revision?: string }
 *  - revision：编辑器打开文件时拿到的当前 revision；保存时回传。
 *  - 不传 revision：无条件写入（新建文件或忽略冲突，由调用方决定）。
 *
 * 冲突处理：revision 不匹配 → 409，body 携带 { currentRevision, currentContent } 供前端展示 diff/merge，
 * 不静默覆盖用户正在编辑的内容。
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ thread_id: string; path: string[] }> },
) {
  const { thread_id, path } = await params;
  const requestId = getRequestId(req);

  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(req.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const thread = await getThreadById(principal.tenantId, thread_id);
  if (
    !thread ||
    thread.ownerUserId !== principal.userIdentityId ||
    thread.lifecycleState === "deleted"
  ) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${thread_id}`);
  }

  const relPath = path.join("/");

  // 内部目录下的文件一律拒绝写（与读一致，防枚举）
  if (isInternalPath(relPath)) {
    return jsonError(404, "file_not_found", "文件不存在");
  }

  let body: { content?: unknown; revision?: unknown };
  try {
    body = (await req.json()) as { content?: unknown; revision?: unknown };
  } catch {
    return jsonError(400, "invalid_body", "请求体不是合法 JSON");
  }
  if (typeof body.content !== "string") {
    return jsonError(400, "invalid_body", "content 必须为字符串");
  }
  const expectedRevision = typeof body.revision === "string" ? body.revision : undefined;

  try {
    const stat = await writeWorkspaceFileWithRevision(
      thread_id,
      relPath,
      body.content,
      expectedRevision,
    );
    return jsonOk({ path: relPath, stat });
  } catch (error) {
    if (error instanceof WorkspaceRevisionConflict) {
      // 409：携带当前内容与 revision，供前端 diff/merge
      return Response.json(
        {
          ok: false,
          error: {
            code: "revision_conflict",
            message: "文件已被修改，请查看差异后合并",
            currentRevision: error.currentRevision,
            currentContent: error.currentContent,
          },
        },
        { status: 409 },
      );
    }
    if (error instanceof WorkspacePathError) {
      return jsonError(400, "invalid_path", error.message);
    }
    throw error;
  }
}
