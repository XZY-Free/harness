import { lstat, mkdir } from "node:fs/promises";
import { ContainerExecutionRuntime, HostExecutionRuntime } from "@/lib/runtime/execution-runtime";
import { workspaceRoot } from "@/lib/workspace";
import {
  ProviderExecutionError,
  type ProviderExecutionInput,
  type ProviderExecutionResult,
} from "./provider-executor";

export async function executeBuiltinShell(
  input: ProviderExecutionInput,
): Promise<ProviderExecutionResult> {
  const target = input.executionTarget;
  if (
    !target ||
    !input.threadId ||
    target.threadId !== input.threadId ||
    input.sideEffectMode !== "write"
  ) {
    throw new ProviderExecutionError(
      "EXECUTION_TARGET_INVALID",
      "命令缺少匹配的冻结执行环境",
      "permanent",
      false,
    );
  }
  if (typeof input.arguments.command !== "string" || !input.arguments.command.trim()) {
    throw new ProviderExecutionError(
      "BUILTIN_ARGUMENT_INVALID",
      "命令不能为空",
      "permanent",
      false,
    );
  }
  if (target.kind === "desktop") {
    const { executeDesktopTool } = await import("./desktop-tool-transport");
    const result = await executeDesktopTool(input);
    if (result.exitCode === null || result.exitCode === -1)
      throw new ProviderExecutionError(
        "COMMAND_OUTCOME_UNKNOWN",
        "桌面命令结果未知，不自动重试",
        "unknown_effect",
        true,
      );
    return {
      status: "succeeded",
      statusCode: 200,
      result: { ...result, executionEnvironment: "desktop", deviceId: target.deviceId },
      providerRequestRef: `desktop:${input.attemptId}`,
    };
  }
  if (workspaceRoot(input.threadId) !== target.workspaceRoot) {
    throw new ProviderExecutionError(
      "WORKSPACE_LOCATION_CHANGED",
      "工作区位置已变化，拒绝切换执行目录",
      "permanent",
      false,
    );
  }
  await mkdir(target.workspaceRoot, { recursive: true });
  if ((await lstat(target.workspaceRoot)).isSymbolicLink()) {
    throw new ProviderExecutionError(
      "WORKSPACE_LOCATION_INVALID",
      "工作区根目录不能是符号链接",
      "permanent",
      false,
    );
  }
  const runtime =
    target.kind === "container"
      ? new ContainerExecutionRuntime(input.threadId, target.quota, target.networkPolicy)
      : new HostExecutionRuntime(input.threadId, target.quota);
  const result = await runtime.exec(input.arguments.command, {
    timeoutMs: input.timeoutMs,
    logCapBytes: Math.floor(input.responseMaxBytes / 4),
  });
  // shell 已可能产生副作用；超时或无法确认退出不能自动重放。
  if (result.exitCode === null || result.exitCode === -1) {
    throw new ProviderExecutionError(
      "COMMAND_OUTCOME_UNKNOWN",
      "命令未取得确定退出状态，请检查执行结果后再决定是否重试",
      "unknown_effect",
      true,
    );
  }
  return {
    status: "succeeded",
    statusCode: 200,
    result: {
      ...result,
      executionEnvironment: target.kind,
      workingDirectory: target.kind === "container" ? "/workspace" : target.workspaceRoot,
    },
    providerRequestRef: null,
  };
}
