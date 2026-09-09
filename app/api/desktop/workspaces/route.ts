import {
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { jsonError } from "@/lib/http";
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
    location_fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
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
    return jsonError(400, "invalid_workspace_registration", "本地目录信息无效");
  }

  try {
    const result = await ensureDesktopWorkspace({
      tenantId: principal.tenantId,
      userId: principal.userIdentityId,
      deviceKey: parsed.data.device_id,
      displayName: parsed.data.display_name,
      locationFingerprint: parsed.data.location_fingerprint,
    });
    return Response.json({
      ok: true,
      data: {
        workspace_id: result.workspaceId,
        binding_id: result.bindingId,
        display_name: result.displayName,
      },
    });
  } catch (error) {
    if (error instanceof DesktopWorkspaceUnavailableError) {
      return jsonError(409, "desktop_workspace_unavailable", error.message);
    }
    throw error;
  }
}
