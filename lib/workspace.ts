import { createWriteStream } from "node:fs";
import {
 writeFile as fsWriteFile,
 lstat,
 mkdir,
 readFile,
 readdir,
 realpath,
 rename,
 unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { workspaceConfig } from "@/lib/config";

/**
 * 会话工作区：每个 thread 一个独立目录 workspaces/{threadId}/，存放生成的用户项目。
 * 目录已被 git 忽略（运行时产物）。PreviewManager 会在这里起预览进程。
 *
 * Runtime 责任面（蓝图 ）：本模块是 `WorkspaceStore` 责任面的当前唯一实现——
 * 负责工作区路径解析与文件读写。按「从轻、不造空壳」处理：
 * 当前仅单一实现，抽 TS interface 纯属 indirection 噪音（），故接口抽象
 * 推迟到 Phase 5——待第二个 runtime 实现（dev-server / 容器）出现时再抽稳定接口。
 *
 * 补 read / delete / stat，并硬化 write 的安全边界。
 * 四个文件入口全过 `safeJoin`（词法边界，拒 `..`）+ symlink/realpath 防护：
 * - 逐段 `lstat`：任何已存在路径段是符号链接 → throw（workspace 内 symlink 一律拒绝参与读写删 stat）。
 * - `realpath` 防御：确认真实路径仍在 `realpath(workspaceRoot)` 下，兜底 root 自身被 symlink 化等场景。
 * 越界 / symlink / 删目录 → throw `WorkspacePathError`，API 层转 400。
 */

/** 工作区路径安全错误（越界 / symlink / 非法操作）。API 层 catch → 400。 */
export class WorkspacePathError extends Error {}

/**
 * threadId 合法格式：UUID 与等价字母数字-串。
 *
 * threadId 直接拼入 `workspaceRoot = join(base, threadId)` 与容器 shell 命令
 * (`mkdir -p /workspace/.snow/runtime/${threadId}`)。若允许 `..` / `/` / shell 元字符，
 * `join` 会解析 `..` 逃逸 workspaces 根,且 `safeJoin` / `assertRealPathInsideWorkspace`
 * 的边界锚点基于已污染的 root,两层防御同时失效 → 任意文件读写 + 容器内命令注入。
 *
 * 故在所有 client 可控入口(chat/threads POST body.id)与 `workspaceRoot` 汇点双重校验。
 */
const THREAD_ID_RE = /^[a-zA-Z0-9-]+$/;

export function isValidThreadId(threadId: string): boolean {
 return (
 typeof threadId === "string" &&
 threadId.length > 0 &&
 threadId.length <= 64 &&
 THREAD_ID_RE.test(threadId)
 );
}

export function assertValidThreadId(threadId: string): void {
 if (!isValidThreadId(threadId)) {
 throw new WorkspacePathError(`非法 threadId：${threadId}`);
 }
}

/** 获取工作区根目录（惰性求值，支持运行时配置覆盖和测试注入）。 */
function getRoot(): string {
 return workspaceConfig.root;
}

function workspaceBaseRoot(): string {
 const root = getRoot();
 if (isAbsolute(root)) return root;
 return join(/*turbopackIgnore: true*/ process.cwd(), root);
}

export function workspaceRoot(threadId: string): string {
 assertValidThreadId(threadId);
 return join(/*turbopackIgnore: true*/ workspaceBaseRoot(), threadId);
}

/** 安全解析工作区内路径，拒绝 `..` 越界。 */
export function safeJoin(threadId: string, relPath: string): string {
 const root = workspaceRoot(threadId);
 const target = resolve(/*turbopackIgnore: true*/ root, relPath);
 if (target !== root && !target.startsWith(root + sep)) {
 throw new WorkspacePathError(`非法路径（越界工作区）：${relPath}`);
 }
 return target;
}

async function getSafeWorkspaceRoot(
 threadId: string,
 opts: { create: boolean },
): Promise<string | null> {
 const root = workspaceRoot(threadId);
 const st = await lstat(/*turbopackIgnore: true*/ root).catch(() => null);
 if (st?.isSymbolicLink()) {
 throw new WorkspacePathError(`非法路径（workspace 根为符号链接）：${threadId}`);
 }
 if (!st) {
 if (!opts.create) return null;
 await mkdir(/*turbopackIgnore: true*/ root, { recursive: true });
 const created = await lstat(/*turbopackIgnore: true*/ root).catch(() => null);
 if (created?.isSymbolicLink()) {
 throw new WorkspacePathError(`非法路径（workspace 根为符号链接）：${threadId}`);
 }
 }
 return root;
}

/**
 * realpath 防御：确认 target（不存在时退到父目录）的真实路径仍在工作区真实根下。
 * root 不存在时先 `mkdir(root, { recursive: true })`，避免 realpath 失败。
 */
async function assertRealPathInsideWorkspace(threadId: string, target: string): Promise<void> {
 const root = await getSafeWorkspaceRoot(threadId, { create: true });
 if (!root) throw new WorkspacePathError(`非法路径（workspace 根不存在）：${threadId}`);
 const realRoot = await realpath(/*turbopackIgnore: true*/ root);
 const exists = await lstat(/*turbopackIgnore: true*/ target).catch(() => null);
 const probe = exists ? target : dirname(/*turbopackIgnore: true*/ target);
 const realProbe = await realpath(/*turbopackIgnore: true*/ probe).catch(() => null);
 if (realProbe && realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
 throw new WorkspacePathError(`非法路径（越界工作区）：${target}`);
 }
}

/**
 * 逐段 `lstat` 校验：任何已存在路径段是符号链接 → throw。
 * - `allowMissingLeaf=true`（write）：leaf 可不存在，但已存在的段不得是 symlink。
 * - `allowMissingLeaf=false`（read/delete/stat）：leaf 不存在时由调用方按 ENOENT 语义处理；
 * 本函数只在「已存在」的段上拒绝 symlink。
 * 校验后过 `assertRealPathInsideWorkspace` 兜底。
 */
async function assertNoSymlinkPath(
 threadId: string,
 relPath: string,
 opts: { allowMissingLeaf: boolean },
): Promise<string> {
 const target = safeJoin(threadId, relPath);
 const root = await getSafeWorkspaceRoot(threadId, { create: true });
 if (!root) throw new WorkspacePathError(`非法路径（workspace 根不存在）：${threadId}`);
 const segments = relPath.split(/[\\/]/).filter(Boolean);
 let cur = root;
 for (const seg of segments) {
 cur = join(/*turbopackIgnore: true*/ cur, seg);
 const st = await lstat(/*turbopackIgnore: true*/ cur).catch(() => null);
 if (!st) break; // 该段不存在：深层更不存在，停止；ENOENT 由调用方处理
 if (st.isSymbolicLink()) {
 throw new WorkspacePathError(`非法路径（含符号链接）：${relPath}`);
 }
 }
 // allowMissingLeaf 仅用于语义标注；本函数对「已存在」的 symlink 一律拒绝，与 leaf 是否允许缺失无关。
 void opts;
 await assertRealPathInsideWorkspace(threadId, target);
 return target;
}

function isEnoent(err: unknown): boolean {
 return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * 写入/覆盖工作区文件（自动建父目录），返回相对路径。
 * 安全：safeJoin → 逐段 lstat 拒 symlink → realpath 校验父目录 → mkdir 父目录 →
 * 再次 realpath 校验父目录（mkdir 后仍不得越界）→ 写入。
 */
export async function writeWorkspaceFile(
 threadId: string,
 relPath: string,
 content: string,
): Promise<string> {
 const target = await assertNoSymlinkPath(threadId, relPath, { allowMissingLeaf: true });
 const parent = dirname(/*turbopackIgnore: true*/ target);
 await mkdir(/*turbopackIgnore: true*/ parent, { recursive: true });
 await assertRealPathInsideWorkspace(threadId, parent);
 // : 原子写入（B3）—— 先写临时文件再 rename，防崩溃留下半写文件
 const tmpFile = `${target}.tmp.${Date.now()}`;
 await fsWriteFile(/*turbopackIgnore: true*/ tmpFile, content, "utf8");
 await rename(/*turbopackIgnore: true*/ tmpFile, /*turbopackIgnore: true*/ target);
 return relPath;
}

/**
 * 二进制写入（图片等）。同 writeWorkspaceFile 的安全保证（safeJoin / symlink / realpath / 原子 rename），
 * 仅内容类型为 Buffer。供 upload 路由把图片写入 thread workspace。
 */
export async function writeWorkspaceFileBytes(
 threadId: string,
 relPath: string,
 content: Buffer,
): Promise<string> {
 const target = await assertNoSymlinkPath(threadId, relPath, { allowMissingLeaf: true });
 const parent = dirname(/*turbopackIgnore: true*/ target);
 await mkdir(/*turbopackIgnore: true*/ parent, { recursive: true });
 await assertRealPathInsideWorkspace(threadId, parent);
 const tmpFile = `${target}.tmp.${Date.now()}`;
 await fsWriteFile(/*turbopackIgnore: true*/ tmpFile, content);
 await rename(/*turbopackIgnore: true*/ tmpFile, /*turbopackIgnore: true*/ target);
 return relPath;
}

/**
 * : per-path 互斥锁（B3）—— 防并发 editFile 丢失改动。
 * 同 path 的写操作串行执行，不同 path 并发无影响。
 * 锁粒度为绝对路径，Map 在 fn 完成后自动清理。
 *
 * 修复竞态：使用 promise 链式排队代替 check-then-act，
 * 确保同一 path 的并发请求严格串行，不会出现两个 caller 同时抢到锁的情况。
 */
const pathLocks = new Map<string, Promise<unknown>>();

export async function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
 const prev = pathLocks.get(path) ?? Promise.resolve();
 let releaseLock!: () => void;
 const next = new Promise<void>((resolve) => {
 releaseLock = resolve;
 });
 // 原子地链入队列：无论 prev 是否已 resolve，本 caller 排在队尾
 pathLocks.set(path, next);
 try {
 await prev;
 return await fn();
 } finally {
 // 仅当自己是队尾时才清理 Map 条目，避免清除后续 caller 的 promise
 if (pathLocks.get(path) === next) pathLocks.delete(path);
 releaseLock();
 }
}

/** 读工作区文件内容；不存在返回 null（API 层转 404）。symlink / 越界 → throw。 */
export async function readWorkspaceFile(threadId: string, relPath: string): Promise<string | null> {
 const target = await assertNoSymlinkPath(threadId, relPath, { allowMissingLeaf: false });
 try {
 return await readFile(/*turbopackIgnore: true*/ target, "utf8");
 } catch (err) {
 if (isEnoent(err)) return null;
 throw err;
 }
}

/**
 * V5-B2：读工作区文件原始字节；不存在返回 null。
 * 用于前台 raw mode（图片 / 字体 / PDF 等二进制资源直接由浏览器加载，
 * 跳过 JSON utf-8 编码避免二进制破坏）。symlink / 越界 → throw。
 */
export async function readWorkspaceFileBytes(
 threadId: string,
 relPath: string,
): Promise<NodeJS.ArrayBufferView | null> {
 const target = await assertNoSymlinkPath(threadId, relPath, { allowMissingLeaf: false });
 try {
 return await readFile(/*turbopackIgnore: true*/ target);
 } catch (err) {
 if (isEnoent(err)) return null;
 throw err;
 }
}

/**
 * V5-B2：按扩展名映射常见 MIME 类型（用于 raw mode 响应 Content-Type）。
 * 不引 mime-types 依赖——前台 raw 资源类型有限，自维护一份小表足够。
 * 未命中扩展名默认 application/octet-stream（浏览器按 URL 推断或下载）。
 */
const MIME_BY_EXT: Record<string, string> = {
 ".html": "text/html; charset=utf-8",
 ".htm": "text/html; charset=utf-8",
 ".css": "text/css; charset=utf-8",
 ".js": "text/javascript; charset=utf-8",
 ".mjs": "text/javascript; charset=utf-8",
 ".ts": "text/typescript; charset=utf-8",
 ".jsx": "text/javascript; charset=utf-8",
 ".tsx": "text/typescript; charset=utf-8",
 ".json": "application/json; charset=utf-8",
 ".md": "text/markdown; charset=utf-8",
 ".markdown": "text/markdown; charset=utf-8",
 ".txt": "text/plain; charset=utf-8",
 ".svg": "image/svg+xml",
 ".png": "image/png",
 ".jpg": "image/jpeg",
 ".jpeg": "image/jpeg",
 ".gif": "image/gif",
 ".webp": "image/webp",
 ".avif": "image/avif",
 ".ico": "image/x-icon",
 ".bmp": "image/bmp",
 ".pdf": "application/pdf",
 ".woff": "font/woff",
 ".woff2": "font/woff2",
 ".ttf": "font/ttf",
 ".otf": "font/otf",
 ".eot": "application/vnd.ms-fontobject",
 ".map": "application/json; charset=utf-8",
 ".xml": "application/xml; charset=utf-8",
 ".yaml": "text/yaml; charset=utf-8",
 ".yml": "text/yaml; charset=utf-8",
 ".csv": "text/csv; charset=utf-8",
 ".webmanifest": "application/manifest+json; charset=utf-8",
};

export function contentTypeForPath(relPath: string): string {
 const dotIdx = relPath.lastIndexOf(".");
 if (dotIdx < 0) return "application/octet-stream";
 const ext = relPath.slice(dotIdx).toLowerCase();
 return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * 删文件；不存在静默返回 false。目录拒绝删除（throw）。symlink 本身也拒绝删除（throw）。
 */
export async function deleteWorkspaceFile(threadId: string, relPath: string): Promise<boolean> {
 const target = await assertNoSymlinkPath(threadId, relPath, { allowMissingLeaf: false });
 const st = await lstat(/*turbopackIgnore: true*/ target).catch(() => null);
 if (!st) return false;
 if (st.isDirectory()) {
 throw new WorkspacePathError("非法操作：拒绝删除目录");
 }
 await unlink(/*turbopackIgnore: true*/ target);
 return true;
}

/** 文件 stat；不存在返回 null。返回 { size, mtime, isDirectory, revision }。symlink / 越界 → throw。 */
export async function workspaceStat(
 threadId: string,
 relPath: string,
): Promise<{ size: number; mtime: Date; isDirectory: boolean; revision: string } | null> {
 const target = await assertNoSymlinkPath(threadId, relPath, { allowMissingLeaf: false });
 const st = await lstat(/*turbopackIgnore: true*/ target).catch(() => null);
 if (!st) return null;
 return {
 size: st.size,
 mtime: st.mtime,
 isDirectory: st.isDirectory(),
 // V9 阶段 4：轻量 revision（size + mtimeMs），用于编辑器冲突检测。
 // 文件内容或修改时间变化时 revision 改变；不引入完整 hash 的开销。
 revision: `${st.size}:${Math.floor(st.mtime.getTime())}`,
 };
}

/**
 * V9 阶段 4：revision-aware 原子写入。
 *
 * - 若 `expectedRevision` 提供：先读当前 stat，revision 不匹配 → 抛 `WorkspaceRevisionConflict`，
 * 携带当前内容与 revision，供前端展示 diff/merge（不静默覆盖）。
 * - revision 匹配或 `expectedRevision` 为空 → 在 path lock 内原子写入，返回新 stat（含新 revision）。
 *
 * 用 `withPathLock` 串行化同 path 写入，避免并发 editFile 丢失改动；
 * check-and-write 在同一锁内完成，消除 check-then-act 竞态。
 */
export class WorkspaceRevisionConflict extends Error {
 constructor(
 public readonly currentRevision: string,
 public readonly currentContent: string,
 ) {
 super("workspace revision conflict");
 }
}

export async function writeWorkspaceFileWithRevision(
 threadId: string,
 relPath: string,
 content: string,
 expectedRevision?: string,
): Promise<{ size: number; mtime: Date; isDirectory: boolean; revision: string }> {
 return withPathLock(`${threadId}:${relPath}`, async () => {
 // 校验内部目录路径（写入口同样禁止写内部目录，与读一致）
 if (isInternalPath(relPath)) {
 throw new WorkspacePathError("非法路径（内部目录）");
 }
 // revision 校验：读当前 stat（不存在视为新文件，revision 为空）
 const current = await workspaceStat(threadId, relPath).catch(() => null);
 const currentRevision = current?.revision ?? "";
 if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
 // 冲突：返回当前内容供前端 diff/merge
 const currentContent =
 current === null ? "" : ((await readWorkspaceFile(threadId, relPath)) ?? "");
 throw new WorkspaceRevisionConflict(currentRevision, currentContent);
 }
 await writeWorkspaceFile(threadId, relPath, content);
 const next = await workspaceStat(threadId, relPath);
 if (!next) throw new Error("写入后 stat 失败");
 return next;
 });
}

/** 递归列出工作区内的所有文件（相对路径）。 */
export async function listWorkspaceFiles(
 threadId: string,
 opts: { skipInternal?: boolean } = {},
): Promise<string[]> {
 const root = await getSafeWorkspaceRoot(threadId, { create: false });
 if (!root) return [];
 const skipInternal = opts.skipInternal === true;
 const out: string[] = [];
 async function walk(dir: string, prefix: string) {
 const entries = await readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true }).catch(
 () => [],
 );
 for (const entry of entries) {
 // V5-B1：前台 + Studio 前台都默认隐藏内部运行时目录（防泄露 .snow/.git/node_modules 等）。
 if (skipInternal && entry.isDirectory() && isInternalDirName(entry.name)) {
 continue;
 }
 const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
 if (entry.isDirectory()) {
 await walk(join(/*turbopackIgnore: true*/ dir, entry.name), rel);
 } else {
 out.push(rel);
 }
 }
 }
 await walk(root, "");
 return out;
}

