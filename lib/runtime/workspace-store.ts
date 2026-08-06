import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
 deleteWorkspaceFile,
 listWorkspaceFiles,
 readWorkspaceFile,
 workspaceRoot,
 safeJoin as workspaceSafeJoin,
 workspaceStat,
 writeWorkspaceFile,
} from "@/lib/workspace";
import { execInContainer } from "./container/docker-cli";
import { startContainer, touchActivity } from "./container/manager";
import type { GrepMatch, GrepResult, WorkspaceStore } from "./types";

/**
 * HostWorkspaceStore——`WorkspaceStore` 的宿主实现。
 *
 * 薄封装 `lib/workspace` 现有函数（零行为变更）：路径解析、读写删 stat list 全走宿主
 * 文件系统 + 既有的 safeJoin / symlink / realpath 安全边界。
 *
 * container 模式（Stage B）由 `ContainerWorkspaceStore` 提供第二实现；`root()` 仍返回
 * 宿主路径（平台进程读写经 bind mount 同步到容器），`mountTarget()` 返回 `/workspace`。
 *
 * glob/grep 优先走 `rg`（host 直接 execa；container 经 docker exec seam）。
 * rg 不可用（spawn ENOENT）时 fail-open 回退到 Node fs 实现（蓝图 §12 风险缓解），
 * 保证无 rg 主机仍可用；输出 shape 与 rg 路径一致。
 */
export class HostWorkspaceStore implements WorkspaceStore {
 constructor(protected readonly threadId: string) {}

 root(): string {
 return workspaceRoot(this.threadId);
 }

 safeJoin(relPath: string): string {
 return workspaceSafeJoin(this.threadId, relPath);
 }

 read(relPath: string): Promise<string | null> {
 return readWorkspaceFile(this.threadId, relPath);
 }

 write(relPath: string, content: string): Promise<string> {
 return writeWorkspaceFile(this.threadId, relPath, content);
 }

 delete(relPath: string): Promise<boolean> {
 return deleteWorkspaceFile(this.threadId, relPath);
 }

 stat(relPath: string) {
 return workspaceStat(this.threadId, relPath);
 }

 list(): Promise<string[]> {
 return listWorkspaceFiles(this.threadId);
 }

 async glob(pattern: string, opts?: { includeIgnored?: boolean }): Promise<string[]> {
 const args = buildGlobArgs(pattern, opts);
 const ran = await runRgHost(this.threadId, args);
 if (ran.enoent) {
 return nodeGlob(workspaceRoot(this.threadId), pattern, opts);
 }
 // rg --files 退出码 0（即使空）；非 0 视为无结果
 if (ran.exitCode !== 0) return [];
 return parseGlobStdout(ran.stdout);
 }

 async grep(
 pattern: string,
 opts?: { glob?: string; caseInsensitive?: boolean; context?: number; maxResults?: number },
 ): Promise<GrepResult> {
 const maxResults = opts?.maxResults ?? 50;
 const args = buildGrepArgs(pattern, opts);
 const ran = await runRgHost(this.threadId, args);
 if (ran.enoent) {
 return nodeGrep(workspaceRoot(this.threadId), pattern, opts);
 }
 // rg 无匹配 exit 1（正常）；exit 0 有匹配；exit 2 真错误
 if (ran.exitCode !== 0 && ran.exitCode !== 1) return { matches: [], truncated: false };
 return parseGrepJson(ran.stdout, maxResults);
 }

 /** host 模式：宿主即执行地，mountTarget 等同 root。 */
 mountTarget(): string {
 return this.root();
 }
}

/**
 * ContainerWorkspaceStore——容器模式的 WorkspaceStore。
 *
 * 读写仍走宿主文件系统（`lib/workspace`，经 bind mount 同步到容器）——平台进程是文件
 * 写入的唯一来源，容器内只读执行依赖。仅 `mountTarget()` 返回容器内路径 `/workspace`
 * （容器 exec 的 cwd），其余行为与 HostWorkspaceStore 一致。
 *
 * glob/grep override 为 `docker exec` 进容器跑 `rg`（经 docker-cli seam，复用
 * startContainer / touchActivity 生命周期）。容器镜像未装 rg 时返回空（不回退 Node，
 * 因宿主进程无法直接读容器内文件——镜像应保证 rg 可用，§12）。
 */
