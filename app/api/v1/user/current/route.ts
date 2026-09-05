import { apiSuccess, getRequestId } from "@/lib/http";
import { authErrorResponse, resolveCurrentUserContext } from "@/lib/identity/resolver";

export const dynamic = "force-dynamic";

/** GET /api/v1/user/current：标准身份展示字段 + 企业资料健康状态。 */
export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const currentUser = await resolveCurrentUserContext(request.headers, "employee");
    return apiSuccess(
      {
        user: {
          id: currentUser.userIdentityId,
          email: currentUser.email,
          displayName: currentUser.displayName,
        },
        profileStatus: currentUser.profileStatus,
        lastVerifiedAt: currentUser.lastVerifiedAt?.toISOString() ?? null,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error, requestId);
    if (authResponse) return authResponse;
    throw error;
  }
}
