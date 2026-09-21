import { spawnSync } from "node:child_process";
/**
 * Snapshot 格式、并发/崩溃安全写入与 Restore 幂等（R09 §5/§6/§7）。
 *
 * 全部用例都在真实文件系统上跑真实读写（staging、fsync、rename、link、chmod），
 * 不使用内存 mock——被验收的正是这些机制本身。
 */
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type SnapshotManifest,
  parseCheckpointPolicy,
  validateSnapshotManifest,
} from "@/lib/workspace/snapshot-manifest";
import { FileSnapshotStorage, type SnapshotRequirements } from "@/lib/workspace/snapshot-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CHUNK_BYTES = 4 * 1024 * 1024;

const semantics = {
  kind: "portable",
  caseSensitive: true,
  symlinks: true,
  permissions: true,
  hardlinks: false,
  specialFiles: false,
  xattrsAcl: false,
  mtime: "preserved",
} as const;

function requirements(overrides: Record<string, unknown> = {}): SnapshotRequirements {
  return {
    checkpointPolicy: {
      safePointTimeoutSeconds: 120,
      chunkBytes: CHUNK_BYTES,
      maxTotalBytes: "10485760",
      maxEntries: 200,
      trigger: "before_suspend_and_explicit",
      retention: "retain_while_referenced",
      ...overrides,
    },
    filesystemSemantics: semantics,
  };
}

