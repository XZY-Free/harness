/**
 * V10 Phase 7-3：Artifact 上传器。
 *
 * 将 Desktop 端的临时文件（截图、DOM dump、network body）流式上传到
 * Server workspace `artifacts/` 目录。
 *
 * 与 download-uploader 的区别：
 * - download-uploader 上传用户下载的文件到 downloads/
 * - artifact-uploader 上传 AI 生成的洞察产物到 artifacts/
 * - 复用相同的流式上传协议（octet-stream + X-File-Name）
 *
 * 安全约束：
 * - 文件路径必须是 Desktop 临时目录中的文件（调用方保证）
 * - 文件名包含时间戳和类型前缀，便于追溯
 * - 上传完成后由调用方通过 TempFileRegistry + safeUnlink 清理临时文件
 *   （Phase 7-6 已实现，详见 desktop/artifacts/temp-cleanup.ts）
 *
 * 使用场景：
 * - browser.screenshot 命令返回本地路径后，AI 可请求上传为 Artifact
 * - DOM dump（browser.snapshot 的完整 HTML，如有）可上传为 Artifact
 * - Network body（通过 CDP Network.getResponseBody 获取）可上传为 Artifact
 */

import { createReadStream, statSync } from "node:fs";

/** Artifact 上传结果。 */
export interface ArtifactUploadResult {
  ok: boolean;
  workspacePath: string | null;
  size: number;
  error?: string;
}

/** Artifact 上传配置。 */
export interface ArtifactUploadConfig {
  /** Server origin（如 http://localhost:3000）。 */
  serverOrigin: string;
  /** 设备认证 token（用于鉴权）。 */
  authToken?: string;
}

/** uploadArtifact 的入参。 */
export interface ArtifactUploadParams {
  config: ArtifactUploadConfig;
  threadId: string;
  /** 本机文件路径（通常在 os.tmpdir() 下）。 */
  filePath: string;
  /** 目标文件名（写入 workspace artifacts/ 下）。 */
  fileName: string;
}

/**
 * 流式上传 Artifact 文件到 Server workspace。
 *
 * 失败情形：
 * - 本机文件不存在 / 不可读：返回 { ok: false, error }
 * - HTTP 非 2xx：返回 { ok: false, error }
 * - 响应 JSON 缺少 workspacePath：返回 { ok: false, error }
 * - 网络异常：返回 { ok: false, error }
 */
export async function uploadArtifact(params: ArtifactUploadParams): Promise<ArtifactUploadResult> {
  const { config, threadId, filePath, fileName } = params;

  // 1. 校验文件存在并获取大小
  let totalBytes: number;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { ok: false, workspacePath: null, size: 0, error: `路径不是文件：${filePath}` };
    }
    totalBytes = stat.size;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, workspacePath: null, size: 0, error: `无法读取文件：${message}` };
  }

  // 2. 构造请求 URL 与 headers
  const url = `${config.serverOrigin}/api/threads/${encodeURIComponent(threadId)}/workspace/artifact`;
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-file-name": encodeURIComponent(fileName),
  };
  if (config.authToken && config.authToken.length > 0) {
    headers.authorization = `Bearer ${config.authToken}`;
  }

  // 3. 创建 ReadStream 作为 fetch body
  const stream = createReadStream(filePath);

  // 4. 发送 fetch 请求
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: stream as unknown as never,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, workspacePath: null, size: 0, error: `上传请求失败：${message}` };
  }

  // 5. 校验响应
  if (!response.ok) {
    return {
      ok: false,
      workspacePath: null,
      size: 0,
      error: `上传失败：HTTP ${response.status} ${response.statusText}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, workspacePath: null, size: 0, error: `响应解析失败：${message}` };
  }

  // 响应信封：{ ok: true, data: { workspacePath, size } }（与 Server jsonOk 一致）
  const envelope = body as { ok?: unknown; data?: { workspacePath?: unknown; size?: unknown } };
  if (!envelope || envelope.ok !== true || !envelope.data) {
    return { ok: false, workspacePath: null, size: 0, error: "响应缺少 data 字段" };
  }
  if (typeof envelope.data.workspacePath !== "string") {
    return { ok: false, workspacePath: null, size: 0, error: "响应缺少 workspacePath 字段" };
  }

  return {
    ok: true,
    workspacePath: envelope.data.workspacePath,
    size: typeof envelope.data.size === "number" ? envelope.data.size : totalBytes,
  };
}
