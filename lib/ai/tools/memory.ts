import { executeToolRun } from "@/lib/ai/tool-runtime";
import type { MemoryKind, MemoryScope } from "@/lib/db/schema";
import { createMemory } from "@/lib/memory/store";
import { tool } from "ai";
import { z } from "zod";

/**
 * V3.3b Stage D：长期记忆 agent 工具。
 *
 * rememberFact 经 executeToolRun 包裹（落 ToolRun + tool.* 事件，受权限引擎治理）。
 * - provenance 必填（agent 必须提供来源：当前 toolRun / 消息 / 用户）；无来源 → ok:false。
 * - scope 限 user/project/thread（agent 不写 skill）。
 * - 默认 allow（不 ask）：写 memory store 非破坏性、非 workspace、非网络；滥用靠 Studio 撤销治理。
 * - 去重：同 scope+kind+textHash → update 不 create，返回 deduplicated:true。
 *
 * 不自动写入对话（蓝图 §14）：只经此工具或 Studio curate 写入。
 */

const KINDS = ["preference", "convention", "decision", "failure", "command"] as const;
const SCOPES = ["user", "project", "thread"] as const;

export function buildMemoryTools(threadId: string) {
  return {
    rememberFact: tool({
      description:
        "把一条高信号、可复用的事实写入长期记忆（用户偏好/项目约定/架构决策/常见失败/常用命令）。" +
        "带来源、可审计、可撤销；不自动写入对话。provenance 必填（至少一条来源）。" +
        "scope=project 时 scopeRef 传 projectId（thread.projectId），写入后会被同 project 的 thread 检索召回。",
      inputSchema: z.object({
        kind: z.enum(KINDS).describe("记忆类型：preference/convention/decision/failure/command"),
        text: z.string().describe("记忆正文（高信号、可复用的事实）"),
        scope: z.enum(SCOPES).describe("作用域：user/project/thread（agent 不写 skill scope）"),
        scopeRef: z
          .string()
          .describe("作用域绑定 id（userId/projectId/threadId；project 用 thread.projectId）"),
        confidence: z.enum(["low", "medium", "high"]).optional().describe("置信度，默认 medium"),
        provenance: z
          .array(
            z.object({
              kind: z.enum(["tool_run", "message", "user"]),
              refId: z.string(),
              threadId: z.string().optional(),
              summary: z.string().optional(),
            }),
          )
          .min(1)
          .describe("来源（必填，至少一条）：当前 toolRun / 消息 / 用户"),
      }),
      execute: async ({ kind, text, scope, scopeRef, confidence, provenance }) => {
        try {
          return await executeToolRun(
            threadId,
            "rememberFact",
            { kind, text, scope, scopeRef, confidence, provenance } as Record<string, unknown>,
            async (_signal?: AbortSignal) => {
              try {
                const result = await createMemory({
                  scope: scope as MemoryScope,
                  scopeRef,
                  kind: kind as MemoryKind,
                  text,
                  provenance,
                  confidence: confidence ?? "medium",
                  createdByToolRunId: null,
                });
                // V3.3b Stage B：透传 semanticStatus（诚实反映 embedding 索引 disabled/stale/ready/error，
                // 不静默伪装成功）。记忆写入成功（ok:true）但语义索引失败时语义索引状态仍可见。
                return {
                  ok: true,
                  memoryId: result.memory.id,
                  deduplicated: result.deduplicated,
                  semanticStatus: result.semanticStatus,
                };
              } catch (error) {
                // provenance 校验失败等 → business failure（ok:false），不当 crash 传播
                return { ok: false, error: (error as Error).message };
              }
            },
          );
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
    }),
  };
}