describe("Snapshot storage (R09 §5/§6/§7)", () => {
  let root: string;
  let source: string;
  let storageRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "snow-snapshot-"));
    source = path.join(root, "writer");
    storageRoot = path.join(root, "storage");
    await mkdir(source, { recursive: true });
    await mkdir(storageRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("SNAPSHOT-01: CheckpointPolicy 缺失上限即 fail-closed，声明与实现不一致也拒绝", async () => {
    expect(() => parseCheckpointPolicy(null)).toThrow(/CheckpointPolicy 缺失/);
    expect(() => parseCheckpointPolicy({ maxTotalBytes: "1", chunkBytes: CHUNK_BYTES })).toThrow(
      /maxEntries/,
    );
    expect(() =>
      parseCheckpointPolicy({
        maxEntries: 1,
        maxTotalBytes: "1",
        chunkBytes: CHUNK_BYTES / 2,
      }),
    ).toThrow(/chunkBytes/);
    expect(() =>
      parseCheckpointPolicy({
        maxEntries: 1,
        maxTotalBytes: "10",
        maxFileBytes: "100",
        chunkBytes: CHUNK_BYTES,
      }),
    ).toThrow(/maxFileBytes/);
    // 缺省 maxFileBytes 收敛到 maxTotalBytes：单文件不可能超过总上限。
    expect(
      parseCheckpointPolicy({ maxEntries: 5, maxTotalBytes: "1024", chunkBytes: CHUNK_BYTES }),
    ).toEqual({ maxEntries: 5, maxTotalBytes: 1024, maxFileBytes: 1024, chunkBytes: CHUNK_BYTES });
  });

  it("SNAPSHOT-02: 超出 ChatpointPolicy 条目/总量/单文件上限的 Snapshot 不被提交", async () => {
    await writeFile(path.join(source, "a.txt"), "0123456789", "utf8");
    await writeFile(path.join(source, "b.txt"), "0123456789", "utf8");
    const storage = new FileSnapshotStorage(storageRoot);
    // 总量上限 10 字节 < 实际 20 字节。
    await expect(
      storage.writeSnapshot(source, randomUUID(), requirements({ maxTotalBytes: "10" })),
    ).rejects.toThrow(/总字节超过 CheckpointPolicy 上限/);
    // 条目数上限 1 < 实际 2。
    await expect(
      storage.writeSnapshot(source, randomUUID(), requirements({ maxEntries: 1 })),
    ).rejects.toThrow(/条目数超过 CheckpointPolicy 上限/);
    // 单文件上限 5 < 文件 10 字节。
    await expect(
      storage.writeSnapshot(
        source,
        randomUUID(),
        requirements({ maxFileBytes: "5", maxTotalBytes: "1048576" }),
      ),
    ).rejects.toThrow(/单文件超过 CheckpointPolicy 上限/);
    // 未被接受的上限不能留下正式 manifest。
    expect(await readdir(path.join(storageRoot, "manifests"))).toEqual([]);
  });

  it("SNAPSHOT-03: hardlink 与 setuid 内容被显式拒绝，而不是静默降级为副本", async () => {
    const target = path.join(source, "original.txt");
    await writeFile(target, "shared", "utf8");
    await link(target, path.join(source, "hardlink.txt"));
    const storage = new FileSnapshotStorage(storageRoot);
    await expect(storage.writeSnapshot(source, randomUUID(), requirements())).rejects.toThrow(
      /不支持 hardlink/,
    );
    await rm(path.join(source, "hardlink.txt"));
    // Node 的 fs.chmod 与 `chmod` CLI 都会丢掉 setuid 位，只有直接 chmod(2)（这里经 Python）
    // 才能造出这条路真实会遇到的输入。
    const chmodded = spawnSync("python3", [
      "-c",
      "import os,sys; os.chmod(sys.argv[1], 0o4755)",
      target,
    ]);
    if (chmodded.status !== 0) throw new Error(`chmod 失败: ${chmodded.stderr?.toString()}`);
    expect((await lstat(target)).mode & 0o7000).toBe(0o4000);
    await expect(storage.writeSnapshot(source, randomUUID(), requirements())).rejects.toThrow(
      /setuid\/setgid\/sticky/,
    );
  });

  it("SNAPSHOT-04: profile 声明本实现不具备的能力（hardlinks/xattrsAcl）必须被拒", async () => {
    await writeFile(path.join(source, "a.txt"), "x", "utf8");
    const storage = new FileSnapshotStorage(storageRoot);
    await expect(
      storage.writeSnapshot(source, randomUUID(), {
        checkpointPolicy: requirements().checkpointPolicy,
        filesystemSemantics: { ...semantics, hardlinks: true } as never,
      }),
    ).rejects.toThrow(/不得声明 hardlinks/);
    await expect(
      storage.writeSnapshot(source, randomUUID(), {
        checkpointPolicy: requirements().checkpointPolicy,
        filesystemSemantics: { ...semantics, xattrsAcl: true } as never,
      }),
    ).rejects.toThrow(/不得声明 xattrsAcl/);
  });

  it("SNAPSHOT-05: 既有同 digest 内容块损坏时报错隔离，不返回 Checkpoint 回执", async () => {
    const payload = "content-addressed payload";
    await writeFile(path.join(source, "a.txt"), payload, "utf8");
    const { createHash } = await import("node:crypto");
    const digest = `sha256:${createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex")}`;
    const chunkPath = path.join(storageRoot, "chunks", digest.slice(7));
    await mkdir(path.dirname(chunkPath), { recursive: true });
    // 预置一个"存在但内容不对"的块：仅存在不代表内容正确。
    await writeFile(chunkPath, "tampered", "utf8");
    const storage = new FileSnapshotStorage(storageRoot);
    await expect(storage.writeSnapshot(source, randomUUID(), requirements())).rejects.toThrow(
      /内容块损坏/,
    );
    expect(await readdir(path.join(storageRoot, "manifests"))).toEqual([]);
  });

  it("SNAPSHOT-06: 相同内容并发复用同一块，staging 文件按 operation 唯一且不残留", async () => {
    const payload = "identical bytes";
    await writeFile(path.join(source, "a.txt"), payload, "utf8");
    await mkdir(path.join(source, "nested"), { recursive: true });
    await writeFile(path.join(source, "nested", "b.txt"), payload, "utf8");
    const storage = new FileSnapshotStorage(storageRoot);
    // 两个并发 operation 写同一内容：不得共享同一临时文件，也不得把 EEXIST 当损坏。
    const [first, second] = await Promise.all([
      storage.writeSnapshot(source, `op-${randomUUID()}`, requirements()),
      storage.writeSnapshot(source, `op-${randomUUID()}`, requirements()),
    ]);
    expect(first.receipt.chunks).toEqual(second.receipt.chunks);
    expect(first.receipt.chunks).toHaveLength(1);
    const chunkFiles = await readdir(path.join(storageRoot, "chunks"));
    expect(chunkFiles).toHaveLength(1);
    expect(chunkFiles.every((name) => !name.endsWith(".staging"))).toBe(true);
    // 复用块必须仍能被读回校验。
    const reused = await readFile(path.join(storageRoot, "chunks", chunkFiles[0]!));
    expect(reused.toString("utf8")).toBe(payload);
  });

  it("SNAPSHOT-07 / N08-T5: 正常恢复先落 operation staging，发布树与 manifest 逐项相等", async () => {
    await writeFile(path.join(source, "a.txt"), "alpha", "utf8");
    await mkdir(path.join(source, "sub"), { recursive: true });
    await writeFile(path.join(source, "sub", "b.txt"), "beta", "utf8");
    const storage = new FileSnapshotStorage(storageRoot);
    const { manifest } = await storage.writeSnapshot(source, "op-1", requirements());
    const destination = path.join(root, "candidate");
    await storage.restoreSnapshot(manifest, destination, "op-1", requirements());
    const expectedPaths = manifest.entries.map((entry) => entry.path).sort();
    const actualPaths: string[] = [];
    async function walk(relative: string): Promise<void> {
      for (const child of await readdir(path.join(destination, relative))) {
        const next = relative ? `${relative}/${child}` : child;
        actualPaths.push(next);
        const info = await lstat(path.join(destination, next));
        if (info.isDirectory()) await walk(next);
      }
    }
    await walk("");
    expect(actualPaths.sort()).toEqual(expectedPaths);
    // 控制状态在树外，不污染恢复内容。
    expect(await lstat(`${destination}.staging`).catch(() => null)).toBeNull();
    const state = JSON.parse(await readFile(`${destination}.restore-state.json`, "utf8")) as {
      phase: string;
    };
    expect(state.phase).toBe("ready");
    // 幂等：重复恢复同一 manifest 不再重写内容。
    await storage.restoreSnapshot(manifest, destination, "op-1", requirements());
    expect(await readFile(path.join(destination, "sub", "b.txt"), "utf8")).toBe("beta");
  });

  it("SNAPSHOT-08: 部分恢复留下的 staging 可安全重建，他人的 staging 与已占用目标被拒", async () => {
    await writeFile(path.join(source, "a.txt"), "alpha", "utf8");
    const storage = new FileSnapshotStorage(storageRoot);
    const { manifest } = await storage.writeSnapshot(source, "op-1", requirements());
    const destination = path.join(root, "candidate");
    // 模拟"上一次恢复中途 Crash"：staging 存在、状态为 staging 且属于同一 operation。
    await mkdir(`${destination}.staging`, { recursive: true });
    await writeFile(path.join(`${destination}.staging`, "partial.txt"), "partial", "utf8");
    await writeFile(
      `${destination}.restore-state.json`,
      JSON.stringify({
        operationId: "op-1",
        manifestDigest: manifest.manifestDigest,
        phase: "staging",
      }),
    );
    await storage.restoreSnapshot(manifest, destination, "op-1", requirements());
    expect(await readFile(path.join(destination, "a.txt"), "utf8")).toBe("alpha");
    // 他人的 staging 不能被覆盖。
    const other = path.join(root, "other");
    await mkdir(`${other}.staging`, { recursive: true });
    await writeFile(
      `${other}.restore-state.json`,
      JSON.stringify({
        operationId: "someone-else",
        manifestDigest: manifest.manifestDigest,
        phase: "staging",
      }),
    );
    await expect(storage.restoreSnapshot(manifest, other, "op-1", requirements())).rejects.toThrow(
      /staging 属于其他恢复操作/,
    );
    // 目标已被非本次恢复的内容占用 → 拒绝。
    const occupied = path.join(root, "occupied");
    await mkdir(occupied, { recursive: true });
    await writeFile(path.join(occupied, "foreign.txt"), "mine", "utf8");
    await expect(
      storage.restoreSnapshot(manifest, occupied, "op-1", requirements()),
    ).rejects.toThrow(/已被占用/);
    // 目标是 symlink → 拒绝（防跟随链接）。
    const linkTarget = path.join(root, "link-target");
    await mkdir(linkTarget, { recursive: true });
    await symlink(linkTarget, path.join(root, "link-dest"));
    await expect(
      storage.restoreSnapshot(manifest, path.join(root, "link-dest"), "op-1", requirements()),
    ).rejects.toThrow(/不能是 symlink/);
  });

  it("SNAPSHOT-09: 篡改后的 manifest（内容被换、字段自洽）被 contentRootDigest 重算拦下", async () => {
    await writeFile(path.join(source, "a.txt"), "alpha", "utf8");
    const storage = new FileSnapshotStorage(storageRoot);
    const { manifest } = await storage.writeSnapshot(source, "op-1", requirements());
    // 只替换块引用，保持所有长度/计数自洽：字段级校验看不出来，必须靠重算摘要。
    const tampered: SnapshotManifest = {
      ...manifest,
      entries: manifest.entries.map((entry) =>
        entry.type === "file"
          ? {
              ...entry,
              chunks: (entry.chunks ?? []).map((chunk) => ({
                ...chunk,
                digest: `sha256:${"0".repeat(64)}`,
              })),
            }
          : entry,
      ),
    };
    expect(() => validateSnapshotManifest(tampered)).toThrow(/contentRootDigest 不匹配/);
  });

  it("N08-T3: ready 标记不能替代目标树字节核验", async () => {
    await writeFile(path.join(source, "a.txt"), "alpha", "utf8");
    const storage = new FileSnapshotStorage(storageRoot);
    const { manifest } = await storage.writeSnapshot(source, "restore-source", requirements());
    const cases = [
      {
        name: "same-length-tamper",
        mutate: (destination: string) =>
          writeFile(path.join(destination, "a.txt"), "ALPHA", "utf8"),
      },
      {
        name: "missing-entry",
        mutate: (destination: string) => rm(path.join(destination, "a.txt")),
      },
      {
        name: "extra-entry",
        mutate: (destination: string) =>
          writeFile(path.join(destination, "extra.txt"), "extra", "utf8"),
      },
    ];
    for (const candidate of cases) {
      const destination = path.join(root, candidate.name);
      await storage.restoreSnapshot(manifest, destination, candidate.name, requirements());
      // 源 chunk 与 ready 标记保持正确，仅篡改实际目标树。若实现只核源存储或 marker，
      // 同长度改写、缺项、多项都会被错误地当作已完成。
      await candidate.mutate(destination);
      await expect(
        storage.restoreSnapshot(manifest, destination, candidate.name, requirements()),
      ).rejects.toThrow(/目标.*manifest|实际内容|内容摘要/);
    }
  });

  it("N08-T4: rename 已发布但 ready 尚未提交时，同一恢复意图可据实际内容收口", async () => {
    await writeFile(path.join(source, "a.txt"), "alpha", "utf8");
    const storage = new FileSnapshotStorage(storageRoot);
    const { manifest } = await storage.writeSnapshot(source, "restore-crash", requirements());
    const destination = path.join(root, "candidate");

    // 先得到一棵真实、经过验证的发布树，再把 marker 回退到 rename 前的持久阶段，模拟
    // 进程在 rename 成功、ready marker 落盘之前被杀。重试不能永久报 occupied。
    await storage.restoreSnapshot(manifest, destination, "restore-crash", requirements());
    await writeFile(
      `${destination}.restore-state.json`,
      JSON.stringify({
        operationId: "restore-crash",
        manifestDigest: manifest.manifestDigest,
        phase: "publishing",
      }),
    );
    await storage.restoreSnapshot(manifest, destination, "restore-crash", requirements());
    const state = JSON.parse(await readFile(`${destination}.restore-state.json`, "utf8")) as {
      operationId: string;
      phase: string;
    };
    expect(state).toMatchObject({ operationId: "restore-crash", phase: "ready" });
    expect(await readFile(path.join(destination, "a.txt"), "utf8")).toBe("alpha");
  });
});
