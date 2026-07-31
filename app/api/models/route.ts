import { fetchAvailableModels } from "@/lib/ai/models";
import { getCurrentUserFromRequest } from "@/lib/auth";
import { aiConfig } from "@/lib/config";
import { jsonError, jsonOk } from "@/lib/http";
import type { NextRequest } from "next/server";

/** GET /api/models → 过滤后的可用对话/代码模型列表 + 服务端默认模型。 */
export async function GET(request: NextRequest) {
  try {
    await getCurrentUserFromRequest(request);
  } catch {
    return jsonError(401, "unauthorized", "未授权");
  }
  const models = await fetchAvailableModels();
  return jsonOk({ models, defaultModel: aiConfig.chatModel });
}
