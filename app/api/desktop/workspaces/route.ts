import {
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { apiError, apiSuccess, getRequestId } from "@/lib/http";
import {
  DesktopWorkspaceUnavailableError,
  ensureDesktopWorkspace,
} from "@/lib/workspace/desktop-workspace-queries";
import { z } from "zod";

export const dynamic = "force-dynamic";

const requestSchema = z
  .object({
    device_id: z.string().trim().min(1).max(128),
    display_name: z.string().trim().min(1).max(256),
    storage_scope_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  let principal: Awaited<ReturnType<typeof resolveEmployeePrincipal>>;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (error) {
    const authResponse = employeeAuthErrorResponse(error, crypto.randomUUID());
    if (authResponse) return authResponse;
    throw error;
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError("WORKSPACE_REGISTRATION_INVALID", "本地目录信息无效", { requestId });
  }

  try {
    const result = await ensureDesktopWorkspace({
      tenantId: principal.tenantId,
      userId: principal.userIdentityId,
      deviceKey: parsed.data.device_id,
      displayName: parsed.data.display_name,
      storageScopeDigest: parsed.data.storage_scope_digest,
    });
    return apiSuccess({
      workspace_id: result.workspaceId,
      binding_id: result.bindingId,
      display_name: result.displayName,
    });
  } catch (error) {
    if (error instanceof DesktopWorkspaceUnavailableError) {
      return apiError("DESKTOP_WORKSPACE_UNAVAILABLE", error.message, { requestId });
    }
    throw error;
  }
}
