import { executeToolRun } from "@/lib/ai/tool-runtime";
import type { GrepMatch, RuntimeHandle } from "@/lib/runtime/types";
import { tool } from "ai";
import { z } from "zod";

/**
 * Stage C：读与搜索工具（readFileRange / statFile / glob / grep）。
 *
 * 全部经 `executeToolRun` 包裹（落 ToolRun + tool.* 事件，受权限引擎治理）。
 * read 类工具 risk=read，默认 allow；glob/grep 启动 rg 进程但仍是只读。
 * 输出结构化、限长，避免把全仓内容灌入上下文。
 */

/**
 * 按总字符上限截断 grep 匹配结果。
 *
 * 累计每条 match 的 path/text/before/after 字符数，超 maxChars 时丢弃后续条目并标记截断。
 * 单条超长也保留（至少返回首条，避免空结果误导），但其后不再追加。
 */
function capGrepOutput(
 matches: GrepMatch[],
 maxChars: number,
): { matches: GrepMatch[]; outputTruncated: boolean } {
 let used = 0;
 const out: GrepMatch[] = [];
 for (const m of matches) {
 const size =
 m.path.length +
 m.text.length +
 (m.before?.reduce((s, c) => s + c.text.length, 0) ?? 0) +
 (m.after?.reduce((s, c) => s + c.text.length, 0) ?? 0);
 // 首条强制保留（即使超长），后续超预算则截断
 if (out.length > 0 && used + size > maxChars) {
 return { matches: out, outputTruncated: true };
 }
 out.push(m);
 used += size;
 }
 return { matches: out, outputTruncated: false };
}

/** readFileRange 单次最大返回行数，防止读超大文件撑爆上下文。 */
const MAX_RANGE_LINES = 2000;
/** glob 最大返回路径数。 */
const MAX_GLOB_RESULTS = 500;
/**
 * grep 输出总字符上限。
 * 原 context 上限 10 + maxResults 200 仍可能产出 200×11 行超大输出灌入上下文。
 * 在结果体积超此上限时按匹配条目截断，标记 truncated。
 */
const MAX_GREP_OUTPUT_CHARS = 20_000;

