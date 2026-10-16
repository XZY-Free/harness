import { getBridgeServer } from "@/lib/desktop-bridge/bridge-server";
import { apiError, apiSuccess, getRequestId } from "@/lib/http";
import { getDeviceForUser, revokeDevice } from "@/lib/identity/device-queries";
/**
 * Desktop 设备撤销端点。
 *
 * POST /api/desktop/devices/[deviceId]/revoke
 *   → 将设备 deviceState 从 active 改为 revoked，回填 revokedAt。
 *   → 主动断开该设备已建立的 WebSocket 连接（如果 BridgeServer 在运行）。
 *
 * 鉴权：resolvePrincipal + getDeviceForUser owner guard（tenantId + deviceKey + userId 三重校验）。
 * 幂等：已 revoked 的设备返回 409 device_already_revoked，不覆盖 revokedAt。
 * 安全：不暴露 publicKey 等敏感字段到响应。
 */
import { authErrorResponse, resolvePrincipal } from "@/lib/identity/resolver";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const requestId = getRequestId(request);
  const { deviceId } = await params;

  let principal: Awaited<ReturnType<typeof resolvePrincipal>>;
  try {
    principal = await resolvePrincipal(request.headers);
  } catch (error) {
    const authErr = authErrorResponse(error);
    if (authErr) return authErr;
    throw error;
  }

  // owner guard：tenantId + deviceKey + userId 三重校验，防越权撤销他人设备/跨租户操作。
  // deviceId 即正式模型的 deviceKey（public API 语义）；跨租户/非 owner 一律 404 隐藏存在性。
  const device = await getDeviceForUser(principal.tenantId, deviceId, principal.userIdentityId);
  if (!device) {
    return apiError("DEVICE_NOT_FOUND", "设备不存在或无权访问", { requestId });
  }

  // 幂等拒绝：已 revoked 不重复撤销，保留首次 revokedAt
  if (device.deviceState === "revoked") {
    return apiError("DEVICE_ALREADY_REVOKED", "设备已撤销", { requestId });
  }

  // 执行撤销（按 (tenantId, deviceKey) 二元键）
  const revoked = await revokeDevice(principal.tenantId, deviceId);
  if (!revoked) {
    // 并发场景：getDeviceForUser 返回 active 但 revokeDevice affectedRows=0
    // （可能并发被另一个请求撤销，或外键级联删除）
    return apiError("DEVICE_NOT_FOUND", "设备撤销失败：设备可能已被删除", { requestId });
  }

  // 主动断开该设备已建立的 WebSocket 连接（如果 BridgeServer 在运行）
  // 开发/测试环境 getBridgeServer() 返回 null，跳过
  const bridge = getBridgeServer();
  if (bridge) {
    try {
      // kickDevice 按 (tenantId, deviceKey) 定位，避免跨租户误踢同 deviceKey 设备
      bridge.kickDevice(principal.tenantId, deviceId);
    } catch (error) {
      // kick 失败不阻断撤销流程——DB 已更新，设备重连时 handleAuth 会拦截
      logger.warn("[/api/desktop/devices/[deviceId]/revoke] kickDevice 失败", {
        tenantId: principal.tenantId,
        deviceId,
        error: String(error),
      });
    }
  }

  // 响应保留公共 API 语义：deviceId/name/status 映射自 deviceKey/deviceName/deviceState。
  return apiSuccess({
    deviceId: revoked.deviceKey,
    name: revoked.deviceName,
    status: revoked.deviceState,
    revokedAt: revoked.revokedAt,
  });
}

// GET 不支持（撤销是写操作）
export async function GET(request: Request) {
  return apiError("METHOD_NOT_ALLOWED", "请使用 POST 方法", {
    requestId: getRequestId(request),
  });
}
