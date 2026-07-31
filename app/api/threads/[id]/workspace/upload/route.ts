/**
 * V10 Phase 7-1：流式上传 API 路由。
 *
 * 接收 Desktop 端上传的本机文件流式写入 Thread workspace `downloads/` 目录。
 *
 * 协议（与 desktop/downloads/download-uploader.ts 对齐）：
 *   POST /api/threads/[id]/workspace/upload
 *   Headers:
 *     Content-Type: application/octet-stream
 *     X-File-Name: encodeURIComponent(fileName)
 *     Authorization: Bearer ${authToken}    （由 workspace-access 校验）
 *   Body: ReadableStream<Uint8Array>（直接管道到 fs.createWriteStream）
 *
 * 响应：{ ok: true, workspacePath: "downloads/xxx", size: 1234 }
 *
 * 安全口径：
 * - 权限校验：requireThreadWorkspaceRead（owner + workspace.read）
 * - 文件名安全校验：只允许字母数字、点、横线、下划线；拒绝 ../、null byte、绝对路径
 * - 路径限定 downloads/ 子目录（relPath = `downloads/${fileName}`）
 * - safeJoin / symlink / realpath 由 writeWorkspaceFileFromStream 内部兜底
 */
import { jsonError, jsonOk } from "@/lib/http";
import { WorkspacePathError, writeWorkspaceFileFromStream } from "@/lib/workspace";
import { requireThreadWorkspaceRead } from "@/lib/workspace-access";
import type { NextRequest } from "next/server";

/** 合法文件名字符集：字母数字、点、横线、下划线。 */
const SAFE_FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * 校验文件名安全性。
 *
 * 拒绝：
 * - 空字符串
 * - 包含路径分隔符（/ 或 \）
 * - 包含 null byte
 * - 包含 .. 越界
 * - 绝对路径（首字符为 /）
 * - 含其他特殊字符的文件名
 */
function validateFileName(fileName: string): { ok: true } | { ok: false; reason: string } {
  if (!fileName || fileName.length === 0) {
    return { ok: false, reason: "文件名为空" };
  }
  if (fileName.includes("\0")) {
    return { ok: false, reason: "文件名包含 null byte" };
  }
  if (fileName.includes("/") || fileName.includes("\\")) {
    return { ok: false, reason: "文件名包含路径分隔符" };
  }
  if (fileName.startsWith(".")) {
    return { ok: false, reason: "文件名不能以点开头" };
  }
  if (!SAFE_FILE_NAME_RE.test(fileName)) {
    return { ok: false, reason: "文件名包含非法字符" };
  }
  return { ok: true };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // 1. 权限校验：owner + workspace.read
  const access = await requireThreadWorkspaceRead(request, id);
  if (!access.ok) return access.response;

  // 2. 从 X-File-Name 头获取文件名（URL decode）
  const rawFileName = request.headers.get("x-file-name");
  if (!rawFileName) {
    return jsonError(400, "missing_file_name", "缺少 X-File-Name 头");
  }
  let fileName: string;
  try {
    fileName = decodeURIComponent(rawFileName);
  } catch {
    return jsonError(400, "invalid_file_name", "X-File-Name 头 URL decode 失败");
  }

  // 3. 文件名安全校验
  const nameCheck = validateFileName(fileName);
  if (!nameCheck.ok) {
    return jsonError(400, "invalid_file_name", nameCheck.reason);
  }

  // 4. 校验 Content-Type（宽松：octet-stream 或缺失都接受，由调用方约定）
  // 不强制 content-type，避免 desktop 端类型与 server 端类型映射不一致导致失败

  // 5. 构造 relPath: downloads/${fileName}
  const relPath = `downloads/${fileName}`;

  // 6. 校验 request.body 存在
  if (!request.body) {
    return jsonError(400, "missing_body", "请求体为空");
  }

  // 7. 流式写入 workspace 文件
  try {
    const result = await writeWorkspaceFileFromStream(id, relPath, request.body);
    return jsonOk({ workspacePath: relPath, size: result.size });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return jsonError(400, "invalid_path", error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(500, "internal_error", `写入失败：${message}`);
  }
}
