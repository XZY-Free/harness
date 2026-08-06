import { applyPatch as applyPatchPure, parsePatch } from "@/lib/ai/patch/apply";
import { executeToolRun } from "@/lib/ai/tool-runtime";
import type { RuntimeHandle } from "@/lib/runtime/types";
import { withPathLock } from "@/lib/workspace";
import { tool } from "ai";
import { z } from "zod";

/**
 * Stage D：编辑、patch 与删除工具（editFile / multiEditFile / applyPatch / deleteFile）。
 *
 * 全部经 `executeToolRun` 包裹（落 ToolRun + tool.* 事件，受权限引擎治理）。
 * - editFile：要求 oldString 唯一匹配，非唯一不写（对齐 Claude Code Edit 语义）。
 * - multiEditFile：顺序应用，任一非唯一则整体回滚（原子）。
 * - applyPatch：受约束 unified diff 子集，路径经 safeJoin，context 严格匹配。
 * - deleteFile：复用 workspace.delete；默认 ask（rules.ts）。
 *
 * 权限默认（rules.ts）：editFile=allow（write），multiEditFile/applyPatch/deleteFile=ask。
 */

/** 构造编辑与删除工具集（注入 threadId + runtime）。 */
export function buildFileEditTools(threadId: string, runtime: RuntimeHandle) {
 const { workspace } = runtime;

 return {
 editFile: tool({
 description:
 "对一个文件做局部替换：把唯一的 oldString 替换为 newString。" +
 "oldString 必须在文件中唯一匹配，否则不写并返回错误（请补充更多上下文）。用于最小 diff 编辑。",
 inputSchema: z.object({
 path: z.string().describe("相对工作区根的文件路径"),
 oldString: z.string().describe("要被替换的原文（必须在文件中唯一匹配）"),
 newString: z.string().describe("替换后的新文"),
 }),
 execute: async ({ path, oldString, newString }) => {
 try {
 return await executeToolRun(
 threadId,
 "editFile",
 { path, oldString, newString },
 async (signal) => {
 // : per-path 互斥锁（B3）—— read-modify-write 整体加锁，防并发丢失
 return withPathLock(`${threadId}:${path}`, async () => {
 try {
 const content = await workspace.read(path);
 if (content === null) return { ok: false, path, error: "文件不存在" };
 const count = countOccurrences(content, oldString);
 if (count === 0) {
 return { ok: false, path, error: "oldString 未在文件中找到" };
 }
 if (count > 1) {
 return {
 ok: false,
 path,
 error: `oldString 非唯一（匹配 ${count} 处），请提供更多上下文`,
 };
 }
 const next = content.replace(oldString, newString);
 await workspace.write(path, next);
 return {
 ok: true,
 path,
 changed: true,
 diffSummary: diffSummary(content, next),
 };
 } catch (error) {
 return { ok: false, path, error: (error as Error).message };
 }
 });
 },
 );
 } catch (error) {
 return { ok: false, path, error: (error as Error).message };
 }
 },
 }),

 multiEditFile: tool({
 description:
 "对一个文件顺序应用多处替换。任一 oldString 非唯一/未找到则整体回滚（原子，不写）。" +
 "用于一次提交多个相关编辑。",
 inputSchema: z.object({
 path: z.string().describe("相对工作区根的文件路径"),
 edits: z
 .array(
 z.object({
 oldString: z.string(),
 newString: z.string(),
 }),
 )
 .min(1)
 .describe("按顺序应用的替换列表"),
 }),
 execute: async ({ path, edits }) => {
 try {
 return await executeToolRun(
 threadId,
 "multiEditFile",
 { path, edits },
 async (signal) => {
 // : per-path 互斥锁（B3）—— 批量 read-modify-write 整体加锁
 return withPathLock(`${threadId}:${path}`, async () => {
 try {
 const original = await workspace.read(path);
 if (original === null) return { ok: false, path, error: "文件不存在" };
 let current = original;
 const applied: Array<{ oldString: string; ok: boolean; error?: string }> = [];
 for (const edit of edits) {
 const count = countOccurrences(current, edit.oldString);
 if (count === 0) {
 applied.push({
 oldString: edit.oldString,
 ok: false,
 error: "未找到",
 });
 return {
 ok: false,
 path,
 error: `第 ${applied.length} 条 oldString 未找到，整体回滚`,
 applied,
 };
 }
 if (count > 1) {
 applied.push({
 oldString: edit.oldString,
 ok: false,
 error: `非唯一(${count})`,
 });
 return {
 ok: false,
 path,
 error: `第 ${applied.length} 条 oldString 非唯一（${count} 处），整体回滚`,
 applied,
 };
 }
 current = current.replace(edit.oldString, edit.newString);
 applied.push({ oldString: edit.oldString, ok: true });
 }
 // 全部通过才写回（原子）
 await workspace.write(path, current);
 return {
 ok: true,
 path,
 changed: true,
 appliedCount: applied.length,
 diffSummary: diffSummary(original, current),
 };
 } catch (error) {
 return { ok: false, path, error: (error as Error).message };
 }
 });
 },
 );
 } catch (error) {
 return { ok: false, path, error: (error as Error).message };
 }
 },
 }),

 applyPatch: tool({
 description:
 "应用一个受约束的 unified diff patch（多文件局部改动）。路径必须在工作区内；" +
 "context 行严格匹配，不匹配则拒绝。任一 hunk 失败则整体不写（原子）。",
 inputSchema: z.object({
 patch: z.string().describe("unified diff 文本，含 ---/+++ 与 @@ hunk"),
 }),
 execute: async ({ patch }) => {
 try {
 return await executeToolRun(threadId, "applyPatch", { patch }, async (signal) => {
 try {
 // 先解析+校验路径（safeJoin），再读文件、应用、写回
 const parsed = parseAndCollectPaths(patch);
 // 校验路径不越界（safeJoin 抛错则拒绝）
 for (const p of parsed.paths) {
 workspace.safeJoin(p);
 }
 // 审计修复：per-path 互斥锁——applyPatch 的 read-modify-write 与 editFile/writeFile
 // 共享同一个锁，防止并发丢失更新。原实现中 applyPatch 未加锁，而 editFile 和
 // multiEditFile 已加锁（注释明确标注为"防并发丢失"修复），属于遗漏。
 const lockKeys = parsed.paths.map((p) => `${threadId}:${p}`);
 return await withPathLock(lockKeys[0] ?? `${threadId}:__patch__`, async () => {
 // 读取所有涉及文件
 const files: Record<string, string> = {};
 for (const p of parsed.paths) {
 const content = await workspace.read(p);
 if (content === null) {
 return { ok: false, patch, error: `文件不存在：${p}` };
 }
 files[p] = content;
 }
 const applied = applyPatchPure(patch, files);
 if (applied.errors.length > 0) {
 return {
 ok: false,
 patch,
 error: applied.errors.map((e) => `${e.path}: ${e.error}`).join("; "),
 errors: applied.errors,
 };
 }
 // 全部成功才写回（原子）
 const changedFiles: string[] = [];
 for (const r of applied.results) {
 if (r.changed) {
 await workspace.write(r.path, r.after);
 changedFiles.push(r.path);
 }
 }
 return {
 ok: true,
 changedFiles,
 diffSummary: applied.results
 .map((r) => `${r.path}: ${diffSummary(r.before, r.after)}`)
 .join("; "),
 };
 });
 } catch (error) {
 return { ok: false, patch, error: (error as Error).message };
 }
 });
 } catch (error) {
 return { ok: false, patch, error: (error as Error).message };
 }
 },
 }),

 deleteFile: tool({
 description: "删除工作区中的一个文件。删除不可逆，默认需审批（awaiting_approval）。",
 inputSchema: z.object({
 path: z.string().describe("相对工作区根的文件路径"),
 }),
 execute: async ({ path }) => {
 try {
 return await executeToolRun(threadId, "deleteFile", { path }, async (signal) => {
 try {
 const deleted = await workspace.delete(path);
 if (!deleted) return { ok: false, path, error: "文件不存在" };
 return { ok: true, path, deleted: true };
 } catch (error) {
 return { ok: false, path, error: (error as Error).message };
 }
 });
 } catch (error) {
 return { ok: false, path, error: (error as Error).message };
 }
 },
 }),
 };
}

