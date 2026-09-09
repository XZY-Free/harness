import { createHash } from "node:crypto";
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getFileStorageProvider } from "@/lib/files/storage-bootstrap";
import { getRequestId, jsonError, resourceNotFound } from "@/lib/http";
import { getWorkspaceAttachmentById } from "@/lib/workspace/workspace-queries";

interface RouteContext {
  params: Promise<{ thread_id: string; attachment_id: string }>;
}

/** 通过平台 attachmentId 读取原文件；底层 Provider 引用永不暴露给客户端。 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { thread_id: threadId, attachment_id: attachmentId } = await context.params;

  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (error) {
    const response = employeeAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }

  const thread = await getThreadById(principal.tenantId, threadId);
  if (
    !thread ||
    thread.ownerUserId !== principal.userIdentityId ||
    thread.lifecycleState === "deleted"
  ) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  const attachment = await getWorkspaceAttachmentById(principal.tenantId, attachmentId);
  if (
    !attachment ||
    attachment.threadId !== threadId ||
    attachment.resourceType !== "file" ||
    attachment.attachmentState !== "attached" ||
    (attachment.expiresAt !== null && attachment.expiresAt.getTime() <= Date.now())
  ) {
    return resourceNotFound(requestId, `附件不存在或不可用: ${attachmentId}`);
  }

  const provider = await getFileStorageProvider();
  if (attachment.storageProvider !== provider.name) {
    return jsonError(503, "attachment_storage_unavailable", "附件存储暂不可用");
  }

  const bytes = await provider.read({
    tenantId: principal.tenantId,
    threadId,
    resourceRef: attachment.resourceRef,
  });
  if (
    !bytes ||
    attachment.sizeBytes === null ||
    !attachment.resourceFingerprint ||
    bytes.byteLength !== attachment.sizeBytes ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== attachment.resourceFingerprint
  ) {
    return resourceNotFound(requestId, `附件原文件不存在或完整性校验失败: ${attachmentId}`);
  }

  const originalFilename = attachment.originalFilename ?? "attachment";
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": attachment.contentType ?? "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(originalFilename)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
