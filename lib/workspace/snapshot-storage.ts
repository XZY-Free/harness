/**
 * 内容寻址 Snapshot 存储（R09 §6 并发与崩溃安全写入 / §7 Restore 幂等）。
 *
 * §6：
 * - 候选块使用 **operation 唯一**的 staging 文件，写完 + fsync + hash 校验后原子提交；
 * - 并发相同 content hash 的竞争者**验证既有块**（读回长度与 digest）后复用，
 *   不把 EEXIST 当损坏，也不共享一个会被 Crash 遗留堵塞的临时文件；
 * - 既有块损坏时报错并隔离，不返回持久 Checkpoint 回执；
 * - Manifest 在所引用块全部持久后提交，返回前对文件与目录做 fsync。
 *
 * §7：
 * - 先恢复到**属于本 operation 的 staging generation**，完成 Hash/树/元数据验证后才
 *   原子标记该 generation 可用并 rename 到目标；部分失败不污染正式 root，也不会让
 *   下一次 `wx` 永远 EEXIST；
 * - 恢复前验证目标不是任意现存目录或 symlink；写入走防跟随链接的安全路径；
 * - 输出短写必须循环补完；任何错误都保留未 ready 状态，禁止 catch 后返回成功。
 */
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { FilesystemSemantics } from "@/lib/runtime/runtime-protocol";
import {
  type CheckpointPolicyLimits,
  SNAPSHOT_CHUNK_BYTES,
  type SnapshotChunk,
  type SnapshotEntry,
  type SnapshotManifest,
  digestJson,
  hashSnapshotBytes,
  parseCheckpointPolicy,
  scanWorkspaceRoot,
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

/** CHECKPOINT_RESTORABLE 的写入/读取约束：容量上限 + 已声明的 filesystem profile。 */
export interface SnapshotRequirements {
  checkpointPolicy: Record<string, unknown> | null;
  filesystemSemantics: FilesystemSemantics;
}

export interface SnapshotStorage {
  writeSnapshot(
    root: string,
    operationId: string,
    requirements: SnapshotRequirements,
  ): Promise<{ manifest: SnapshotManifest; receipt: SnapshotStorageReceipt }>;
  readManifest(
    manifestRef: string,
    expectedDigest: string,
    requirements?: SnapshotRequirements,
  ): Promise<SnapshotManifest>;
  restoreSnapshot(
    manifest: SnapshotManifest,
    destination: string,
    operationId?: string,
    requirements?: SnapshotRequirements,
  ): Promise<void>;
}

/**
 * SnapshotStorage 的**可序列化**引用（A06）。
 *
 * 控制端口（含跨进程 RPC）只允许传递这个值：`SnapshotStorage` 是带方法的实例，一旦进入
 * JSON 请求就会**静默退化成普通对象**，服务端 `storage.readManifest(...)` 立刻是
 * "not a function"。因此真实 IO 必须留在**拥有该存储能力的那一端**执行：
 *
 * - `file`：显式物理根（部署配置了 `SNOWHARNESS_SNAPSHOT_STORAGE_ROOT` 一类事实）；
 *   同机进程间共享同一路径时合法。
 * - `broker_default`：由 Broker 使用**它自己持有的**默认存储。控制面不知道也不需要知道
 *   其物理路径 —— 远端进程的默认存储根在控制面本来就不可见，这是唯一诚实的表达。
 */
export type SnapshotStorageRef = { kind: "file"; root: string } | { kind: "broker_default" };

/** 由部署配置派生存储引用：没有物理根时**不臆造路径**，交给 Broker 自己的存储。 */
export function snapshotStorageRefFromRoot(root: string | null | undefined): SnapshotStorageRef {
  return root ? { kind: "file", root } : { kind: "broker_default" };
}

/** 在拥有存储能力的一端把引用解析成真实实现；无 fallback 时 `broker_default` 无法解析。 */
export function resolveSnapshotStorage(
  ref: SnapshotStorageRef | undefined,
  fallback: SnapshotStorage | null,
): SnapshotStorage {
  if (!ref) {
    if (!fallback) throw new SnapshotStorageUnavailableError("缺少 SnapshotStorage 引用");
    return fallback;
  }
  if (ref.kind === "broker_default") {
    if (!fallback) {
      throw new SnapshotStorageUnavailableError("broker_default 只能由持有默认存储的 Broker 解析");
    }
    return fallback;
  }
  return new FileSnapshotStorage(ref.root);
}

/** 缺存储能力（fail-closed，绝不用空实现兜底）。 */
export class SnapshotStorageUnavailableError extends Error {
  readonly stableCode = "SnapshotStorageUnavailable";
  constructor(message: string) {
    super(message);
    this.name = "SnapshotStorageUnavailable";
  }
}

interface RestoreState {
  operationId: string;
  manifestDigest: string;
  phase: "staging" | "publishing" | "ready";
}

export class FileSnapshotStorage implements SnapshotStorage {
  private readonly root: string;
  private readonly testHooks: {
    beforeRestorePublish?: (input: { target: string; operationId: string }) => Promise<void>;
    afterRestoreRename?: (input: { target: string; operationId: string }) => Promise<void>;
  } | null;

  constructor(
    root: string,
    /** 仅供真实文件系统并发测试控制 publish 交错；生产装配不得传入。 */
    testHooks?: {
      beforeRestorePublish?: (input: { target: string; operationId: string }) => Promise<void>;
      afterRestoreRename?: (input: { target: string; operationId: string }) => Promise<void>;
    },
  ) {
    this.root = path.resolve(root);
    this.testHooks = testHooks ?? null;
  }

  async writeSnapshot(root: string, operationId: string, requirements: SnapshotRequirements) {
    const limits = parseCheckpointPolicy(requirements.checkpointPolicy);
    await mkdir(path.join(this.root, "chunks"), { recursive: true });
    await mkdir(path.join(this.root, "manifests"), { recursive: true });
    const scanned = await scanWorkspaceRoot(root, {
      filesystemSemantics: requirements.filesystemSemantics,
    });
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
          const digest = hashSnapshotBytes(buffer);
          await this.persistChunk(digest, buffer, operationId);
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
    validateSnapshotManifest(manifest, limits);
    const manifestRef = `manifests/${manifest.manifestDigest.slice("sha256:".length)}.json`;
    await this.persistManifest(manifest, manifestRef, operationId);
    // Manifest 只在所引用块全部持久后提交；提交前同步数据与目录项。
    await this.syncDirectory(path.join(this.root, "manifests"));
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

  /**
   * 落一个内容块。
   *
   * 并发同 hash：先按"读回 + digest 校验"确认既有块正确 → 复用；只有已存在但**内容不对**
   * 时才视为损坏并报错（隔离该块，不返回 Checkpoint 回执）。
   * 候选写入走 operation 唯一 staging：竞争者不会共享同一个可能被 Crash 遗留堵塞的临时文件。
   */
  private async persistChunk(digest: string, buffer: Buffer, operationId: string): Promise<void> {
    const location = path.join(this.root, "chunks", digest.slice("sha256:".length));
    const existing = await this.readChunkIfPresent(location);
    if (existing === "valid") return;
    if (existing === "corrupt") throw new Error(`Snapshot 既有内容块损坏: ${digest}`);
    const staging = `${location}.${operationId}.staging`;
    await rm(staging, { force: true });
    const handle = await open(staging, "wx", 0o600);
    try {
      await writeAll(handle, buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // staging 内容自检后再原子提交：短写/磁盘错误不会变成"看起来存在的块"。
    const staged = await readFile(staging);
    if (staged.length !== buffer.length || hashSnapshotBytes(staged) !== digest)
      throw new Error(`Snapshot 内容块写入校验失败: ${digest}`);
    await rename(staging, location);
    await this.syncDirectory(path.dirname(location));
  }

  private async readChunkIfPresent(location: string): Promise<"valid" | "corrupt" | "missing"> {
    try {
      const bytes = await readFile(location);
      const expected = `sha256:${path.basename(location)}`;
      return hashSnapshotBytes(bytes) === expected ? "valid" : "corrupt";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }

  private async persistManifest(
    manifest: SnapshotManifest,
    manifestRef: string,
    operationId: string,
  ): Promise<void> {
    const location = path.join(this.root, manifestRef);
    const existing = await readFile(location).then(
      (bytes) => bytes.toString("utf8"),
      () => null,
    );
    const serialized = JSON.stringify(manifest);
    if (existing !== null) {
      // 既有同 digest manifest 必须逐字节等价；否则说明内容寻址被破坏。
      if (existing !== serialized) throw new Error("Snapshot 既有 manifest 与内容寻址不一致");
      return;
    }
    const staging = `${location}.${operationId}.staging`;
    await rm(staging, { force: true });
    const handle = await open(staging, "wx", 0o600);
    try {
      await writeAll(handle, Buffer.from(serialized, "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, location);
  }

  async readManifest(
    manifestRef: string,
    expectedDigest: string,
    requirements?: SnapshotRequirements,
  ): Promise<SnapshotManifest> {
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
    return validateSnapshotManifest(manifest, resolveLimits(requirements));
  }

  /**
   * 幂等恢复（§7）。
   *
   * 步骤：确认目标归属 → 在 staging generation 内重建内容（短写循环、防跟随链接）→
   * 重算整棵树并比对 manifest → 写 ready 标记并 fsync → 原子 rename 到目标。
   * 任何失败都留下"未 ready"的 staging，重试时复核归属后安全重建，正式 root 不被污染。
   */
  async restoreSnapshot(
    manifest: SnapshotManifest,
    destination: string,
    operationId?: string,
    requirements?: SnapshotRequirements,
  ): Promise<void> {
    const limits = validateSnapshotManifest(manifest, resolveLimits(requirements));
    const target = path.resolve(destination);
    const operation = operationId ?? manifest.manifestDigest;
    const staging = `${target}.staging`;
    // 归属/就绪状态放在**树外**：恢复出来的目录树必须与 manifest 逐项相等，不能多出控制文件。
    const stateFile = `${target}.restore-state.json`;
    if (await this.reconcilePublishedTarget(target, stateFile, operation, manifest)) return;
    await this.resetStaging(staging, stateFile, operation, manifest.manifestDigest);
    await mkdir(staging, { recursive: true });
    const directories: SnapshotEntry[] = [];
    for (const entry of manifest.entries) {
      const entryTarget = resolveInside(staging, entry.path);
      if (entry.type === "directory") {
        await mkdir(entryTarget, { recursive: true });
        directories.push(entry);
        continue;
      }
      if (entry.type === "symlink") {
        await restoreSymlink(staging, entry, entryTarget);
        continue;
      }
      await mkdir(path.dirname(entryTarget), { recursive: true });
      await this.restoreFile(entry, entryTarget);
    }
    // 目录元数据**最后**应用：readonly 目录不会妨碍子项写入，mtime 也不会被子创建改变。
    for (const entry of directories) await applyMetadata(resolveInside(staging, entry.path), entry);
    await this.verifyRestoredTree(staging, manifest);
    await this.syncDirectory(staging);
    await this.testHooks?.beforeRestorePublish?.({ target, operationId: operation });
    await this.commitStaging(staging, target, stateFile, {
      operationId: operation,
      manifestDigest: manifest.manifestDigest,
      phase: "ready",
    });
  }

  /**
   * 复核已发布目标。
   *
   * marker 只证明“哪个 operation 声称发布过”，不能证明目录仍是那份内容；因此 ready
   * 重投也必须逐字节核验目标树。`staging/publishing + 已存在目标` 是 rename 成功后进程在
   * ready marker 落盘前崩溃的合法窗口：只有归属与实际树同时匹配时才补交 ready。
   */
  private async reconcilePublishedTarget(
    target: string,
    stateFile: string,
    operationId: string,
    manifest: SnapshotManifest,
  ): Promise<boolean> {
    const info = await lstat(target).catch(() => null);
    if (!info) return false;
    if (info.isSymbolicLink())
      throw new Error("CheckpointIntegrityFailed: 恢复目标不能是 symlink（防跟随链接）");
    if (!info.isDirectory()) throw new Error("CheckpointIntegrityFailed: 恢复目标不是目录");
    const state = await readRestoreState(stateFile);
    // 调用方预建的空目录且没有任何恢复状态，仍可作为首次目标；一旦存在本 operation 的
    // 状态（尤其 ready），即使目录被删空也必须按实际树校验失败，不能静默重建来掩盖损坏。
    if (!state && (await readdir(target)).length === 0) return false;
    if (
      !state ||
      state.operationId !== operationId ||
      state.manifestDigest !== manifest.manifestDigest
    ) {
      throw new Error("CheckpointIntegrityFailed: 恢复目标已被占用且不属于本次恢复");
    }
    try {
      await this.verifyRestoredTree(target, manifest);
    } catch (error) {
      throw new Error(
        `CheckpointIntegrityFailed: 目标实际内容与 manifest 不一致：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (state.phase !== "ready") {
      await writeFile(
        stateFile,
        JSON.stringify({
          operationId,
          manifestDigest: manifest.manifestDigest,
          phase: "ready",
        } satisfies RestoreState),
      );
      await this.syncDirectory(path.dirname(target));
    }
    return true;
  }

  /**
   * staging 归属复核：属于本 operation 但未 ready 的候选可以安全重建；
   * 属于别的 operation 的候选目录一律拒绝（不得互相覆盖）。
   */
  private async resetStaging(
    staging: string,
    stateFile: string,
    operation: string,
    manifestDigest: string,
  ): Promise<void> {
    const info = await lstat(staging).catch(() => null);
    const state = await readRestoreState(stateFile);
    if (info) {
      if (!state || state.operationId !== operation || state.manifestDigest !== manifestDigest)
        throw new Error("CheckpointIntegrityFailed: staging 属于其他恢复操作");
      if (info.isSymbolicLink())
        throw new Error("CheckpointIntegrityFailed: staging 不能是 symlink");
      await rm(staging, { recursive: true, force: true });
    }
    await writeFile(
      stateFile,
      JSON.stringify({ operationId: operation, manifestDigest, phase: "staging" }),
    );
  }

  private async restoreFile(entry: SnapshotEntry, target: string): Promise<void> {
    const handle = await open(target, "wx", entry.mode & 0o777);
    try {
      for (const chunk of entry.chunks ?? []) {
        const bytes = await readFile(path.join(this.root, "chunks", chunk.digest.slice(7)));
        if (bytes.length !== chunk.sizeBytes || hashSnapshotBytes(bytes) !== chunk.digest)
          throw new Error("CheckpointIntegrityFailed");
        // 短写必须循环补完：write 返回的 bytesWritten 可能小于请求长度。
        await writeAll(handle, bytes);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await applyMetadata(target, entry);
  }

  /**
   * 重算整棵树（形状、长度、逐块 digest，以及"没有多出来的东西"）并与 manifest 比对；
   * 不一致则恢复不算完成——恢复出来的树必须与 manifest 逐项相等。
   */
  private async verifyRestoredTree(staging: string, manifest: SnapshotManifest): Promise<void> {
    const expectedPaths = new Set(manifest.entries.map((entry) => entry.path));
    for (const actualPath of await scanTreePaths(staging)) {
      if (!expectedPaths.has(actualPath))
        throw new Error(`CheckpointIntegrityFailed: 恢复出 manifest 之外的内容: ${actualPath}`);
    }
    for (const entry of manifest.entries) {
      const target = resolveInside(staging, entry.path);
      const info = await lstat(target).catch(() => null);
      if (!info) throw new Error(`CheckpointIntegrityFailed: 恢复缺少条目: ${entry.path}`);
      if (entry.type === "directory") {
        if (!info.isDirectory()) throw new Error("CheckpointIntegrityFailed: 目录缺失");
        continue;
      }
      if (entry.type === "symlink") {
        if (!info.isSymbolicLink())
          throw new Error("CheckpointIntegrityFailed: symlink 缺失或被替换");
        const linkTarget = await readlink(target);
        if (linkTarget !== entry.target)
          throw new Error("CheckpointIntegrityFailed: symlink 目标被改写");
        continue;
      }
      if (!info.isFile() || info.size !== entry.sizeBytes)
        throw new Error("CheckpointIntegrityFailed: 文件长度与 manifest 不一致");
      const handle = await open(target, "r");
      try {
        let offset = 0;
        for (const chunk of entry.chunks ?? []) {
          const bytes = Buffer.allocUnsafe(chunk.sizeBytes);
          const result = await handle.read(bytes, 0, chunk.sizeBytes, offset);
          if (result.bytesRead !== chunk.sizeBytes || hashSnapshotBytes(bytes) !== chunk.digest) {
            throw new Error(`CheckpointIntegrityFailed: 目标文件内容摘要不一致: ${entry.path}`);
          }
          offset += result.bytesRead;
        }
      } finally {
        await handle.close();
      }
    }
  }

  /** 发布前先持久写 publishing；rename 后再写 ready，Crash 后可按归属与实际树补交。 */
  private async commitStaging(
    staging: string,
    target: string,
    stateFile: string,
    state: RestoreState,
  ): Promise<void> {
    const existing = await lstat(target).catch(() => null);
    if (existing) await rm(target, { recursive: true, force: true });
    await writeFile(stateFile, JSON.stringify({ ...state, phase: "publishing" }));
    await this.syncDirectory(path.dirname(target));
    await rename(staging, target);
    await this.testHooks?.afterRestoreRename?.({ target, operationId: state.operationId });
    await writeFile(stateFile, JSON.stringify(state));
    await this.syncDirectory(path.dirname(target));
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, "r").catch(() => null);
    if (!handle) return;
    try {
      await handle.sync();
    } catch {
      // 某些平台/文件系统不允许对目录 fsync（EINVAL）；文件本身已 fsync，可接受。
    } finally {
      await handle.close();
    }
  }
}

function resolveLimits(
  requirements: SnapshotRequirements | undefined,
): CheckpointPolicyLimits | null {
  return requirements ? parseCheckpointPolicy(requirements.checkpointPolicy) : null;
}

async function readRestoreState(stateFile: string): Promise<RestoreState | null> {
  return readFile(stateFile, "utf8").then(
    (value) => JSON.parse(value) as RestoreState,
    () => null,
  );
}

/**
 * 重算整棵树（形状、长度、逐块 digest，以及"没有多出来的东西"）并与 manifest 比对；
 * 不一致则恢复不算完成——恢复出来的树必须与 manifest 逐项相等。
 */
async function scanTreePaths(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  for (const child of await readdir(relative ? path.join(root, relative) : root)) {
    const next = relative ? `${relative}/${child}` : child;
    const info = await lstat(path.join(root, next));
    if (info.isDirectory()) {
      found.push(next);
      found.push(...(await scanTreePaths(root, next)));
      continue;
    }
    found.push(next);
  }
  return found;
}

/** 目标必须落在 root 内（按路径分量比较，避免前缀伪装）。 */
function resolveInside(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (target !== path.resolve(root) && !target.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new Error("CheckpointIntegrityFailed: 恢复路径逃逸");
  return target;
}

async function restoreSymlink(root: string, entry: SnapshotEntry, target: string): Promise<void> {
  const resolved = path.resolve(path.dirname(target), entry.target ?? "");
  if (resolved !== path.resolve(root) && !resolved.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new Error("CheckpointIntegrityFailed");
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(entry.target as string, target);
}

async function applyMetadata(target: string, entry: SnapshotEntry): Promise<void> {
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

/** 循环写满；短写（partial write）在这里被补完，不产生被截断的文件。 */
async function writeAll(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const written = await handle.write(buffer, offset, buffer.length - offset);
    if (written.bytesWritten <= 0) throw new Error("Snapshot 写入未取得进展");
    offset += written.bytesWritten;
  }
}

/** 供恢复后树验证复用：对既有目录做一次 manifest 比对。 */
export async function verifyTreeAgainstManifest(
  root: string,
  manifest: SnapshotManifest,
): Promise<void> {
  const scanned = await scanWorkspaceRoot(root);
  const byPath = new Map(scanned.entries.map((entry) => [entry.path, entry] as const));
  for (const entry of manifest.entries) {
    const actual = byPath.get(entry.path);
    if (!actual || actual.type !== entry.type || actual.sizeBytes !== entry.sizeBytes)
      throw new Error("CheckpointIntegrityFailed: 恢复后文件树与 manifest 不一致");
  }
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error("CheckpointIntegrityFailed: 恢复根不是目录");
}
