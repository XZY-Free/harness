import { executeToolRun, resolveToolTimeoutMs } from "@/lib/ai/tool-runtime";
import type { RuntimeType } from "@/lib/config";
import type { RuntimeHandle } from "@/lib/runtime/types";
import { tool } from "ai";
import { z } from "zod";

/**
 * V3.2 Stage D：工程命令工具 runBuild / installDependencies（plan §8）。
 *
 * - runBuild：默认 `npm run build`，经 executeToolRun，`execution.exec` 120s 扩展超时。
 *   risk=execute，permissionKey=tool.runBuild；走既有 command deny-list（rules.ts 把
 *   commandDenyList 镜像到 tool.runBuild deny），不强制 ask。
 * - installDependencies：默认 `npm install`，经 executeToolRun，180s 超时。
 *   risk=execute，permissionKey=tool.installDependencies；**默认 ask**（装包可执行 postinstall、
 *   改 lockfile、联网，高风险）。ask 暂停-恢复由 V3.1 权限引擎处理，批准后跑 runner。
 *
 * 两者经 executeToolRun 包裹，落 ToolRun + tool.* 事件，受白名单约束。
 */

/** 构造工程命令工具集（注入 threadId + runtime）。 */
export function buildCommandBuildTools(
  threadId: string,
  runtime: RuntimeHandle,
  _runtimeType: RuntimeType | undefined,
) {
  const { execution } = runtime;
  void _runtimeType;

  return {
    runBuild: tool({
      description:
        "运行项目构建命令（默认 npm run build），120 秒超时。用于产出可部署产物。" +
        "超时则返回失败，请拆分构建步骤或用 startBackgroundTask 后台跑长构建。",
      inputSchema: z.object({
        command: z.string().optional().describe("自定义构建命令；不传则用 npm run build"),
      }),
      execute: async ({ command }) => {
        const cmd = command ?? "npm run build";
        try {
          return await executeToolRun(threadId, "runBuild", { command: cmd }, async (signal) =>
            execution.exec(cmd, { timeoutMs: resolveToolTimeoutMs("runBuild"), signal }),
          );
        } catch (error) {
          return {
            ok: false,
            exitCode: -1,
            stdout: "",
            stderr: (error as Error).message,
            command: cmd,
          };
        }
      },
    }),

    installDependencies: tool({
      description:
        "安装项目依赖（默认 npm install）。会执行 postinstall 脚本、修改 lockfile、联网下载，" +
        "默认需人工审批；审批通过后执行，180 秒超时。",
      inputSchema: z.object({
        command: z
          .string()
          .optional()
          .describe("自定义安装命令；不传则按 packageManager 推导，如 npm install"),
        packageManager: z.enum(["npm", "pnpm", "yarn"]).optional().describe("包管理器，默认 npm"),
      }),
      execute: async ({ command, packageManager }) => {
        const cmd = command ?? `${packageManager ?? "npm"} install`;
        try {
          return await executeToolRun(
            threadId,
            "installDependencies",
            { command: cmd, packageManager: packageManager ?? "npm" },
            async (signal) =>
              execution.exec(cmd, {
                timeoutMs: resolveToolTimeoutMs("installDependencies"),
                signal,
              }),
          );
        } catch (error) {
          return {
            ok: false,
            exitCode: -1,
            stdout: "",
            stderr: (error as Error).message,
            command: cmd,
          };
        }
      },
    }),
  };
}
