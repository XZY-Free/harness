import { executeToolRun } from "@/lib/ai/tool-runtime";
import {
  type CustomToolDeclaration,
  executeScript,
  executeWebhook,
} from "@/lib/custom-tools/registry";
import { validateJsonSchema } from "@/lib/custom-tools/schema-validator";
import type { ToolApprovalRequest } from "@/lib/db/schema";
import type { PermissionRule, PermissionVerdict } from "@/lib/permission/engine";
import { evaluatePermission } from "@/lib/permission/engine";
import { type Tool, tool } from "ai";
import { z } from "zod";

/**
 * V3.4 Stage D：自定义工具注册进 buildTools（蓝图 §5.4）。
 *
 * 启用的自定义工具作为命名工具注入 buildTools；permissionKey = custom.<name>；
 * 默认 ask（自定义 executor 不可信，customEvaluate）。webhook executor 走域名 allowlist
 * + SSRF 防护；script executor 只跑白名单（registry 层强制）。
 *
 * buildCustomTools 同步：declarations 由调用方异步预加载后传入（保持 buildTools 同步、
 * 零回归；route 接线推迟）。空 declarations → 无自定义工具（零回归）。
 *
 * P1 修复（01 AI Core P1-7）：args 入口校验。原 inputSchema 是宽松的 args record,
 * executor 直接透传 args 给 webhook(script body / webhook JSON),模型可传任意结构
 * (含恶意大对象、嵌套爆炸)。现按体积/深度/键数约束校验,挡住结构性滥用。
 * 过渡期方案(不引 ajv):仅做结构性约束,与 budget.ts CJK 方案同思路。
 * 声明内的 JSON Schema 仍供 Studio 展示;此处不重复完整 JSON Schema 校验。
 */

/** P1-7：args 结构性约束上限。 */
const CUSTOM_ARGS_LIMITS = {
  maxBytes: 64 * 1024, // 序列化后 ≤64KB(webhook body 合理上限)
  maxDepth: 8, // 嵌套深度 ≤8(防嵌套爆炸)
  maxKeys: 256, // 总键数 ≤256(防宽平铺爆炸)
} as const;

/**
 * P1-7：校验自定义工具 args 的结构性约束(体积/深度/键数)。
 * @returns null 通过;否则错误描述。
 */
function validateCustomArgs(args: unknown): string | null {
  let keyCount = 0;
  let maxDepth = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: args, depth: 0 }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top) break;
    const { value, depth } = top;
    if (depth > maxDepth) maxDepth = depth;
    if (maxDepth > CUSTOM_ARGS_LIMITS.maxDepth) {
      return `args 嵌套深度超限(>${CUSTOM_ARGS_LIMITS.maxDepth})`;
    }
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else {
      const entries = Object.entries(value as Record<string, unknown>);
      keyCount += entries.length;
      if (keyCount > CUSTOM_ARGS_LIMITS.maxKeys) {
        return `args 键数超限(>${CUSTOM_ARGS_LIMITS.maxKeys})`;
      }
      for (const [, v] of entries) stack.push({ value: v, depth: depth + 1 });
    }
  }
  // 体积校验(序列化后);NaN/循环引用 → JSON.stringify 抛错或返 undefined,均拒绝
  let serialized: string;
  try {
    serialized = JSON.stringify(args);
  } catch {
    return "args 含循环引用,无法序列化";
  }
  if (typeof serialized !== "string") return "args 无法序列化";
  if (serialized.length > CUSTOM_ARGS_LIMITS.maxBytes) {
    return `args 体积超限(${serialized.length} > ${CUSTOM_ARGS_LIMITS.maxBytes} bytes)`;
  }
  return null;
}

/**
 * callCustomTool 的 `evaluate` 覆盖：默认 ask（自定义 executor 不可信）。
 * 合并 DB 规则 + `custom.*` → ask 默认规则（priority 0）；DB 规则可覆盖；ask 既定批准升级 allow。
 */
export function customEvaluate(args: {
  input: Record<string, unknown>;
  threadId: string;
  projectId?: string | null;
  permissionKey: string;
  dbRules: PermissionRule[];
  existingApprovals: ToolApprovalRequest[];
}): PermissionVerdict {
  const defaultAskRule: PermissionRule = {
    id: "default:custom:ask",
    scope: "global",
    scopeRef: null,
    toolPattern: "custom.*",
    argMatcher: null,
    decision: "ask",
    reason: "自定义工具默认需审批（executor 不可信）",
    priority: 0,
  };
  return evaluatePermission({
    toolName: "customTool",
    permissionKey: args.permissionKey,
    input: args.input,
    threadId: args.threadId,
    projectId: args.projectId ?? null,
    dbRules: [...args.dbRules, defaultAskRule],
    existingApprovals: args.existingApprovals,
  });
}

/** 派生 permissionKey：custom.<name>。 */
export function customPermissionKey(name: string): string {
  return `custom.${name}`;
}

/**
 * 构造自定义工具集（同步；declarations 由调用方预加载传入）。
 * 每个自定义工具一个 `tool()`，inputSchema 用 args record（声明内的 JSON Schema 供 Studio 展示，
 * 工具层不重复校验——校验是 executor 的职责）。
 */
export function buildCustomTools(
  threadId: string,
  declarations: CustomToolDeclaration[],
): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const decl of declarations) {
    const permissionKey = customPermissionKey(decl.name);
    out[decl.name] = tool({
      description: decl.description,
      inputSchema: z.object({
        args: z.record(z.string(), z.unknown()).optional().describe("工具参数"),
      }),
      execute: async ({ args = {} }) => {
        try {
          // P1 修复（01 AI Core P1-7 完整化）:两层校验。
          // 1) 结构性约束(体积/深度/键数):挡恶意大对象/嵌套爆炸/循环引用
          const argError = validateCustomArgs(args);
          if (argError !== null) {
            return { ok: false, tool: decl.name, error: `args 校验失败: ${argError}` };
          }
          // 2) JSON Schema 结构校验:挡结构不匹配(模型传 {foo:bar} 但工具要 {env:string})。
          //    用 decl.inputSchema(用户声明的 JSON Schema)校验 args,审计完整方案。
          const schemaErrors = validateJsonSchema(args, decl.inputSchema);
          if (schemaErrors.length > 0) {
            return {
              ok: false,
              tool: decl.name,
              error: `args 不符合声明 schema: ${schemaErrors.join("; ")}`,
            };
          }
          return await executeToolRun(
            threadId,
            decl.name,
            { args } as Record<string, unknown>,
            async (signal) => {
              if (decl.executorType === "webhook") {
                const r = await executeWebhook(
                  decl.executorConfig as {
                    url: string;
                    method: string;
                    headers?: Record<string, string>;
                  },
                  args,
                );
                if (!r.ok) return { ok: false, error: r.error, tool: decl.name };
                return { ok: true, tool: decl.name, content: r.content };
              }
              const scriptCfg = decl.executorConfig as { scriptId: string };
              const r = await executeScript(scriptCfg.scriptId, args);
              if (!r.ok) return { ok: false, error: r.error, tool: decl.name };
              return { ok: true, tool: decl.name, content: r.content };
            },
            { permissionKey, evaluate: customEvaluate },
          );
        } catch (error) {
          return { ok: false, tool: decl.name, error: (error as Error).message };
        }
      },
    });
  }
  return out;
}
