import { fetchAvailableModels } from "@/lib/ai/models";
import { aiConfig } from "@/lib/config";
import {
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
} from "@/lib/conversations/route-helpers";
import { getRequestId, jsonOk } from "@/lib/http";
import type { NextRequest } from "next/server";

/** GET /api/models → 过滤后的可用对话/代码模型列表 + 服务端默认模型。 */
export async function GET(request: NextRequest) {
  const requestId = getRequestId(request);
  try {
    await resolveEmployeePrincipal(request.headers);
  } catch (error) {
    const authResponse = employeeAuthErrorResponse(error, requestId);
    if (authResponse) return authResponse;
    throw error;
  }
  const models = await fetchAvailableModels();
  return jsonOk({ models, defaultModel: aiConfig.chatModel });
}
