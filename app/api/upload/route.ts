import { randomUUID } from "node:crypto";

import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getRequestId, resourceNotFound } from "@/lib/http";
import { logger } from "@/lib/logger";
import { writeWorkspaceFileBytes } from "@/lib/workspace";

// ─── 图片类型（存文件返回 URL）─────────────────────────
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// ─── PDF 类型（用 pdf-parse 专业解析）──────────────────
const PDF_MIME = "application/pdf";
const PDF_EXT = ".pdf";

// ─── Office 文档类型（用 officeparser 解析）─────────────
const OFFICE_EXTS = new Set([
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
  ".odt",
  ".odp",
  ".ods",
  ".rtf",
]);

// P1-15: Office 文档对应 MIME 集(与 OFFICE_EXTS 同类别校验用)
const OFFICE_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/rtf",
]);

// ─── 纯文本类型（直接读取）─────────────────────────────
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/html", "text/csv"]);
const TEXT_EXTS = new Set([".csv", ".md", ".html", ".htm", ".txt"]);

const IMAGE_MAX_SIZE = 10 * 1024 * 1024; // 图片上限 10MB
const DOC_MAX_SIZE = 20 * 1024 * 1024; // 文档上限 20MB

/** 从文件名取扩展名 */
function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i).toLowerCase() : "";
}

/** 判断是否为可解析文档 */
function isDocument(filename: string, mimeType: string): boolean {
  if (IMAGE_TYPES.has(mimeType)) return false;
  const ext = extOf(filename);
  // P1-15: ext 与 mimeType 必须同类别命中(防错配触发解析器分支,如 text/plain+.pdf 走 pdf-parse)。
  // mimeType 缺失(空)时允许(浏览器未识别),由 ext 主导分流。
  const mimeOk = mimeType === "";
  if (ext === PDF_EXT && (mimeOk || mimeType === PDF_MIME)) return true;
  if (OFFICE_EXTS.has(ext) && (mimeOk || OFFICE_MIMES.has(mimeType))) return true;
  if (TEXT_EXTS.has(ext) && (mimeOk || TEXT_TYPES.has(mimeType))) return true;
  return false;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const threadId = (formData.get("threadId") as string | null) ?? "";
  const requestId = getRequestId(request);

  // 归属校验:upload 必须绑定 thread,且当前员工是该 thread 的 owner。
  // 防匿名/跨用户写 public/uploads 静态目录(P1-3)。正式 Employee API 不走 action scope。
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
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

  if (!file || !file.size) {
    return Response.json({ error: "未选择文件" }, { status: 400 });
  }

  const mimeType = file.type || "";
  const fileName = file.name || "unknown";
  const ext = extOf(fileName);

  // ── 1) 图片：存入 thread workspace/uploads,经 workspace 读路由鉴权分发 ──
  if (IMAGE_TYPES.has(mimeType)) {
    if (file.size > IMAGE_MAX_SIZE) {
      return Response.json(
        { error: `图片过大，上限 ${IMAGE_MAX_SIZE / 1024 / 1024}MB` },
        { status: 400 },
      );
    }
    return await handleImageUpload(threadId, file);
  }

  // ── 2) 文档：解析文本返回 content（不落盘）──
  if (isDocument(fileName, mimeType)) {
    if (file.size > DOC_MAX_SIZE) {
      return Response.json(
        { error: `文档过大，上限 ${DOC_MAX_SIZE / 1024 / 1024}MB` },
        { status: 400 },
      );
    }
    return await handleDocumentParse(file, ext, mimeType);
  }

  return Response.json(
    {
      error:
        "不支持的文件类型（支持图片 PNG/JPG/GIF/WebP 及 PDF/DOCX/PPTX/XLSX/TXT/MD/CSV/RTF 等文档）",
    },
    { status: 400 },
  );
}

// ══════════════════════════════════════════════════════════
// 图片上传 — 存入 workspaces/{threadId}/uploads/,经 workspace 路由 raw 模式分发
// ══════════════════════════════════════════════════════════

async function handleImageUpload(threadId: string, file: File) {
  const extMap: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  const storedName = `${randomUUID()}${extMap[file.type] || ".bin"}`;
  const relPath = `uploads/${storedName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    await writeWorkspaceFileBytes(threadId, relPath, buffer);
    return Response.json({
      kind: "image" as const,
      url: `/api/v1/threads/${threadId}/workspace/${relPath}?raw=1`,
      filename: file.name,
      size: file.size,
      type: file.type,
    });
  } catch (err) {
    console.error("[upload] 图片写入失败:", err);
    return Response.json({ error: "服务器写入失败" }, { status: 500 });
  }
}

// ══════════════════════════════════════════════════════════
// 文档解析 —— 分发到不同引擎
// ══════════════════════════════════════════════════════════

/** P2-9:文档解析超时上限,防恶意 PDF/Office 文档(慢解析或 zip bomb)拖垮进程。 */
const DOC_PARSE_TIMEOUT_MS = 15_000;

function withParseTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} 解析超时(>${DOC_PARSE_TIMEOUT_MS}ms),疑似恶意文档`)),
        DOC_PARSE_TIMEOUT_MS,
      ),
    ),
  ]);
}

async function handleDocumentParse(file: File, ext: string, mimeType: string) {
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    let text: string;
    let engine: string;

    // ├── PDF → pdf-parse（动态 import，避免 Turbopack 静态分析失败）
    if (ext === PDF_EXT || mimeType === PDF_MIME) {
      engine = "pdf-parse";
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      try {
        const data = await withParseTimeout(parser.getText(), "PDF");
        text = data.text || "";

        const meta: string[] = [];
        if (data.total) meta.push(`页数: ${data.total}`);
        if (meta.length > 0) {
          text = `[文档元信息: ${meta.join(" | ")}]\n\n${text}`;
        }
      } finally {
        await parser.destroy();
      }
    }
    // ├── 纯文本 → 直接读取
    else if (TEXT_TYPES.has(mimeType) || TEXT_EXTS.has(ext)) {
      engine = "native";
      text = buffer.toString("utf-8");
    }
    // ├── Office 全家桶 → officeparser（动态 import，同上）
    else {
      engine = "officeparser";
      const { parseOffice } = await import("officeparser");
      const ast = await withParseTimeout(parseOffice(buffer), "Office");
      text = ast.toText();
    }

    // 截断过长文档（防止 token 溢出，约 12k tokens 上限）
    const MAX_CHARS = 50_000;
    if (text.length > MAX_CHARS) {
      text = `${text.slice(0, MAX_CHARS)}\n\n[... 文档已截断，原文共 ${text.length.toLocaleString()} 字符，由 ${engine} 引擎解析]`;
    }

    return Response.json({
      kind: "document" as const,
      filename: file.name,
      size: file.size,
      type: mimeType || "application/octet-stream",
      engine,
      text,
      charCount: text.length,
    });
  } catch (err: unknown) {
    // P1-25: 不回显解析库内部错误(可能含路径/堆栈),完整错误落 logger
    logger.error("[upload] 文档解析失败", {
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ error: "文档解析失败,请检查文件格式" }, { status: 500 });
  }
}