// ─── helpers ────────────────────────────────────────────────

/** 统计 needle 在 haystack 中的非重叠出现次数。 */
function countOccurrences(haystack: string, needle: string): number {
 if (needle.length === 0) return 0;
 let count = 0;
 let from = 0;
 while (true) {
 const idx = haystack.indexOf(needle, from);
 if (idx === -1) break;
 count++;
 from = idx + needle.length;
 }
 return count;
}

/** 生成 before/after 的简易 diff 摘要（+N/-M 行）。 */
function diffSummary(before: string, after: string): string {
 const beforeLines = before.split("\n");
 const afterLines = after.split("\n");
 const added = afterLines.length - beforeLines.length;
 return `+${Math.max(0, added)}/-${Math.max(0, -added)} 行（before ${beforeLines.length} → after ${afterLines.length}）`;
}

/** 解析 patch 提取涉及路径（用于读文件 + 路径校验），不重复应用。 */
function parseAndCollectPaths(patch: string): { paths: string[] } {
 // 复用 apply.ts 的 parsePatch，消除两份路径解析逻辑。
 // file-edit.ts 已 import applyPatchPure（无循环依赖），parsePatch 抛错由上层 catch。
 const parsed = parsePatch(patch);
 const paths = new Set<string>();
 for (const hunk of parsed.hunks) {
 if (hunk.path) paths.add(hunk.path);
 }
 return { paths: [...paths] };
}
