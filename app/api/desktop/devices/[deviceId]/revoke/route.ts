/**
 * V10 Phase 8：Desktop 设备撤销端点。
 *
 * POST /api/desktop/devices/[deviceId]/revoke
 *   → 将设备 status 从 active 改为 revoked，回填 revokedAt。
 *   → 主动断开该设备已建立的 WebSocket 连接（如果 BridgeServer 在运行）。
 *
 * 鉴权：getCurrentUserFromRequest + getDeviceForUser owner guard（deviceId + userId 双校验）。
 * 幂等：已 revoked 的设备返回 409 device_already_revoked，不覆盖 revokedAt。
 * 安全：不暴露 publicKey 等敏感字段到响应。
 */
import { authErrorResponse, getCurrentUserFromRequest } from "@/lib/auth";
import { getDeviceForUser, revokeDevice } from "@/lib/db/desktop-device-queries";
import type { User } from "@/lib/db/schema";
import { getBridgeServer } from "@/lib/desktop-bridge/bridge-server";
import { jsonError } from "@/lib/http";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;

  let currentUser: User;
  try {
    currentUser = await getCurrentUserFromRequest(request);
  } catch (error) {
    const authErr = authErrorResponse(error);
    if (authErr) return authErr;
    throw error;
  }

  // owner guard：deviceId + userId 双校验，防越权撤销他人设备
  const device = await getDeviceForUser(deviceId, currentUser.id);
  if (!device) {
    return jsonError(404, "device_not_found", "设备不存在或无权访问");
  }

  // 幂等拒绝：已 revoked 不重复撤销，保留首次 revokedAt
  if (device.status === "revoked") {
    return jsonError(409, "device_already_revoked", "设备已撤销");
  }

  // 执行撤销
  const revoked = await revokeDevice(deviceId);
  if (!revoked) {
    // 并发场景：getDeviceForUser 返回 active 但 revokeDevice affectedRows=0
    // （可能并发被另一个请求撤销，或外键级联删除）
    return jsonError(404, "device_not_found", "设备撤销失败：设备可能已被删除");
  }

  // 主动断开该设备已建立的 WebSocket 连接（如果 BridgeServer 在运行）
  // 开发/测试环境 getBridgeServer() 返回 null，跳过
  const bridge = getBridgeServer();
  if (bridge) {
    try {
      bridge.kickDevice(deviceId);
    } catch (error) {
      // kick 失败不阻断撤销流程——DB 已更新，设备重连时 handleAuth 会拦截
      logger.warn("[/api/desktop/devices/[deviceId]/revoke] kickDevice 失败", {
        deviceId,
        error: String(error),
      });
    }
  }

  return Response.json({
    ok: true,
    data: {
      deviceId: revoked.deviceId,
      name: revoked.name,
      status: revoked.status,
      revokedAt: revoked.revokedAt,
    },
  });
}

// GET 不支持（撤销是写操作）
export async function GET() {
  return jsonError(405, "method_not_allowed", "请使用 POST 方法");
}
