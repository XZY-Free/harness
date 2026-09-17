/**
 * Snapshot content_manifest 格式与完整性（R09 §5）。
 *
 * 固定格式：`content_manifest` + JCS 摘要 + 4MiB 块 + 显式 filesystem semantics。
 * **只有被实现且测试过的能力才可声明**：扫描会拒绝所声明 profile 之外的现实
 * （hardlink、special file、setuid/setgid），而不是静默丢弃后声称完整恢复。
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { computeCanonicalDigest, rfc8785Canonicalize } from "@/lib/crypto/rfc-8785-canonicalize";
import type { FilesystemSemantics } from "@/lib/runtime/runtime-protocol";

export const SNAPSHOT_CHUNK_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_CHUNK_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const SNAPSHOT_FORMAT = "content_manifest" as const;

/** setuid/setgid/sticky：本实现不恢复它们，因此含这些位的条目必须被拒绝。 */
const UNSAFE_MODE_MASK = 0o7000;

export interface SnapshotChunk {
  digest: string;
  sizeBytes: number;
}

export interface SnapshotEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  sizeBytes: number;
  mtimeMs: number;
  mode: number;
  chunks?: SnapshotChunk[];
  target?: string;
}

export interface SnapshotManifest {
  format: typeof SNAPSHOT_FORMAT;
  formatVersion: 1;
  entries: SnapshotEntry[];
  fileCount: number;
  totalBytes: number;
  contentRootDigest: string;
  manifestDigest: string;
}

/** CheckpointPolicy 里与容量有关的硬上限；缺一不可（缺失即 fail-closed）。 */
export interface CheckpointPolicyLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  chunkBytes: number;
}

export class SnapshotManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointIntegrityFailed";
  }
}

/**
 * 解析 CheckpointPolicy 的容量约束。
 *
 * 明确拒绝"没有上限的策略"：没有上限就没法证明内容符合策略，
 * 而 `CHECKPOINT_RESTORABLE` 又必须携带策略（见 workspace-contract）。
 * 声明与实现不一致（`chunkBytes` ≠ 4MiB）同样被拒——格式是固定的。
 */
export function parseCheckpointPolicy(
  value: Record<string, unknown> | null | undefined,
): CheckpointPolicyLimits {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SnapshotManifestError("CheckpointPolicy 缺失：无法证明 Snapshot 符合容量约束");
  const maxEntries = readPositiveInt(value.maxEntries, "maxEntries");
  const maxTotalBytes = readDecimal(value.maxTotalBytes, "maxTotalBytes");
  const chunkBytes = readPositiveInt(value.chunkBytes, "chunkBytes");
  if (chunkBytes !== SNAPSHOT_CHUNK_BYTES)
    throw new SnapshotManifestError(
      `CheckpointPolicy chunkBytes=${chunkBytes} 与 content_manifest 固定块长 ${SNAPSHOT_CHUNK_BYTES} 不一致`,
    );
  const maxFileBytes =
    value.maxFileBytes === undefined
      ? maxTotalBytes
      : readDecimal(value.maxFileBytes, "maxFileBytes");
  if (maxFileBytes > maxTotalBytes)
    throw new SnapshotManifestError("CheckpointPolicy maxFileBytes 不得大于 maxTotalBytes");
  return { maxEntries, maxTotalBytes, maxFileBytes, chunkBytes };
}

function readPositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new SnapshotManifestError(`CheckpointPolicy ${field} 必须为正整数`);
  return value;
}

function readDecimal(value: unknown, field: string): number {
  // 8 字节量级用十进制字符串承载（03 §8），不先转 Number 再校验。
  if (typeof value === "string") {
    if (!/^[0-9]+$/.test(value)) throw new SnapshotManifestError(`CheckpointPolicy ${field} 非法`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed))
      throw new SnapshotManifestError(`CheckpointPolicy ${field} 超出安全整数范围`);
    return parsed;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new SnapshotManifestError(`CheckpointPolicy ${field} 非法`);
}

/**
 * 该实现真正具备的能力集合。profile 声明了不存在的能力即拒绝——
 * 否则我们会"按声明恢复"却实际丢东西。
 */
export function assertSupportedFilesystemSemantics(profile: FilesystemSemantics): void {
  if (profile.hardlinks)
    throw new SnapshotManifestError(
      "本实现不保留 hardlink，filesystemSemantics 不得声明 hardlinks",
    );
  if (profile.specialFiles)
    throw new SnapshotManifestError("本实现不支持 special file，不得声明 specialFiles");
  if (profile.xattrsAcl)
    throw new SnapshotManifestError("本实现不保留 xattr/ACL，不得声明 xattrsAcl");
  if (profile.symlinks !== true)
    throw new SnapshotManifestError(
      "本实现要求 profile 声明 symlinks（否则 symlink 会被静默丢失）",
    );
}

