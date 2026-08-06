/**
 * 用户输入中的上下文命令解析（/clear + @file）。
 *
 * 纯函数：从用户消息文本中识别两类命令，返回结构化结果 + 清理后的文本。
 * - `/clear`：清空当前上下文（history 不注入模型，从这条消息起重新开始）。
 * 仅识别消息开头（首行）的 `/clear`，避免误伤正文里的 "/clear" 字样。
 * - `@file <path>`：引用工作区文件，路径注入到上下文（route 读取文件内容拼接）。
 * 匹配 `@file src/main.ts` 或 `@file:"src/main.ts"`；path 经 safeJoin 校验后由调用方读取。
 *
 * 命令不调 LLM、不触权限引擎（@file 读取走只读 workspace，read 类工具默认 allow 的同等信任）。
 */

export type ParsedContextCommands = {
 /** /clear 命令：调用方应跳过 history 注入，从本条消息起重置上下文。 */
 clear: boolean;
 /** @file 引用的相对路径列表（去重，保留出现顺序）。 */
 fileRefs: string[];
 /** 移除命令标记后的用户文本（保留正文语义）。 */
 cleanedText: string;
};

/** /clear 命令：开头 `/clear` + 紧随的空白（含换行），其余作为用户正文保留。 */
const CLEAR_RE = /^\s*\/clear\b\s*/i;

/** 解析用户输入文本中的 /clear 与 @file 命令。 */
export function parseContextCommands(input: string): ParsedContextCommands {
 const clear = CLEAR_RE.test(input);
 const cleanedText = input.replace(CLEAR_RE, "").trim();

 const fileRefs: string[] = [];
 const seen = new Set<string>();
 // @file 后跟空格 + 路径（支持引号包裹含空格路径）
 const re = /@file\s+(?:"([^"]+)"|'([^']+)'|(\S+))/gi;
 for (const m of input.matchAll(re)) {
 const path = (m[1] ?? m[2] ?? m[3] ?? "").trim();
 if (path.length > 0 && !seen.has(path)) {
 seen.add(path);
 fileRefs.push(path);
 }
 }
 // 从 cleanedText 中也移除 @file 标记（保留其余正文）
 const cleanedWithoutFiles = cleanedText
 .replace(re, "")
 .replace(/\s{2,}/g, " ")
 .trim();

 return { clear, fileRefs, cleanedText: cleanedWithoutFiles };
}
