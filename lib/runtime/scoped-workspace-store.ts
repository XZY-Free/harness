import type { GrepResult, WorkspaceStore } from "./types";

/**
 * Stage B：ScopedWorkspaceStore——写范围收窄包装层。
 *
 * 包装一个底层 WorkspaceStore，在**存储层**强制 writeScope：
 * - write / delete 校验路径在 writeScope 内，否则 throw WriteScopeError（对应工具返回 ok:false）。
 * - read / stat / list / glob / grep / safeJoin / root / mountTarget 不限（只读允许）。
 *
 * writeScope 为 null/空 → 只读：write/delete 一律拒绝（默认只读，蓝图 ）。
 *
 * 设计理由（计划 §1）：路径限制在存储层，所有工具（writeFile/editFile/applyPatch/deleteFile
 * 等经 workspace.write/delete）自动受约束，不依赖每个工具自查，不可绕过。
 *
 * glob 匹配复用 lib/workspace 的 globToRegex 语义（支持 * / ** / ?，不支持 brace 展开），
 * 与 HostWorkspaceStore.glob 的 Node fallback 一致，保证 writeScope 表达与 glob 工具同源。
 */

/** 写范围越权错误。工具层 catch 后转 ok:false。 */
export class WriteScopeError extends Error {
 constructor(
 public readonly path: string,
 public readonly scope: string[] | null,
 ) {
 const scopeDesc = scope && scope.length > 0 ? scope.join(", ") : "(只读)";
 super(`路径 "${path}" 不在子代理 writeScope 内 [${scopeDesc}]`);
 this.name = "WriteScopeError";
 }
}

/** glob 模式 → RegExp（与 workspace-store.ts 的 globToRegex 同语义）。 */
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
 // 防 src** 误匹配 src-evil/x(原 .* 跨段)。
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

/** 路径是否落在 writeScope 内（任一 glob 命中即允许）。null/空 scope → 只读，恒 false。 */
export function pathInWriteScope(path: string, scope: string[] | null): boolean {
 const globs = (scope ?? []).filter((g) => g.length > 0);
 if (globs.length === 0) return false;
 const norm = path.replace(/^\.?\//, "");
 return globs.some((g) => globToRegex(g).test(norm));
}

/**
 * 包装底层 store，强制 writeScope。
 *
 * @param inner 底层 WorkspaceStore（host / container）
 * @param writeScope 路径 glob 数组；null/空 → 只读（write/delete 一律 throw）
 */
export class ScopedWorkspaceStore implements WorkspaceStore {
 constructor(
 private readonly inner: WorkspaceStore,
 private readonly writeScope: string[] | null,
 ) {}

 root(): string {
 return this.inner.root();
 }

 safeJoin(relPath: string): string {
 return this.inner.safeJoin(relPath);
 }

 mountTarget(): string {
 return this.inner.mountTarget();
 }

 read(relPath: string): Promise<string | null> {
 return this.inner.read(relPath);
 }

 stat(relPath: string) {
 return this.inner.stat(relPath);
 }

 list(): Promise<string[]> {
 return this.inner.list();
 }

 glob(pattern: string, opts?: { includeIgnored?: boolean }): Promise<string[]> {
 return this.inner.glob(pattern, opts);
 }

 grep(
 pattern: string,
 opts?: {
 glob?: string;
 caseInsensitive?: boolean;
 context?: number;
 maxResults?: number;
 },
 ): Promise<GrepResult> {
 return this.inner.grep(pattern, opts);
 }

 async write(relPath: string, content: string): Promise<string> {
 if (!pathInWriteScope(relPath, this.writeScope)) {
 throw new WriteScopeError(relPath, this.writeScope);
 }
 return this.inner.write(relPath, content);
 }

 async delete(relPath: string): Promise<boolean> {
 if (!pathInWriteScope(relPath, this.writeScope)) {
 throw new WriteScopeError(relPath, this.writeScope);
 }
 return this.inner.delete(relPath);
 }
}
