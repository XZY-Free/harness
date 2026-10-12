import {
  AgentAttachmentAccessError,
  readAgentAttachment,
} from "@/lib/files/agent-attachment-access";
import { gatewaySchemaInvalidTable } from "@/lib/gateway/route-helpers";
import { getRequestId, jsonError, resourceNotFound } from "@/lib/http";

export const dynamic = "force-dynamic";

interface ResolveAttachmentBody {
  reference_id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidBody(value: unknown): value is ResolveAttachmentBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 1 &&
    typeof body.reference_id === "string" &&
    UUID_PATTERN.test(body.reference_id)
  );
}

/** 使用短期 capability reference 读取 Agent 当前调用获准访问的原文件。 */
export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  const body = await request.json().catch(() => null);
  if (!isValidBody(body)) {
    return gatewaySchemaInvalidTable(requestId, "请求体必须且只能包含合法 reference_id");
  }

  try {
    const resolved = await readAgentAttachment(body.reference_id);
    return new Response(resolved.content as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": resolved.contentType,
        "content-length": String(resolved.content.byteLength),
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(resolved.originalFilename)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AgentAttachmentAccessError) {
      if (error.code === "storage_unavailable") {
        return jsonError(503, "attachment_storage_unavailable", "附件存储暂不可用");
      }
      return resourceNotFound(requestId, "附件引用不存在或不可用");
    }
    throw error;
  }
}
