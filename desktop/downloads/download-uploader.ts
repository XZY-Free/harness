/**
 * V10 Phase 7-1：本机文件流式上传到 Server workspace。
 *
 * 当 BrowserController 捕获到 Electron `will-download` 事件并完成本机下载后，
 * 调用本模块将本机文件流式上传到 Server 的 Thread workspace `downloads/` 目录。
 *
 * 关键约束：
 * - 不将整个文件读入内存（fs.createReadStream → fetch body）
 * - 使用 application/octet-stream + X-File-Name 头（非 multipart/form-data）
 * - 进度回调通过 stream 'data' 事件累计已上传字节
 * - Server 端通过 writeWorkspaceFileFromStream 接收 raw body 流式写入
 *
 * 协议：
 *   POST ${serverOrigin}/api/threads/${threadId}/workspace/upload
 *   Headers:
 *     Content-Type: application/octet-stream
 *     X-File-Name: encodeURIComponent(fileName)
 *     Authorization: Bearer ${authToken}    （仅在 authToken 提供时）
 *   Body: fs.createReadStream(filePath)
 *
 * 响应（jsonOk 信封，与 Server 其他 route 一致）：
 *   { ok: true, data: { workspacePath: "downloads/xxx", size: 1234 } }
 */

import { createReadStream, statSync } from "node:fs";

/** 上传结果。 */
export interface UploadResult {
  ok: boolean;
  workspacePath: string | null;
  error?: string;
}

/** 上传配置。 */
export interface UploadConfig {
  /** Server origin（如 http://localhost:3000）。 */
  serverOrigin: string;
  /** 设备认证 token（用于鉴权）。Phase 7-1 暂时可选。 */
  authToken?: string;
}

/** uploadFileToWorkspace 的入参。 */
export interface UploadParams {
  config: UploadConfig;
  threadId: string;
  /** 本机文件路径。 */
  filePath: string;
  /** 目标文件名（写入 workspace downloads/ 下）。 */
  fileName: string;
  /** 进度回调（每收到一次 stream 'data' 事件触发一次）。 */
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

/**
 * 流式上传文件到 Server workspace。
 *
 * 失败情形：
 * - 本机文件不存在 / 不可读：返回 { ok: false, error }，不发起 HTTP 请求
 * - HTTP 非 2xx：返回 { ok: false, error }
 * - 响应 JSON 缺少 workspacePath：返回 { ok: false, error }
 * - 网络异常：返回 { ok: false, error }
 */
export async function uploadFileToWorkspace(params: UploadParams): Promise<UploadResult> {
  const { config, threadId, filePath, fileName, onProgress } = params;

  // 1. 校验文件存在并获取大小
  let totalBytes: number;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { ok: false, workspacePath: null, error: `路径不是文件：${filePath}` };
    }
    totalBytes = stat.size;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, workspacePath: null, error: `无法读取文件：${message}` };
  }

  // 2. 构造请求 URL 与 headers
  const url = `${config.serverOrigin}/api/threads/${encodeURIComponent(threadId)}/workspace/upload`;
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-file-name": encodeURIComponent(fileName),
  };
  if (config.authToken && config.authToken.length > 0) {
    headers.authorization = `Bearer ${config.authToken}`;
  }

  // 3. 创建 ReadStream 作为 fetch body，附带进度回调
  const stream = createReadStream(filePath);
  let uploadedBytes = 0;
  stream.on("data", (chunk: Buffer | string) => {
    uploadedBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    if (onProgress) {
      onProgress(uploadedBytes, totalBytes);
    }
  });

  // 4. 发送 fetch 请求
  let response: Response;
  try {
    // Node.js ReadStream 不在 fetch BodyInit 类型中，需强制转换
    // （undici fetch 运行时实际接受 Node Readable 作为 body）
    response = await fetch(url, {
      method: "POST",
      headers,
      body: stream as unknown as never,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, workspacePath: null, error: `上传请求失败：${message}` };
  }

  // 5. 校验响应
  if (!response.ok) {
    return {
      ok: false,
      workspacePath: null,
      error: `上传失败：HTTP ${response.status} ${response.statusText}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, workspacePath: null, error: `响应解析失败：${message}` };
  }

  // 响应信封：{ ok: true, data: { workspacePath, size } }（与 Server jsonOk 一致）
  const envelope = body as { ok?: unknown; data?: { workspacePath?: unknown } };
  if (!envelope || envelope.ok !== true || !envelope.data) {
    return {
      ok: false,
      workspacePath: null,
      error: "响应缺少 data 字段",
    };
  }
  if (typeof envelope.data.workspacePath !== "string") {
    return {
      ok: false,
      workspacePath: null,
      error: "响应缺少 workspacePath 字段",
    };
  }

  return {
    ok: true,
    workspacePath: envelope.data.workspacePath,
  };
}
