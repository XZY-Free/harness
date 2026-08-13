import { executeToolRun } from "@/lib/ai/tool-runtime";
import type { RuntimeType } from "@/lib/config";
import type { BackgroundTaskKind } from "@/lib/db/schema";
import { relativeLogPath } from "@/lib/runtime/background-task-logs";
import {
  getTask,
  listByThread,
  markRunning,
  markStopped,
  readTaskLogs,
  registerStart,
} from "@/lib/runtime/background-task-registry";
import {
  type BackgroundCapableExecutionRuntime,
  ContainerExecutionRuntime,
} from "@/lib/runtime/execution-runtime";
import type { RuntimeHandle } from "@/lib/runtime/types";
import { tool } from "ai";
import { z } from "zod";

/**
 * Stage C：后台任务工具四件套（plan §7）。
 *
 * - startBackgroundTask：经 executeToolRun（权限引擎）；**start 调用立即返回 taskId**，
 * 长跑进程由 BackgroundTaskRegistry + ExecutionRuntime.startBackground 管理，不阻塞 chat。
 * - readTaskLogs：按 offset/tail/window 读取，限长 maxLogReadBytes，不把全量日志灌入上下文。
 * - stopBackgroundTask：调 registry.markStopped(reason=manual)（内部 tree-kill/pkill）。
 * - listBackgroundTasks：列当前 thread 任务。
 *
 * owner scope：read/stop 校验 taskId 属于当前 thread，防跨 thread 读/停。
 * runtimeType 从 execution 实例探测（container 降级 host 时与实际实现一致），供 registerStart
 * 解析日志路径。
 */

const KINDS = ["dev-server", "build", "watcher", "worker", "custom"] as const;

function detectRuntimeType(execution: unknown): RuntimeType {
  return execution instanceof ContainerExecutionRuntime ? "container" : "host";
}

/** 构造后台任务工具集（注入 threadId + runtime）。 */
export function buildCommandTaskTools(
  threadId: string,
  runtime: RuntimeHandle,
  runtimeType: RuntimeType | undefined,
) {
  // runtimeType 入参仅作日志参考；实际以 execution 实例探测为准（container 降级 host 时一致）
  void runtimeType;
  const bg = runtime.execution as unknown as BackgroundCapableExecutionRuntime;
  const execution = runtime.execution;

  return {
    startBackgroundTask: tool({
      description:
        "在后台启动一个长跑命令（如 dev server / watcher / worker），立即返回 taskId，不阻塞会话。" +
        "用于需要持续运行的进程；一次性命令请用 runCommand。可用 readTaskLogs 读日志、stopBackgroundTask 停止。",
      inputSchema: z.object({
        command: z
          .string()
          .describe("要在后台运行的 shell 命令，如 `npm run dev`、`vite build --watch`"),
        kind: z
          .enum(KINDS)
          .optional()
          .describe("任务种类：dev-server/build/watcher/worker/custom；默认 custom"),
      }),
      execute: async ({ command, kind }) => {
        const k = (kind ?? "custom") as BackgroundTaskKind;
        try {
          return await executeToolRun(
            threadId,
            "startBackgroundTask",
            { command, kind: k },
            async (signal) => {
              const rt = detectRuntimeType(execution);
              const { taskId } = await registerStart({
                threadId,
                kind: k,
                command,
                runtimeType: rt,
              });
              const logRel = relativeLogPath(threadId, taskId);
              const handle = await bg.startBackground(command, {
                taskId,
                threadId,
                logRelPath: logRel,
              });
              await markRunning(taskId, {
                pid: handle.pid,
                containerName: handle.containerName,
              });
              return { ok: true, taskId, kind: k, runtimeType: rt };
            },
          );
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    }),

    readTaskLogs: tool({
      description:
        "读取一个后台任务的日志片段（按 offset/tail/window），单次上限 64KB。用于查看 dev server 输出而不读全量。",
      inputSchema: z.object({
        taskId: z.string().describe("startBackgroundTask 返回的 taskId"),
        offset: z.number().int().min(0).optional().describe("起始字节偏移（默认 0）"),
        tail: z.number().int().min(1).optional().describe("返回最后 N 字节"),
        window: z.number().int().min(1).optional().describe("从 offset 起返回的窗口字节数"),
      }),
      execute: async ({ taskId, offset, tail, window }) => {
        try {
          return await executeToolRun(
            threadId,
            "readTaskLogs",
            { taskId, offset, tail, window },
            async (signal) => {
              const task = await getTask(taskId);
              if (!task) return { ok: false, error: "任务不存在" };
              if (task.threadId !== threadId) {
                return { ok: false, error: "任务不属于当前 thread" };
              }
              const r = await readTaskLogs(taskId, { offset, tail, window });
              if (!r) return { ok: false, error: "日志读取失败" };
              return {
                ok: true,
                content: r.content,
                totalBytes: r.totalBytes,
                truncated: r.truncated,
                offset: r.offset,
              };
            },
          );
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    }),

    stopBackgroundTask: tool({
      description:
        "停止一个后台任务并回收其进程树（host 模式 tree-kill 整组）。仅可停止当前 thread 的任务。",
      inputSchema: z.object({
        taskId: z.string().describe("要停止的后台任务 taskId"),
      }),
      execute: async ({ taskId }) => {
        try {
          return await executeToolRun(
            threadId,
            "stopBackgroundTask",
            { taskId },
            async (signal) => {
              const task = await getTask(taskId);
              if (!task) return { ok: false, error: "任务不存在" };
              if (task.threadId !== threadId) {
                return { ok: false, error: "任务不属于当前 thread" };
              }
              await markStopped(taskId, { reason: "manual" });
              return { ok: true, taskId, status: "stopped" };
            },
          );
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    }),

    listBackgroundTasks: tool({
      description: "列出当前 thread 的所有后台任务（id/种类/命令/状态/启动时间/端口）。",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return await executeToolRun(threadId, "listBackgroundTasks", {}, async (signal) => {
            const list = await listByThread(threadId);
            return {
              ok: true,
              tasks: list.map((t) => ({
                id: t.id,
                kind: t.kind,
                command: t.command,
                status: t.status,
                runtimeType: t.runtimeType,
                startedAt: t.startedAt,
                port: t.port,
              })),
            };
          });
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    }),
  };
}
