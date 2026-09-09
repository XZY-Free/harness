import { createHash, randomUUID } from "node:crypto";

import { fileStorageConfig } from "@/lib/config";
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { commitManagedWorkspaceAttachment } from "@/lib/files/commit-managed-attachment";
import { getFileStorageProvider } from "@/lib/files/storage-bootstrap";
import { IDEMPOTENCY_KEY_HEADER, apiError, getRequestId, resourceNotFound } from "@/lib/http";
import {
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromPrincipal,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/identity/idempotency";
import { logger } from "@/lib/logger";

// ─── 当前员工上传入口允许的文件类型 ────────────────────
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const PDF_MIME = "application/pdf";
const PDF_EXT = ".pdf";

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

// Office 文档对应 MIME 集（与扩展名共同校验，防止类型伪装）。
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

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/html", "text/csv"]);
const TEXT_EXTS = new Set([".csv", ".md", ".html", ".htm", ".txt"]);

/** 从文件名取扩展名 */
function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i).toLowerCase() : "";
}

/** 判断是否为当前入口允许保存的文档。 */
function isDocument(filename: string, mimeType: string): boolean {
  if (IMAGE_TYPES.has(mimeType)) return false;
  const ext = extOf(filename);
  // ext 与 mimeType 必须同类别命中；mimeType 缺失时由扩展名主导。
  const mimeOk = mimeType === "";
  if (ext === PDF_EXT && (mimeOk || mimeType === PDF_MIME)) return true;
  if (OFFICE_EXTS.has(ext) && (mimeOk || OFFICE_MIMES.has(mimeType))) return true;
  if (TEXT_EXTS.has(ext) && (mimeOk || TEXT_TYPES.has(mimeType))) return true;
  return false;
}

interface RouteContext {
  params: Promise<{ thread_id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  const { thread_id: threadId } = await context.params;

  // 上传必须绑定 Thread，且当前员工是该 Thread 的 owner；正式 Employee API 不走 action scope。
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

  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey || idempotencyKey.length > 256) {
    return apiError("REQUEST_SCHEMA_INVALID", "Idempotency-Key 头必填且不能超过 256 字符", {
      requestId,
    });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file || !file.size) {
    return Response.json({ error: "未选择文件" }, { status: 400 });
  }

  const mimeType = file.type || "";
  const fileName = file.name || "unknown";
  if (fileName.length > 512) {
    return Response.json({ error: "文件名过长，上限 512 个字符" }, { status: 400 });
  }
  const ext = extOf(fileName);

  // 图片与文档统一保存原文件；解析属于消费方业务，不属于上传接口。
  if (IMAGE_TYPES.has(mimeType)) {
    if (file.size > fileStorageConfig.imageUploadMaxBytes) {
      return Response.json(
        { error: `图片过大，上限 ${fileStorageConfig.imageUploadMaxBytes / 1024 / 1024}MB` },
        { status: 400 },
      );
    }
    return await handleFileUpload(principal, threadId, file, idempotencyKey, requestId);
  }

  if (isDocument(fileName, mimeType)) {
    if (file.size > fileStorageConfig.documentUploadMaxBytes) {
      return Response.json(
        {
          error: `文档过大，上限 ${fileStorageConfig.documentUploadMaxBytes / 1024 / 1024}MB`,
        },
        { status: 400 },
      );
    }
    return await handleFileUpload(principal, threadId, file, idempotencyKey, requestId);
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
// 原文件上传——只保存字节，不解析内容。
// ══════════════════════════════════════════════════════════

async function handleFileUpload(
  principal: Principal,
  threadId: string,
  file: File,
  idempotencyKey: string,
  requestId: string,
) {
  const attachmentId = randomUUID();
  const buffer = Buffer.from(await file.arrayBuffer());
  const contentDigest = createHash("sha256").update(buffer).digest("hex");
  const requestHash = computeRequestHash("POST", `/api/v1/threads/${threadId}/attachments`, {
    filename: file.name,
    media_type: file.type || "application/octet-stream",
    byte_size: file.size,
    content_sha256: contentDigest,
  });
  const outcome = await enforceIdempotency({
    caller: callerFromPrincipal(principal),
    commandScope: `thread.attachment.create:${threadId}`,
    idempotencyKey,
    requestHash,
  });

  if (outcome.kind === "replay") {
    return buildReplayResponse(outcome.record, requestId, isAttachmentResponseBody);
  }
  if (outcome.kind === "in_flight" || outcome.kind === "conflict") {
    return buildIdempotencyErrorResponse({
      record: outcome.kind === "conflict" ? outcome.existingRecord : outcome.record,
      reason: outcome.kind === "conflict" ? "conflict" : "in_flight",
      requestId,
    });
  }

  let recordId: string;
  if (outcome.kind === "retry_allowed") {
    const reset = await prepareRetryForFailedRecord({ record: outcome.record, requestHash });
    if (!reset) {
      return buildIdempotencyErrorResponse({
        record: outcome.record,
        reason: "conflict",
        requestId,
      });
    }
    recordId = reset.id;
  } else {
    recordId = outcome.record.id;
  }

  try {
    const provider = await getFileStorageProvider();
    const stored = await provider.store({
      tenantId: principal.tenantId,
      ownerUserId: principal.userIdentityId,
      threadId,
      resourceId: attachmentId,
      resourceKind: "attachment",
      originalFilename: file.name,
      contentType: file.type || "application/octet-stream",
      content: buffer,
    });
    const responseBody = {
      kind: "attachment" as const,
      attachment_id: attachmentId,
      url: `/api/v1/threads/${threadId}/attachments/${attachmentId}`,
      filename: file.name,
      size: file.size,
      type: file.type,
    };
    try {
      await commitManagedWorkspaceAttachment(
        {
          id: attachmentId,
          tenantId: principal.tenantId,
          threadId,
          storageProvider: provider.name,
          resourceRef: stored.resourceRef,
          resourceFingerprint: `sha256:${contentDigest}`,
          originalFilename: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          attachedBy: principal.userIdentityId,
        },
        {
          recordId,
          responseBody,
        },
      );
    } catch (error) {
      await provider
        .delete({
          tenantId: principal.tenantId,
          threadId,
          resourceRef: stored.resourceRef,
        })
        .catch(() => false);
      throw error;
    }
    return Response.json(responseBody, { status: 201 });
  } catch (err) {
    await failRecord(recordId).catch(() => undefined);
    logger.error("[file-storage] 原文件写入失败", {
      threadId,
      error: err instanceof Error ? err.message : "unknown_error",
    });
    return Response.json({ error: "服务器写入失败" }, { status: 500 });
  }
}

function isAttachmentResponseBody(body: Record<string, unknown>): boolean {
  return (
    body.kind === "attachment" &&
    typeof body.attachment_id === "string" &&
    typeof body.url === "string" &&
    typeof body.filename === "string" &&
    typeof body.size === "number" &&
    typeof body.type === "string"
  );
}
