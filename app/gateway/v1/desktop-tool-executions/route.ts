import { dispatchDesktopTool } from "@/lib/capability/desktop-tool-dispatch";
import { ProviderExecutionError } from "@/lib/capability/provider-executor";
import {
  gatewayAuthErrorResponse,
  gatewaySchemaInvalidTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";
import { getRequestId } from "@/lib/http";
import { z } from "zod";

export const dynamic = "force-dynamic";
const bodySchema = z
  .object({ toolCallId: z.string().uuid(), attemptId: z.string().uuid() })
  .strict();

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  let principal: Awaited<ReturnType<typeof resolveGatewayPrincipal>>;
  try {
    principal = await resolveGatewayPrincipal(request.headers);
  } catch (error) {
    const response = gatewayAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success)
    return gatewaySchemaInvalidTable(requestId, "必须提供 ToolCall 和 Attempt 引用");
  try {
    const outcome = await dispatchDesktopTool({
      ...body.data,
      tenantId: principal.tenantId,
      invocationId: principal.invocationId,
    });
    return Response.json({ ok: true, ...outcome });
  } catch (error) {
    if (error instanceof ProviderExecutionError)
      return Response.json(
        { ok: false, code: error.code, retryClass: error.retryClass, dispatched: error.dispatched },
        { status: 409 },
      );
    return Response.json(
      {
        ok: false,
        code: "DESKTOP_DISPATCH_FAILED",
        retryClass: "unknown_effect",
        dispatched: true,
      },
      { status: 500 },
    );
  }
}
