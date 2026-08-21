/**
 * Workspace 一次性下载凭证 API（正式 v1）。
 *
 * 架构背景：见 docs/solutions/v10-macos-desktop-web-preview/02-desktop-browser-architecture.md
 * L186-190：AI 只能上传 Thread Workspace 中的文件，由 Server 签发一次性下载凭证，
 * Desktop 下载到临时目录后交给 WebContents。AI 不能指定本机任意路径。
 *
 * 流程：
 * - AI 调用 browserUploadFile 工具传入 workspacePath
 * - Server 的 browser-rpc-client.ts 调用 issueUploadToken(threadId, workspacePath)
 *   签发一次性凭证，构造 downloadUrl 放入 RPC payload
 * - Desktop 收到 RPC 后通过 HTTP GET ${downloadUrl} 下载文件到临时目录
 * - 本路由消费 token 并返回文件字节流
 *
 * 安全约束：
 * - token 一次性使用：consume 后立即从 store 删除，无法二次消费
 * - token 绑定 threadId：消费时校验 threadId 与 URL 路径中的 threadId 一致
 * - 内部目录路径（.snow/.git 等）一律返回 404，不暴露存在性（防枚举）
 * - safeJoin / symlink / realpath 由 readWorkspaceFileBytes 内部兜底
 * - 不需要 owner 校验：token 本身是授权凭证，仅由 Server 签发
 *
 * 响应：
 * - 200 + application/octet-stream（文件字节）
 * - 400 missing_token（缺少 token 参数）
 * - 403 invalid_token（token 无效/已过期/已使用/threadId 不匹配）
 * - 404 file_not_found（文件不存在 / 内部目录 / 越界）
 */
import { jsonError } from "@/lib/http";
import { isInternalPath, readWorkspaceFileBytes } from "@/lib/workspace";
import { consumeUploadToken } from "@/lib/workspace-upload-token";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest, props: { params: Promise<{ thread_id: string }> }) {
  const { thread_id } = await props.params;
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return jsonError(400, "missing_token", "缺少下载凭证");
  }

  const entry = consumeUploadToken(token);
  if (!entry || entry.threadId !== thread_id) {
    return jsonError(403, "invalid_token", "凭证无效或已过期");
  }

  // 内部目录下的文件一律返回 404（不暴露存在性，防枚举）
  if (isInternalPath(entry.workspacePath)) {
    return jsonError(404, "file_not_found", "文件不存在");
  }

  try {
    const bytes = await readWorkspaceFileBytes(thread_id, entry.workspacePath);
    if (bytes === null) {
      return jsonError(404, "file_not_found", "文件不存在");
    }
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  } catch {
    // 越界 / symlink 等异常一律返回 404（不区分，防枚举）
    return jsonError(404, "file_not_found", "文件不存在");
  }
}
