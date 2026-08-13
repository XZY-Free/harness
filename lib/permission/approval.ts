/**
 * 审批 fingerprint 计算、scope 匹配与 CRUD 查询封装（蓝图 / §12 ）。
 *
 * fingerprint 只取稳定维度（path 规范化、command 首 token、复杂 input 稳定 hash），
 * **不存原始 input**——避免审批请求表泄露完整 prompt/命令/patch 内容。
 *
 * CRUD 实际写入经 `@/lib/db/queries`，本模块作 facade 重组并提供纯函数 helper。
 */
import { createHash } from "node:crypto";
import {
  createApprovalRequest,
  findMatchingApprovals,
  getApprovalRequest,
  getPendingApprovalsByThread,
  getResolvedApprovalsByThread,
  resolveApprovalRequest,
} from "@/lib/db/queries";
import type { ApprovalScope, ToolApprovalRequest } from "@/lib/db/schema";

// 以 path 为 fingerprint 主维度的工具（input.path 为相对路径）。
const PATH_TOOLS = new Set([
  "writeFile",
  "readFile",
  "readFileRange",
  "listFiles",
  "editFile",
  "multiEditFile",
  "deleteFile",
  "statFile",
  "glob",
]);
// 以 command 首 token 为 fingerprint 主维度的工具。
// 追加 runBuild / installDependencies——installDependencies ask 后模型重试时 input 可能
// 变化（packageManager 等），取首 token（npm/pnpm/yarn）稳定，复用 fingerprint 规则（plan §12）。
const COMMAND_TOOLS = new Set(["runCommand", "runTests", "runBuild", "installDependencies"]);

/** 规范化相对路径：去前导 ./ 或 /，与 decideWrite 的 normalized 一致。 */
export function normalizePath(relPath: string): string {
  return relPath.replace(/^\.?\//, "");
}

/** 取 command 首 token（命令名），用于 fingerprint 与摘要。 */
export function firstCommandToken(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "";
  const i = trimmed.search(/\s/);
  return i === -1 ? trimmed : trimmed.slice(0, i);
}

/**
 * P1 修复（07 Permission ）：取 command 首 N 个 token,用于 fingerprint 细化。
 *
 * 原实现只取首 token(npm/pnpm),导致 `npm run evil` 与 `npm run build` 共用同一
 * fingerprint,批准一个就放行所有 `npm *`。现取首 2 token(如 `npm:run`),
 * 区分不同子命令。完整命令仍经 summarizeArgs 展示给审批者。
 */
export function firstCommandTokens(command: string, maxTokens = 2): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "";
  const tokens = trimmed.split(/\s+/).slice(0, maxTokens);
  return tokens.join(" ");
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** 稳定 JSON 序列化（对象 key 排序），用于复杂 input 的 fingerprint fallback。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * 计算 argFingerprint（稳定、不存原始 input）。
 *
 * - path 工具 → `path:<normalized>`
 * - applyPatch → `patch:<sha(patch)>`（patch 内容多文件，取 hash）
 * - command 工具 → `cmd:<首2token:sha(完整命令)>`（P1 修复:原只首 token 过粗,
 * `npm run evil` 与 `npm run build` 共用 fingerprint。现取首2token + 完整命令 hash,
 * 既区分子命令又防首2token 碰撞。完整命令经 summarizeArgs 展示给审批者)
 * - 其余 → `args:<sha(stableStringify(input))>`
 */
export function computeArgFingerprint(
  permissionKey: string,
  input: Record<string, unknown>,
): string {
  const toolName = permissionKey.replace(/^tool\./, "");
  if (toolName === "applyPatch" && typeof input.patch === "string") {
    return `patch:${sha(input.patch)}`;
  }
  if (PATH_TOOLS.has(toolName) && typeof input.path === "string") {
    return `path:${normalizePath(input.path)}`;
  }
  if (COMMAND_TOOLS.has(toolName) && typeof input.command === "string") {
    // P1 修复:首2token(子命令区分) + 完整命令 hash(防碰撞 + 保留粒度)
    const prefix = firstCommandTokens(input.command, 2);
    return `cmd:${prefix}:${sha(input.command)}`;
  }
  return `args:${sha(stableStringify(input))}`;
}

/**
 * 人可读 arg 摘要（不存完整 input）。用于审批面板展示与事件 payload。
 * 长度截断到 480 字符（argSummary 列 512）。
 */
export function summarizeArgs(toolName: string, input: Record<string, unknown>): string {
  let summary: string;
  if (toolName === "applyPatch" && typeof input.patch === "string") {
    summary = `patch (${input.patch.length} chars)`;
  } else if (PATH_TOOLS.has(toolName) && typeof input.path === "string") {
    summary = `path=${normalizePath(input.path)}`;
  } else if (COMMAND_TOOLS.has(toolName) && typeof input.command === "string") {
    // P1 修复（07 ）：审批展示完整命令(原只展示首 token,审批者看不到完整命令)。
    // 完整命令让审批者判断风险(如 `npm run evil` vs `npm run build`)。
    // 截断到 480 字符(argSummary 列 512,留余量给 `command=` 前缀)。
    summary = `command=${input.command}`;
  } else {
    summary = stableStringify(input);
  }
  return summary.length > 480 ? `${summary.slice(0, 477)}...` : summary;
}

/**
 * 判断一条已批准的 approval 是否对当前 (threadId, projectId) 适用（scope 匹配纯函数）。
 *
 * scope 语义：
 * - always → 全局复用
 * - thread → 仅同 threadId
 * - project → thread 无 projectId 维度，按 thread 收敛（后续补 project 后放宽）
 * - once → 仅同 thread 的恢复重试可用；由 executeToolRun 消费后标 superseded
 *
 * @param approval - 已批准的审批请求（status=approved）
 * @param ctx - 当前调用的 threadId / projectId
 */
export function isApprovalApplicable(
  approval: ToolApprovalRequest,
  ctx: { threadId: string; projectId?: string | null },
): boolean {
  switch (approval.approvedScope) {
    case "always":
      return true;
    case "once":
      return approval.threadId === ctx.threadId;
    case "thread":
      return approval.threadId === ctx.threadId;
    // project scope 按 projectId 匹配，允许跨 thread 复用
    case "project":
      return (
        approval.projectId !== null && ctx.projectId != null && approval.projectId === ctx.projectId
      );
    case "session":
      // session scope = 同 thread + 未过期（短 TTL 由 expiresAt 控制，区别于 thread 永久）
      return approval.threadId === ctx.threadId;
    default:
      return false;
  }
}

/** 审批请求是否已过期（expiresAt 早于 now）。null expiresAt 视为永不过期。 */
export function isApprovalExpired(approval: ToolApprovalRequest, now: Date = new Date()): boolean {
  return approval.expiresAt !== null && approval.expiresAt.getTime() < now.getTime();
}

// ─── CRUD facade（透传 queries，供 tool-runtime / API 统一入口） ──

export {
  createApprovalRequest,
  findMatchingApprovals,
  getApprovalRequest,
  getPendingApprovalsByThread,
  getResolvedApprovalsByThread,
  resolveApprovalRequest,
};

export type { ApprovalScope, ToolApprovalRequest };
