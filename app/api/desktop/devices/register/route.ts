import { jsonError } from "@/lib/http";
import { registerDevice } from "@/lib/identity/device-queries";
/**
 * Desktop 设备注册端点。
 *
 * POST /api/desktop/devices/register
 *   → 以当前可信主体身份注册一台 Desktop 设备（正式 Identity + Device 模型）。
 *
 * 鉴权：resolvePrincipal 从 header 解析可信主体（tenantId + userIdentityId）。
 * 租户边界：所有写入按 (tenantId, deviceKey) 定位，userId = principal.userIdentityId。
 * 幂等：同一 (tenantId, deviceKey) 已注册则返回现有记录，不覆盖 publicKey/deviceName/appVersion。
 * 响应保留公共 API 语义（deviceId/status 映射自正式字段 deviceKey/deviceState），不暴露内部 id。
 */
import { authErrorResponse, resolvePrincipal } from "@/lib/identity/resolver";
import { z } from "zod";

export const dynamic = "force-dynamic";

const registrationSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
  publicKey: z.string().trim().min(1).max(4096),
  name: z.string().trim().min(1).max(256),
  version: z.string().trim().min(1).max(32),
});

export async function POST(request: Request) {
  let principal: Awaited<ReturnType<typeof resolvePrincipal>>;
  try {
    principal = await resolvePrincipal(request.headers);
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

  // 正式 Device 唯一键是 (tenantId, deviceKey)；deviceId 即 deviceKey，name→deviceName，version→appVersion。
  const device = await registerDevice({
    tenantId: principal.tenantId,
    userId: principal.userIdentityId,
    deviceKey: parsed.data.deviceId,
    publicKey: parsed.data.publicKey,
    deviceName: parsed.data.name,
    appVersion: parsed.data.version,
  });
  // owner/绑定冲突：设备不属于当前主体，或 publicKey 与提交不符（已绑定其他身份）
  if (device.userId !== principal.userIdentityId || device.publicKey !== parsed.data.publicKey) {
    return jsonError(409, "device_binding_conflict", "设备标识已绑定到其他身份");
  }
  if (device.deviceState !== "active") {
    return jsonError(409, "device_revoked", "设备已撤销，请重新登录生成新设备身份");
  }

  // 响应保留公共 API 语义：deviceId/status 映射自 deviceKey/deviceState，并返回 tenantId 供 Desktop 持久化。
  return Response.json({
    ok: true,
    data: {
      deviceId: device.deviceKey,
      status: device.deviceState,
      tenantId: principal.tenantId,
    },
  });
}