export function validateSnapshotPath(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    // 反斜杠在 POSIX 下是普通文件名字符、在 Windows 下是分隔符，同一 manifest 会在
    // 两个平台解释出不同目录树；恢复目标必须唯一确定，所以直接拒绝。
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new SnapshotManifestError(`Snapshot 路径非法: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("//")
  ) {
    throw new SnapshotManifestError(`Snapshot 路径越界: ${value}`);
  }
  return normalized;
}

export function validateSnapshotManifest(
  manifest: SnapshotManifest,
  limits?: CheckpointPolicyLimits | null,
): SnapshotManifest {
  if (manifest.format !== SNAPSHOT_FORMAT || manifest.formatVersion !== 1)
    throw new SnapshotManifestError("Snapshot format 不支持");
  const paths = new Set<string>();
  let files = 0;
  let bytes = 0;
  for (const entry of manifest.entries) {
    const normalized = validateSnapshotPath(entry.path);
    if (normalized !== entry.path || paths.has(entry.path))
      throw new SnapshotManifestError("Snapshot manifest 路径重复");
    paths.add(entry.path);
    if (
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      !Number.isFinite(entry.mtimeMs) ||
      !Number.isInteger(entry.mode)
    ) {
      throw new SnapshotManifestError(`Snapshot entry metadata 非法: ${entry.path}`);
    }
    // setuid/setgid/sticky 不被恢复；静默丢掉后再声称"完整恢复"就是假的。
    if ((entry.mode & UNSAFE_MODE_MASK) !== 0)
      throw new SnapshotManifestError(`Snapshot entry 含 setuid/setgid/sticky 位: ${entry.path}`);
    if (entry.type === "file") {
      files += 1;
      bytes += entry.sizeBytes;
      if (!entry.chunks)
        throw new SnapshotManifestError(`Snapshot file 缺少 chunks: ${entry.path}`);
      const chunkBytes = limits?.chunkBytes ?? SNAPSHOT_CHUNK_BYTES;
      for (const [index, chunk] of entry.chunks.entries()) {
        // 只有形状与长度都合法，下面按 digest 去重/复用的写入路径才是可信的。
        if (!SNAPSHOT_CHUNK_DIGEST_PATTERN.test(chunk.digest))
          throw new SnapshotManifestError(`Snapshot chunk digest 形状非法: ${entry.path}`);
        if (
          !Number.isSafeInteger(chunk.sizeBytes) ||
          chunk.sizeBytes <= 0 ||
          chunk.sizeBytes > chunkBytes
        ) {
          throw new SnapshotManifestError(`Snapshot chunk 长度非法: ${entry.path}`);
        }
        // 除最后一块外必须刚好满块：否则"块长"可以被用来伪造 padding 或截断。
        if (index < entry.chunks.length - 1 && chunk.sizeBytes !== chunkBytes)
          throw new SnapshotManifestError(`Snapshot 非末尾 chunk 长度非满块: ${entry.path}`);
      }
      if (entry.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0) !== entry.sizeBytes)
        throw new SnapshotManifestError(`Snapshot file chunk 长度不匹配: ${entry.path}`);
      if (limits && entry.sizeBytes > limits.maxFileBytes)
        throw new SnapshotManifestError(`Snapshot 单文件超过 CheckpointPolicy 上限: ${entry.path}`);
    } else if (entry.type === "symlink") {
      if (
        entry.sizeBytes !== 0 ||
        !entry.target ||
        path.posix.isAbsolute(entry.target) ||
        entry.target.includes("\0")
      )
        throw new SnapshotManifestError(`Snapshot symlink 不安全: ${entry.path}`);
    } else if (entry.type !== "directory" || entry.sizeBytes !== 0) {
      throw new SnapshotManifestError(`Snapshot entry 类型或长度非法: ${entry.path}`);
    }
  }
  if (files !== manifest.fileCount || bytes !== manifest.totalBytes)
    throw new SnapshotManifestError("Snapshot manifest 计数或长度不匹配");
  // 父级必须是目录：否则恢复时会先按 file/symlink 落地再往其下写子项，产生
  // "写进了别的东西里"的静默错放。
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry] as const));
  for (const entry of manifest.entries) {
    const segments = entry.path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = byPath.get(segments.slice(0, depth).join("/"));
      if (ancestor && ancestor.type !== "directory")
        throw new SnapshotManifestError(`Snapshot 父级不是目录: ${entry.path}`);
    }
  }
  // contentRootDigest 必须是**重算**结果，不能只作为字段参与 manifestDigest——
  // 否则内容被替换而 manifest 自洽的篡改无法被发现。
  const expectedContentRoot = digestJson(manifest.entries);
  if (manifest.contentRootDigest !== expectedContentRoot)
    throw new SnapshotManifestError("Snapshot contentRootDigest 不匹配");
  const withoutDigest = {
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    entries: manifest.entries,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    contentRootDigest: manifest.contentRootDigest,
  };
  const expected = digestJson(withoutDigest);
  if (manifest.manifestDigest !== expected)
    throw new SnapshotManifestError("Snapshot manifestDigest 不匹配");
  if (limits) {
    if (manifest.entries.length > limits.maxEntries)
      throw new SnapshotManifestError("Snapshot 条目数超过 CheckpointPolicy 上限");
    if (manifest.totalBytes > limits.maxTotalBytes)
      throw new SnapshotManifestError("Snapshot 总字节超过 CheckpointPolicy 上限");
  }
  return manifest;
}

/**
 * 扫描写根，产出内容清单。
 *
 * 遇到硬链接、special file、setuid/setgid 直接拒绝（§5）；profile 声明了本实现不具备的
 * 能力也拒绝。返回的 mode 只保留权限位，避免把不可恢复的位带进 manifest。
 */
export async function scanWorkspaceRoot(
  root: string,
  options: { filesystemSemantics?: FilesystemSemantics } = {},
): Promise<{ entries: SnapshotEntry[]; fileCount: number; totalBytes: number }> {
  const profile = options.filesystemSemantics;
  if (profile) assertSupportedFilesystemSemantics(profile);
  const entries: SnapshotEntry[] = [];
  async function visit(relative: string, absolute: string): Promise<void> {
    const info = await lstat(absolute);
    const normalized = relative ? validateSnapshotPath(relative) : "";
    if (info.isDirectory()) {
      // 目录上的 sticky/setgid 同样不被恢复（且会改变共享目录语义）→ 拒绝。
      if ((info.mode & UNSAFE_MODE_MASK) !== 0)
        throw new SnapshotManifestError(`Snapshot 不支持 setuid/setgid/sticky 目录: ${relative}`);
      if (normalized)
        entries.push({
          path: normalized,
          type: "directory",
          sizeBytes: 0,
          mtimeMs: info.mtimeMs,
          mode: info.mode & 0o7777,
        });
      for (const child of await readdir(absolute))
        await visit(relative ? `${relative}/${child}` : child, path.join(absolute, child));
      return;
    }
    if (info.isSymbolicLink()) {
      if (profile && profile.symlinks !== true)
        throw new SnapshotManifestError(`Snapshot profile 未声明 symlink: ${relative}`);
      const target = await readlink(absolute);
      const resolved = path.resolve(path.dirname(absolute), target);
      if (resolved !== root && !resolved.startsWith(`${path.resolve(root)}${path.sep}`))
        throw new SnapshotManifestError(`Snapshot symlink 逃逸: ${relative}`);
      entries.push({
        path: normalized,
        type: "symlink",
        sizeBytes: 0,
        mtimeMs: info.mtimeMs,
        mode: info.mode & 0o7777,
        target,
      });
      return;
    }
    if (!info.isFile()) throw new SnapshotManifestError(`Snapshot 不支持特殊文件: ${relative}`);
    // 硬链接：nlink > 1。恢复只能写成分离副本，等于静默改变语义 → 拒绝。
    if (info.nlink > 1) throw new SnapshotManifestError(`Snapshot 不支持 hardlink: ${relative}`);
    if ((info.mode & UNSAFE_MODE_MASK) !== 0)
      throw new SnapshotManifestError(`Snapshot 不支持 setuid/setgid/sticky: ${relative}`);
    const current = await stat(absolute);
    if (current.size !== info.size || current.mtimeMs !== info.mtimeMs)
      throw new SnapshotManifestError(`Snapshot 文件在读取前发生变化: ${relative}`);
    entries.push({
      path: normalized,
      type: "file",
      sizeBytes: current.size,
      mtimeMs: current.mtimeMs,
      mode: current.mode & 0o777,
      chunks: [],
    });
  }
  await visit("", root);
  entries.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  assertCaseCollisionFree(entries, profile);
  return {
    entries,
    fileCount: entries.filter((entry) => entry.type === "file").length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
  };
}

/**
 * 大小写不敏感的文件系统上，仅大小写不同的两个路径会互相覆盖；
 * profile 声明 caseSensitive=false 时必须提前拒绝。
 */
function assertCaseCollisionFree(
  entries: SnapshotEntry[],
  profile: FilesystemSemantics | undefined,
): void {
  if (!profile || profile.caseSensitive !== false) return;
  const folded = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.path.toLowerCase();
    const existing = folded.get(key);
    if (existing !== undefined && existing !== entry.path)
      throw new SnapshotManifestError(
        `大小写不敏感文件系统上路径冲突: ${existing} / ${entry.path}`,
      );
    folded.set(key, entry.path);
  }
}

/** JCS 规范化摘要（RFC 8785）：跨系统/跨平台稳定，不依赖 JS 属性插入顺序。 */
export function digestJson(value: unknown): string {
  return computeCanonicalDigest(value);
}

export function hashSnapshotBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** 供调用方核对 manifest 与扫描结果一致（恢复前的树验证也用它）。 */
export function canonicalSnapshotJson(value: unknown): string {
  return rfc8785Canonicalize(value);
}
