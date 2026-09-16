import { runtimeGatewayConfig } from "@/lib/config";
import type { ExecResult } from "@/lib/runtime/types";
import {
  ProviderExecutionError,
  type ProviderExecutionInput,
  readLimitedBody,
} from "./provider-execution";

export async function executeDesktopTool(
  input: ProviderExecutionInput,
): Promise<ExecResult & { workingDirectory: string }> {
  const baseUrl = runtimeGatewayConfig.publicBaseUrl;
  if (!input.attemptId || !baseUrl)
    throw new ProviderExecutionError(
      "DESKTOP_EXECUTION_UNAVAILABLE",
      "桌面执行网关未配置",
      "permanent",
      false,
    );
  if (!input.credential?.authorization) {
    throw new ProviderExecutionError(
      "DESKTOP_EXECUTION_UNAVAILABLE",
      "缺少当前 Execution Authority 凭据",
      "permanent",
      false,
    );
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/gateway/desktop-tool-executions`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: input.credential.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ toolCallId: input.toolCallId, attemptId: input.attemptId }),
      signal: AbortSignal.timeout(Math.min(input.timeoutMs, 30000) + 5000),
    });
  } catch {
    throw new ProviderExecutionError(
      "DESKTOP_GATEWAY_RESULT_UNKNOWN",
      "桌面执行网关连接中断，命令结果未知",
      "unknown_effect",
      true,
    );
  }
  let raw: unknown;
  try {
    raw = await readLimitedBody(response, input.responseMaxBytes);
  } catch {
    throw new ProviderExecutionError(
      "DESKTOP_RESULT_INVALID",
      "桌面命令结果无法完整读取",
      "unknown_effect",
      true,
    );
  }
  const body = (raw ?? {}) as {
    ok?: boolean;
    result?: ExecResult & { workingDirectory: string };
    code?: string;
    retryClass?: string;
    dispatched?: boolean;
  };
  if (!response.ok || !body.ok || !body.result)
    throw new ProviderExecutionError(
      body.code ?? "DESKTOP_EXECUTION_FAILED",
      "桌面命令执行失败",
      body.retryClass === "permanent" ? "permanent" : "unknown_effect",
      body.dispatched !== false,
    );
  if (
    typeof body.result.stdout !== "string" ||
    typeof body.result.stderr !== "string" ||
    typeof body.result.workingDirectory !== "string" ||
    (body.result.exitCode !== null && !Number.isInteger(body.result.exitCode))
  ) {
    throw new ProviderExecutionError(
      "DESKTOP_RESULT_INVALID",
      "桌面命令结果格式不完整",
      "unknown_effect",
      true,
    );
  }
  return body.result;
}
