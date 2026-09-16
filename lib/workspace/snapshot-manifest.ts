import { createHash } from "node:crypto";
import { lstat, readdir, readlink, stat } from "node:fs/promises";
import path from "node:path";

export const SNAPSHOT_CHUNK_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_FORMAT = "content_manifest" as const;

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

export class SnapshotManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointIntegrityFailed";
  }
}

export function validateSnapshotPath(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
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

export function validateSnapshotManifest(manifest: SnapshotManifest): SnapshotManifest {
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
    if (entry.type === "file") {
      files += 1;
      bytes += entry.sizeBytes;
      if (!entry.chunks)
        throw new SnapshotManifestError(`Snapshot file 缺少 chunks: ${entry.path}`);
      if (entry.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0) !== entry.sizeBytes)
        throw new SnapshotManifestError(`Snapshot file chunk 长度不匹配: ${entry.path}`);
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
  return manifest;
}

export async function scanWorkspaceRoot(
  root: string,
): Promise<{ entries: SnapshotEntry[]; fileCount: number; totalBytes: number }> {
  const entries: SnapshotEntry[] = [];
  async function visit(relative: string, absolute: string): Promise<void> {
    const info = await lstat(absolute);
    const normalized = relative ? validateSnapshotPath(relative) : "";
    if (info.isDirectory()) {
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
    const current = await stat(absolute);
    if (current.size !== info.size || current.mtimeMs !== info.mtimeMs)
      throw new SnapshotManifestError(`Snapshot 文件在读取前发生变化: ${relative}`);
    entries.push({
      path: normalized,
      type: "file",
      sizeBytes: current.size,
      mtimeMs: current.mtimeMs,
      mode: current.mode & 0o7777,
      chunks: [],
    });
  }
  await visit("", root);
  entries.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  return {
    entries,
    fileCount: entries.filter((entry) => entry.type === "file").length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
  };
}

export function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