export class ContainerWorkspaceStore extends HostWorkspaceStore {
 override async glob(pattern: string, opts?: { includeIgnored?: boolean }): Promise<string[]> {
 const cmd = buildRgCommandString(buildGlobArgs(pattern, opts));
 const { stdout, exitCode } = await runRgContainer(this.threadId, cmd);
 if (exitCode !== 0) return [];
 return parseGlobStdout(stdout);
 }

 override async grep(
 pattern: string,
 opts?: { glob?: string; caseInsensitive?: boolean; context?: number; maxResults?: number },
 ): Promise<GrepResult> {
 const maxResults = opts?.maxResults ?? 50;
 const cmd = buildRgCommandString(buildGrepArgs(pattern, opts));
 const { stdout, exitCode } = await runRgContainer(this.threadId, cmd);
 if (exitCode !== 0 && exitCode !== 1) return { matches: [], truncated: false };
 return parseGrepJson(stdout, maxResults);
 }

 override mountTarget(): string {
 return "/workspace";
 }
}

// ─── rg 参数构建与输出解析（host / container 共享） ──────────

/** glob 的 rg 参数：`--files -g <pattern>`，默认尊重 .gitignore。 */
export function buildGlobArgs(pattern: string, opts?: { includeIgnored?: boolean }): string[] {
 const args = ["--files", "-g", pattern];
 if (opts?.includeIgnored) args.push("--no-ignore");
 return args;
}

/** grep 的 rg 参数：`--json -n <pattern> .`，按 opts 追加 -g/-i/-C。 */
export function buildGrepArgs(
 pattern: string,
 opts?: { glob?: string; caseInsensitive?: boolean; context?: number; maxResults?: number },
): string[] {
 const args = ["--json", "-n"];
 if (opts?.glob) args.push("-g", opts.glob);
 if (opts?.caseInsensitive) args.push("-i");
 if (typeof opts?.context === "number" && opts.context > 0) args.push("-C", String(opts.context));
 // 显式传入 "."，避免 rg 在无路径参数时从 stdin 读入并挂住测试/工具调用。
 args.push("--", pattern, ".");
 return args;
}

/** 把 rg 参数数组拼成容器内 shell 命令字符串（参数单引号转义）。 */
function buildRgCommandString(args: string[]): string {
 return `rg ${args.map(shellQuote).join(" ")}`;
}

