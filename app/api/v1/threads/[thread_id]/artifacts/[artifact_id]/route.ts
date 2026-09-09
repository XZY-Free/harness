import { createHash } from "node:crypto";
import { getArtifactById } from "@/lib/capability/artifact-queries";
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getFileStorageProvider } from "@/lib/files/storage-bootstrap";
import { getRequestId, jsonError, resourceNotFound } from "@/lib/http";

interface RouteContext {
  params: Promise<{ thread_id: string; artifact_id: string }>;
}

/** 通过平台 artifactId 读取 AI/Tool 最终文件；底层 Provider 引用永不暴露。 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { thread_id: threadId, artifact_id: artifactId } = await context.params;
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
  const artifact = await getArtifactById(principal.tenantId, artifactId);
  if (
    !artifact ||
    artifact.threadId !== threadId ||
    (artifact.expiresAt !== null && artifact.expiresAt.getTime() <= Date.now())
  ) {
    return resourceNotFound(requestId, `产物不存在或不可用: ${artifactId}`);
  }
  const provider = await getFileStorageProvider();
  if (artifact.storageProvider !== provider.name) {
    return jsonError(503, "artifact_storage_unavailable", "产物存储暂不可用");
  }
  const content = await provider.read({
    tenantId: principal.tenantId,
    threadId,
    resourceRef: artifact.contentRef,
  });
  if (
    !content ||
    content.byteLength !== artifact.byteSize ||
    `sha256:${createHash("sha256").update(content).digest("hex")}` !== artifact.contentHash
  ) {
    return resourceNotFound(requestId, `产物原文件不存在或完整性校验失败: ${artifactId}`);
  }
  return new Response(content as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": artifact.mediaType,
      "content-length": String(content.byteLength),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.displayName)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
