import { authErrorResponse, getCurrentUserFromRequest } from "@/lib/auth";
import { registerDevice } from "@/lib/db/desktop-device-queries";
import type { User } from "@/lib/db/schema";
import { jsonError } from "@/lib/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

const registrationSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
  publicKey: z.string().trim().min(1).max(4096),
  name: z.string().trim().min(1).max(256),
  version: z.string().trim().min(1).max(32),
});

export async function POST(request: Request) {
  let currentUser: User;
  try {
    currentUser = await getCurrentUserFromRequest(request);
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    throw error;
  }

  const body = await request.json().catch(() => null);
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "invalid_device_registration", "设备注册信息无效");
  }

  const device = await registerDevice({ userId: currentUser.id, ...parsed.data });
  if (device.userId !== currentUser.id || device.publicKey !== parsed.data.publicKey) {
    return jsonError(409, "device_binding_conflict", "设备标识已绑定到其他身份");
  }
  if (device.status !== "active") {
    return jsonError(409, "device_revoked", "设备已撤销，请重新登录生成新设备身份");
  }

  return Response.json({
    ok: true,
    data: { deviceId: device.deviceId, status: device.status },
  });
}