function shellQuote(arg: string): string {
 return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** host：直接 execa rg（无 shell，避免 shell 展开 glob 模式），cwd 为工作区根。 */
async function runRgHost(
 threadId: string,
 args: string[],
): Promise<{ stdout: string; exitCode: number; enoent: boolean }> {
 try {
 const { execa } = await import("execa");
 const result = await execa("rg", args, {
 cwd: workspaceRoot(threadId),
 reject: false,
 timeout: 30_000,
 maxBuffer: 1024 * 1024,
 });
 // execa v9：spawn 级失败（ENOENT）时 result.code === "ENOENT"、exitCode undefined
 if (result.code === "ENOENT") {
 return { stdout: "", exitCode: -1, enoent: true };
 }
 return { stdout: result.stdout ?? "", exitCode: result.exitCode ?? -1, enoent: false };
 } catch {
 // 兜底：视为 rg 不可用
 return { stdout: "", exitCode: -1, enoent: true };
 }
}

/** container：经 docker-cli seam 在容器内跑 rg。 */
async function runRgContainer(
 threadId: string,
 command: string,
): Promise<{ stdout: string; exitCode: number }> {
 try {
 const entry = await startContainer(threadId);
 const result = await execInContainer(entry.containerName, command, { timeoutMs: 30_000 });
 touchActivity(threadId);
 return { stdout: result.stdout ?? "", exitCode: result.exitCode ?? -1 };
 } catch {
 return { stdout: "", exitCode: -1 };
 }
}

/** 解析 `rg --files` 的纯文本输出（每行一个相对路径）。 */
function parseGlobStdout(stdout: string): string[] {
 return stdout
 .split("\n")
 .map((l) => l.trim())
 .filter((l) => l.length > 0);
}

/** rg --json 中 path / lines 字段的 text 取值（二进制 bytes 时回退空串）。 */
function textOf(field: unknown): string {
 if (field && typeof field === "object" && "text" in field) {
 return String((field as { text: unknown }).text ?? "");
 }
 return "";
}

function normalizeRgPath(path: string): string {
 return path.replace(/^\.\//, "");
}

/**
 * 解析 `rg --json` 的 NDJSON 输出为结构化匹配。
 * - "match" → 一条 GrepMatch（带 before 上下文）
 * - "context" → 前置上下文归入下一条 match.before，或归入上一条 match.after
 * - 按 maxResults 截断，超出标记 truncated
 */
function parseGrepJson(stdout: string, maxResults: number): GrepResult {
 const matches: GrepMatch[] = [];
 let truncated = false;
 let before: Array<{ line: number; text: string }> = [];
 let lastMatch: GrepMatch | null = null;

 for (const line of stdout.split("\n")) {
 if (!line) continue;
 let entry: { type?: string; data?: Record<string, unknown> };
 try {
 entry = JSON.parse(line);
 } catch {
 continue;
 }
 if (!entry || !entry.type) continue;
 const d = entry.data ?? {};

 if (entry.type === "match") {
 if (matches.length >= maxResults) {
 truncated = true;
 break;
 }
 const m: GrepMatch = {
 path: normalizeRgPath(textOf(d.path)),
 line: Number(d.line_number ?? 0),
 text: textOf(d.lines).trimEnd(),
 before,
 after: [],
 };
 matches.push(m);
 lastMatch = m;
 before = [];
 } else if (entry.type === "context") {
 const c = { line: Number(d.line_number ?? 0), text: textOf(d.lines).trimEnd() };
 if (lastMatch && before.length === 0) {
 if (!lastMatch.after) lastMatch.after = [];
 lastMatch.after.push(c);
 } else {
 before.push(c);
 lastMatch = null;
 }
 }
 }

 return { matches, truncated };
}

// ─── Node fallback（rg 不可用时） ────────────────────────────
//
// rg 在主机缺失（如开发机仅装了 shell 包装、或精简运行环境）时回退到 Node fs 实现。
// 输出 shape 与 rg 路径一致；.gitignore 仅做基础尊重（目录名/简单 glob），非完整 gitignore 语义。

/** glob 模式 → RegExp（支持 * / ** / ?，不支持 brace 展开）。 */
/** glob 模式 → RegExp（支持 * / ** / ?，不支持 brace 展开）。逐字符扫描，无哨兵。 */
function globToRegex(glob: string): RegExp {
 let s = "";
 for (let i = 0; i < glob.length; i++) {
 const c = glob[i] ?? "";
 if (c === "*") {
 if (glob[i + 1] === "*") {
 if (glob[i + 2] === "/") {
 s += "(?:.*/)?";
 i += 2;
 } else {
 // P2-10:** 不带 / 时,仅当前面是 / 或起始才跨段(.*),否则当单 *(不跨段)。
 const prev = i > 0 ? glob[i - 1] : "";
 s += i === 0 || prev === "/" ? ".*" : "[^/]*";
 i += 1;
 }
 } else {
 s += "[^/]*";
 }
 continue;
 }
 if (c === "?") {
 s += "[^/]";
 continue;
 }
 if ("[.+^${}()|\\]".includes(c)) {
 s += `\\${c}`;
 continue;
 }
 s += c;
 }
 return new RegExp(`^${s}$`);
}

interface IgnoreRules {
 dirNames: Set<string>;
 globs: RegExp[];
}

function parseGitignore(content: string): IgnoreRules {
 const dirNames = new Set<string>();
 const globs: RegExp[] = [];
 for (const raw of content.split("\n")) {
 const line = raw.trim();
 if (!line || line.startsWith("#")) continue;
 if (line.endsWith("/")) {
 dirNames.add(line.slice(0, -1));
 } else if (line.includes("*") || line.includes("?")) {
 globs.push(globToRegex(line));
 } else {
 // 纯名：按段名跳过（近似 gitignore「匹配任意深度同名文件/目录」）
 dirNames.add(line);
 }
 }
 return { dirNames, globs };
}

function isIgnored(relPath: string, rules: IgnoreRules): boolean {
 const segments = relPath.split("/");
 for (const seg of segments) {
 if (rules.dirNames.has(seg)) return true;
 }
 for (const re of rules.globs) {
 if (re.test(relPath)) return true;
 }
 return false;
}

async function loadIgnore(root: string): Promise<IgnoreRules | null> {
 try {
 const content = await readFile(join(root, ".gitignore"), "utf8");
 return parseGitignore(content);
 } catch {
 return null;
 }
}

/** 递归列出工作区内文件（相对路径），跳过 .git/。 */
async function walkFiles(root: string): Promise<string[]> {
 const out: string[] = [];
 async function walk(dir: string) {
 let entries: Dirent[];
 try {
 entries = await readdir(dir, { withFileTypes: true });
 } catch {
 return;
 }
 for (const e of entries) {
 if (e.name === ".git") continue;
 const full = join(dir, e.name);
 if (e.isDirectory()) {
 await walk(full);
 } else if (e.isFile()) {
 out.push(relative(root, full));
 }
 }
 }
 await walk(root);
 return out;
}

async function nodeGlob(
 root: string,
 pattern: string,
 opts?: { includeIgnored?: boolean },
): Promise<string[]> {
 const files = await walkFiles(root);
 const ignore = opts?.includeIgnored ? null : await loadIgnore(root);
 const re = globToRegex(pattern);
 return files.filter((f) => re.test(f) && (ignore ? !isIgnored(f, ignore) : true)).sort();
}

async function nodeGrep(
 root: string,
 pattern: string,
 opts?: {
 glob?: string;
 caseInsensitive?: boolean;
 context?: number;
 maxResults?: number;
 },
): Promise<GrepResult> {
 const maxResults = opts?.maxResults ?? 50;
 // P2-8: 防 ReDoS——限制 pattern 长度 + 拒嵌套量词(如 (a+)+),Node fallback 无原生超时
 if (pattern.length > 200) {
 throw new Error("grep pattern 过长(>200 字符),Node fallback 拒绝执行");
 }
 if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) {
 throw new Error("grep pattern 含嵌套量词,可能 ReDoS,Node fallback 拒绝执行");
 }
 const globRe = opts?.glob ? globToRegex(opts.glob) : null;
 const re = new RegExp(pattern, opts?.caseInsensitive ? "i" : "");
 const ignore = await loadIgnore(root);
 const files = await walkFiles(root);
 const matches: GrepMatch[] = [];
 let truncated = false;
 const ctx = typeof opts?.context === "number" && opts.context > 0 ? opts.context : 0;

 for (const f of files) {
 if (truncated) break;
 if (globRe && !globRe.test(f)) continue;
 if (ignore && isIgnored(f, ignore)) continue;
 let content: string;
 try {
 content = await readFile(join(root, f), "utf8");
 } catch {
 continue;
 }
 const lines = content.split("\n");
 for (let i = 0; i < lines.length; i++) {
 const text = lines[i] ?? "";
 if (re.test(text)) {
 if (matches.length >= maxResults) {
 truncated = true;
 break;
 }
 const before = ctx > 0 ? sliceContext(lines, i - ctx, i - 1) : undefined;
 const after = ctx > 0 ? sliceContext(lines, i + 1, i + ctx) : undefined;
 matches.push({
 path: f,
 line: i + 1,
 text: text.trimEnd(),
 before,
 after,
 });
 }
 }
 }

 return { matches, truncated };
}

function sliceContext(
 lines: string[],
 from: number,
 to: number,
): Array<{ line: number; text: string }> {
 const out: Array<{ line: number; text: string }> = [];
 const start = Math.max(0, from);
 const end = Math.min(lines.length - 1, to);
 for (let i = start; i <= end; i++) {
 out.push({ line: i + 1, text: (lines[i] ?? "").trimEnd() });
 }
 return out;
}