/**
 * V5-B1：内部目录黑名单——前台员工不应该看到这些运行时/构建产物目录。
 * 前后两套 workspace API（Studio 后台 + 前台 /api/threads/[id]/workspace）listWorkspaceFiles 调用时
 * 都传 skipInternal=true，避免内部目录泄露给员工或管理员视觉。
 */
export const INTERNAL_DIR_NAMES: ReadonlySet<string> = new Set([
 ".snow",
 ".git",
 ".next",
 "node_modules",
 "dist",
 "build",
 ".cache",
 ".turbo",
]);

export function isInternalDirName(name: string): boolean {
 return INTERNAL_DIR_NAMES.has(name);
}

/**
 * V5-B1：检查相对路径是否落入内部目录（任意一段匹配 INTERNAL_DIR_NAMES）。
 * 前台 read API 用此函数拒绝读取 .snow/.git/node_modules 等内部目录下的文件——
 * 即使文件存在也不暴露（404），防止员工从文件路径推断内部结构。
 */
export function isInternalPath(relPath: string): boolean {
 const segs = relPath.split(/[\\/]/).filter(Boolean);
 return segs.some((seg) => INTERNAL_DIR_NAMES.has(seg));
}

/**
 * ：从 ReadableStream 流式写入 workspace 文件。
 *
 * 用于接收 Desktop 端上传的本机文件（download-uploader → upload route → 本函数）：
 * 不将整个文件读入内存，使用 Node.js stream.pipeline 将 Web ReadableStream 转换为
 * Node.js Readable 后管道到 fs.createWriteStream。
 *
 * 安全保证（与 writeWorkspaceFileBytes 一致）：
 * - safeJoin 词法边界（拒 `..`）
 * - 逐段 lstat 拒绝 symlink
 * - realpath 兜底校验父目录
 * - 原子写入：先写 .tmp 再 rename，防崩溃留下半写文件
 *
 * @param threadId Thread ID
 * @param relPath workspace 内相对路径（如 downloads/file.zip）
 * @param stream Web ReadableStream（如 request.body）
 * @returns 写入的字节数
 */
export async function writeWorkspaceFileFromStream(
 threadId: string,
 relPath: string,
 stream: ReadableStream<Uint8Array>,
): Promise<{ size: number }> {
 const target = await assertNoSymlinkPath(threadId, relPath, { allowMissingLeaf: true });
 const parent = dirname(/*turbopackIgnore: true*/ target);
 await mkdir(/*turbopackIgnore: true*/ parent, { recursive: true });
 await assertRealPathInsideWorkspace(threadId, parent);

 // 原子写入：先写 .tmp 再 rename，防崩溃留下半写文件
 const tmpFile = `${target}.tmp.${Date.now()}`;
 const nodeStream = Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]);
 const writeStream = createWriteStream(/*turbopackIgnore: true*/ tmpFile);
 await pipeline(/*turbopackIgnore: true*/ nodeStream, /*turbopackIgnore: true*/ writeStream);
 const tmpStat = await lstat(/*turbopackIgnore: true*/ tmpFile);
 const size = tmpStat.size;
 await rename(/*turbopackIgnore: true*/ tmpFile, /*turbopackIgnore: true*/ target);
 return { size };
}
