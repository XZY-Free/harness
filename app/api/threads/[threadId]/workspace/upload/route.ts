import { browserConfig } from "@/lib/config";
/**
 * Workspace 流式上传 API（正式 v1）。
 *
 * 用途：Desktop 浏览器（受 AI 控制的 WebContents）完成本机下载后，把文件流式推送到
 * Server 的 Thread workspace。这样 AI 后续能在 workspace 中读取 / 处理该文件。
 *
 * 与 workspace/download/route.ts 方向相反：
 * - 本路由：本机文件 → workspace（Desktop 上传）
 * - download 路由：workspace → 本机（AI 调 browserUploadFile 时签发一次性凭证）
 *
 * 协议：
 *   POST /api/threads/{threadId}/workspace/upload
 *   Headers:
 *     Content-Type: application/octet-stream
 *     X-File-Name: <encodeURIComponent(fileName)>
 *   Body: 原始字节流
 *   → 200 { path, name, size, stat }（apiSuccess 裸对象）
 *
 * 安全约束：
 * - 员工身份鉴权 + Thread.ownerUserId（不存在 / 非 owner / 已删除一律 404）
 * - 文件名取自 X-File-Name，**必须净化**：decode 后取 basename 再拒 `..` / 分隔符 /
 *   控制字符 / 内部目录名 —— 调用方不得借此写入 workspace 任意路径
 * - 落盘位置限定为 workspace 下的 downloads/ 子目录（downloadsDirName 配置）
 * - 写入走 writeWorkspaceFileFromStream（内部：safeJoin + symlink/realpath 防护 +
 *   先写 .tmp 再 rename 的原子写入）
 * - 内部目录（.nex/.git 等）一律 404（不暴露存在性）
 * - 单 Thread 下载记录上限 maxDownloadsPerThread，超出返回 409
 */
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { apiError, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  WorkspacePathError,
  isInternalPath,
  listWorkspaceFiles,
  workspaceStat,
  writeWorkspaceFileFromStream,
} from "@/lib/workspace";
import type { NextRequest } from "next/server";

/** 文件名最大长度（字符），超出截断（保留扩展名）。 */
const MAX_FILE_NAME_LENGTH = 200;

/**
 * 净化文件名，防路径穿越与非法字符。
 *
 * 规则：
 * 1. decodeURIComponent（失败则原样，兼容未编码调用方）
 * 2. 取 basename（同时处理 `/` 与 `\`，切断任何目录前缀）
 * 3. 拒绝空、`.`、`..`、纯点串
 * 4. 剔除控制字符（< 0x20 与 0x7f）
 * 5. 截断到 MAX_FILE_NAME_LENGTH（保留扩展名）
 *
 * @returns 合法文件名；无法净化时返回 null（调用方返回 400）
 */
export function sanitizeFileName(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // 非合法 URL 编码：按原样处理（仍走后续净化）
  }

  // 取最后一段路径（同时兼容 POSIX `/` 与 Windows `\`）
  const lastSlash = Math.max(decoded.lastIndexOf("/"), decoded.lastIndexOf("\\"));
  let name = lastSlash >= 0 ? decoded.slice(lastSlash + 1) : decoded;

  // 剔除控制字符
  let cleaned = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    cleaned += ch;
  }
  name = cleaned.trim();

  // 拒绝空 / 导航名 / 纯点串
  if (!name || name === "." || name === ".." || /^\.+$/.test(name)) return null;

  // 截断（保留扩展名）
  if (name.length > MAX_FILE_NAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    if (dot > 0 && name.length - dot <= 16) {
      const ext = name.slice(dot);
      name = name.slice(0, MAX_FILE_NAME_LENGTH - ext.length) + ext;
    } else {
      name = name.slice(0, MAX_FILE_NAME_LENGTH);
    }
    // 截断后再校验（避免截出纯点串）
    if (!name || /^\.+$/.test(name)) return null;
  }

  return name;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const requestId = getRequestId(req);

  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(req.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const thread = await getThreadById(principal.tenantId, threadId);
  if (
    !thread ||
    thread.ownerUserId !== principal.userIdentityId ||
    thread.lifecycleState === "deleted"
  ) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  // 文件名净化（防路径穿越）
  const rawName = req.headers.get("x-file-name");
  if (!rawName) {
    return apiError("MISSING_REQUIRED_FIELD", "缺少 X-File-Name 头", { requestId });
  }
  const fileName = sanitizeFileName(rawName);
  if (!fileName) {
    return apiError("INVALID_REQUEST", "文件名无效", { requestId });
  }

  // 目标路径固定在 downloads/ 子目录下（不允许调用方指定任意目录）
  const downloadsDir = browserConfig.downloadsDirName;
  const relPath = `${downloadsDir}/${fileName}`;
  if (isInternalPath(relPath)) {
    return apiError("WORKSPACE_PATH_INVALID", "目标路径不可写", { requestId });
  }

  // 上传前总量门禁（防止无限堆积）
  try {
    const existing = await listWorkspaceFiles(threadId, { skipInternal: true });
    const inDownloads = existing.filter((p) => p.startsWith(`${downloadsDir}/`));
    const alreadyExists = inDownloads.includes(relPath);
    if (!alreadyExists && inDownloads.length >= browserConfig.maxDownloadsPerThread) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", "该会话下载文件数已达上限", {
        requestId,
        details: { limit: browserConfig.maxDownloadsPerThread },
      });
    }
  } catch {
    // 列举失败不阻断上传（统计是软门禁，非安全约束）
  }

  // 请求体必须是可读流
  if (!req.body) {
    return apiError("INVALID_REQUEST", "请求体为空", { requestId });
  }

  try {
    const { size } = await writeWorkspaceFileFromStream(threadId, relPath, req.body);
    const stat = await workspaceStat(threadId, relPath);
    return apiSuccess({ path: relPath, name: fileName, size, stat });
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      return apiError("WORKSPACE_PATH_INVALID", error.message, { requestId });
    }
    throw error;
  }
}
