import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SNAPSHOT_CHUNK_BYTES,
  type SnapshotChunk,
  type SnapshotEntry,
  type SnapshotManifest,
  digestJson,
  validateSnapshotManifest,
} from "@/lib/workspace/snapshot-manifest";

export interface SnapshotStorageReceipt {
  manifestRef: string;
  manifestDigest: string;
  contentRootDigest: string;
  fileCount: number;
  totalBytes: number;
  chunks: string[];
}

export interface SnapshotStorage {
  writeSnapshot(
    root: string,
    operationId: string,
  ): Promise<{ manifest: SnapshotManifest; receipt: SnapshotStorageReceipt }>;
  readManifest(manifestRef: string, expectedDigest: string): Promise<SnapshotManifest>;
  restoreSnapshot(manifest: SnapshotManifest, destination: string): Promise<void>;
}

export class FileSnapshotStorage implements SnapshotStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async writeSnapshot(root: string, operationId: string) {
    const { scanWorkspaceRoot } = await import("@/lib/workspace/snapshot-manifest");
    await mkdir(path.join(this.root, "chunks"), { recursive: true });
    await mkdir(path.join(this.root, "manifests"), { recursive: true });
    const scanned = await scanWorkspaceRoot(root);
    const entries: SnapshotEntry[] = [];
    const chunks = new Set<string>();
    for (const entry of scanned.entries) {
      if (entry.type !== "file") {
        entries.push(entry);
        continue;
      }
      const fileChunks: SnapshotChunk[] = [];
      const handle = await open(path.join(root, entry.path), "r");
      try {
        let offset = 0;
        while (offset < entry.sizeBytes) {
          const size = Math.min(SNAPSHOT_CHUNK_BYTES, entry.sizeBytes - offset);
          const buffer = Buffer.allocUnsafe(size);
          const result = await handle.read(buffer, 0, size, offset);
          if (result.bytesRead !== size) throw new Error(`Snapshot 读取长度不一致: ${entry.path}`);
          const digest = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
          const location = path.join(this.root, "chunks", digest.slice("sha256:".length));
          try {
            await readFile(location);
          } catch {
            await writeFile(`${location}.staging`, buffer, { flag: "wx" }).then(() =>
              rename(`${location}.staging`, location),
            );
          }
          fileChunks.push({ digest, sizeBytes: size });
          chunks.add(digest);
          offset += size;
        }
      } finally {
        await handle.close();
      }
      entries.push({ ...entry, chunks: fileChunks });
    }
    const contentRootDigest = digestJson(entries);
    const body = {
      format: "content_manifest" as const,
      formatVersion: 1 as const,
      entries,
      fileCount: scanned.fileCount,
      totalBytes: scanned.totalBytes,
      contentRootDigest,
    };
    const manifest: SnapshotManifest = { ...body, manifestDigest: digestJson(body) };
    validateSnapshotManifest(manifest);
    const manifestRef = `manifests/${manifest.manifestDigest.slice("sha256:".length)}.json`;
    const location = path.join(this.root, manifestRef);
    try {
      await readFile(location);
    } catch {
      await writeFile(`${location}.${operationId}.staging`, JSON.stringify(manifest), {
        flag: "wx",
      }).then(() => rename(`${location}.${operationId}.staging`, location));
    }
    return {
      manifest,
      receipt: {
        manifestRef,
        manifestDigest: manifest.manifestDigest,
        contentRootDigest,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        chunks: [...chunks],
      },
    };
  }

  async readManifest(manifestRef: string, expectedDigest: string): Promise<SnapshotManifest> {
    if (
      manifestRef.includes("..") ||
      path.isAbsolute(manifestRef) ||
      !manifestRef.startsWith("manifests/")
    )
      throw new Error("CheckpointIntegrityFailed");
    const manifest = JSON.parse(
      await readFile(path.join(this.root, manifestRef), "utf8"),
    ) as SnapshotManifest;
    if (manifest.manifestDigest !== expectedDigest) throw new Error("CheckpointIntegrityFailed");
    return validateSnapshotManifest(manifest);
  }

  async restoreSnapshot(manifest: SnapshotManifest, destination: string): Promise<void> {
    validateSnapshotManifest(manifest);
    await mkdir(destination, { recursive: true });
    for (const entry of manifest.entries) {
      const target = path.join(destination, entry.path);
      if (entry.type === "directory") await mkdir(target, { recursive: true, mode: entry.mode });
      if (entry.type === "symlink") await this.restoreSymlink(destination, entry, target);
      if (entry.type === "file") {
        await mkdir(path.dirname(target), { recursive: true });
        const output = await open(target, "wx", entry.mode);
        try {
          for (const chunk of entry.chunks ?? []) {
            const bytes = await readFile(
              path.join(this.root, "chunks", chunk.digest.slice("sha256:".length)),
            );
            if (bytes.length !== chunk.sizeBytes || hashBytes(bytes) !== chunk.digest)
              throw new Error("CheckpointIntegrityFailed");
            await output.write(bytes);
          }
        } finally {
          await output.close();
        }
      }
      await this.applyMetadata(target, entry);
    }
  }

  private async restoreSymlink(
    destination: string,
    entry: SnapshotEntry,
    target: string,
  ): Promise<void> {
    const resolved = path.resolve(path.dirname(target), entry.target ?? "");
    if (
      resolved !== path.resolve(destination) &&
      !resolved.startsWith(`${path.resolve(destination)}${path.sep}`)
    )
      throw new Error("CheckpointIntegrityFailed");
    await mkdir(path.dirname(target), { recursive: true });
    await import("node:fs/promises").then(({ symlink }) => symlink(entry.target as string, target));
  }

  private async applyMetadata(target: string, entry: SnapshotEntry): Promise<void> {
    const { chmod, lutimes, utimes } = await import("node:fs/promises");
    const stamp = new Date(entry.mtimeMs);
    if (entry.type === "symlink") {
      // chmod/utimes 会跟随 symlink 目标并破坏其元数据；symlink 权限不可移植，仅恢复自身 mtime。
      await lutimes(target, stamp, stamp);
      return;
    }
    await chmod(target, entry.mode & 0o777);
    await utimes(target, stamp, stamp);
  }
}

function hashBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