/** 构造读与搜索工具集（注入 threadId + runtime）。 */
export function buildFileSearchTools(threadId: string, runtime: RuntimeHandle) {
 const { workspace } = runtime;

 return {
 readFileRange: tool({
 description:
 "读取工作区中一个文件的指定行范围（带行号）。用于查看大文件的局部内容而不读取全文。" +
 "startLine/endLine 为 1-based 闭区间；endLine 省略时读到文件末尾。",
 inputSchema: z.object({
 path: z.string().describe("相对工作区根的文件路径，如 src/main.ts"),
 startLine: z.number().int().min(1).describe("起始行号（1-based，含）"),
 endLine: z
 .number()
 .int()
 .min(1)
 .optional()
 .describe("结束行号（1-based，含）；省略读到末尾"),
 }),
 execute: async ({ path, startLine, endLine }) => {
 try {
 return await executeToolRun(
 threadId,
 "readFileRange",
 { path, startLine, endLine },
 async (_signal?: AbortSignal) => {
 try {
 const content = await workspace.read(path);
 if (content === null) return { ok: false, path, error: "文件不存在" };
 const lines = content.split("\n");
 if (startLine > lines.length) {
 return {
 ok: false,
 path,
 error: `startLine ${startLine} 超出文件总行数 ${lines.length}`,
 };
 }
 const end = endLine ?? lines.length;
 if (end < startLine) {
 return { ok: false, path, error: `endLine ${end} 小于 startLine ${startLine}` };
 }
 const cappedEnd = Math.min(end, startLine + MAX_RANGE_LINES - 1);
 const truncated = cappedEnd < end;
 const slice = lines.slice(startLine - 1, cappedEnd);
 const numbered = slice.map((text, i) => `${startLine + i}\t${text}`).join("\n");
 return {
 ok: true,
 path,
 startLine,
 endLine: cappedEnd,
 truncated,
 content: numbered,
 };
 } catch (error) {
 return { ok: false, path, error: (error as Error).message };
 }
 },
 );
 } catch (error) {
 return { ok: false, path, error: (error as Error).message };
 }
 },
 }),

 statFile: tool({
 description: "查看工作区中一个文件的大小、修改时间、是否目录。用于判断文件是否存在或类型。",
 inputSchema: z.object({
 path: z.string().describe("相对工作区根的文件路径"),
 }),
 execute: async ({ path }) => {
 try {
 return await executeToolRun(
 threadId,
 "statFile",
 { path },
 async (_signal?: AbortSignal) => {
 try {
 const s = await workspace.stat(path);
 if (s === null) return { ok: false, path, error: "文件不存在" };
 return {
 ok: true,
 path,
 size: s.size,
 mtime: s.mtime.toISOString(),
 isDirectory: s.isDirectory,
 };
 } catch (error) {
 return { ok: false, path, error: (error as Error).message };
 }
 },
 );
 } catch (error) {
 return { ok: false, path, error: (error as Error).message };
 }
 },
 }),

 glob: tool({
 description:
 "按 glob 模式匹配工作区内文件路径（如 **/*.ts、src/**/*.test.js）。默认尊重 .gitignore。" +
 "返回相对路径列表，用于定位文件而不读内容。",
 inputSchema: z.object({
 pattern: z.string().describe("glob 模式，如 **/*.ts、src/**/*.{js,ts}"),
 includeIgnored: z
 .boolean()
 .optional()
 .describe("是否包含被 .gitignore 忽略的文件，默认 false"),
 }),
 execute: async ({ pattern, includeIgnored }) => {
 try {
 return await executeToolRun(
 threadId,
 "glob",
 { pattern, includeIgnored },
 async (_signal?: AbortSignal) => {
 try {
 const files = await workspace.glob(pattern, { includeIgnored });
 const truncated = files.length > MAX_GLOB_RESULTS;
 return {
 ok: true,
 pattern,
 files: files.slice(0, MAX_GLOB_RESULTS),
 truncated,
 total: files.length,
 };
 } catch (error) {
 return { ok: false, pattern, error: (error as Error).message };
 }
 },
 );
 } catch (error) {
 return { ok: false, pattern, error: (error as Error).message };
 }
 },
 }),

 grep: tool({
 description:
 "在工作区文件内容中搜索正则，返回结构化匹配（path/line/text）。默认尊重 .gitignore。" +
 "用于在不读全文件的情况下定位代码。结果按 maxResults 截断并标记 truncated。",
 inputSchema: z.object({
 pattern: z.string().describe("正则表达式，如 function\\s+foo、TODO"),
 glob: z.string().optional().describe("限定搜索文件 glob，如 *.ts"),
 caseInsensitive: z.boolean().optional().describe("是否大小写不敏感，默认 false"),
 // P2 修复(01 AI Core P2-5): context 加上限(10),防 context:50 maxResults:200 产出 10000+ 行。
 context: z
 .number()
 .int()
 .min(0)
 .max(10)
 .optional()
 .describe("上下文行数（-C），默认 0，上限 10"),
 maxResults: z.number().int().min(1).max(200).optional().describe("最大匹配数，默认 50"),
 }),
 execute: async ({ pattern, glob, caseInsensitive, context, maxResults }) => {
 try {
 return await executeToolRun(
 threadId,
 "grep",
 { pattern, glob, caseInsensitive, context, maxResults },
 async (_signal?: AbortSignal) => {
 try {
 const result = await workspace.grep(pattern, {
 glob,
 caseInsensitive,
 context,
 maxResults,
 });
 // 输出总字符上限截断，防 context×maxResults 组合产出超大输出。
 const { matches, outputTruncated } = capGrepOutput(
 result.matches,
 MAX_GREP_OUTPUT_CHARS,
 );
 return {
 ok: true,
 pattern,
 matches,
 truncated: result.truncated || outputTruncated,
 };
 } catch (error) {
 return { ok: false, pattern, error: (error as Error).message };
 }
 },
 );
 } catch (error) {
 return { ok: false, pattern, error: (error as Error).message };
 }
 },
 }),
 };
}
