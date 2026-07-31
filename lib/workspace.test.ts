import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WorkspacePathError,
  WorkspaceRevisionConflict,
  deleteWorkspaceFile,
  isInternalDirName,
  isInternalPath,
  listWorkspaceFiles,
  readWorkspaceFile,
  readWorkspaceFileBytes,
  safeJoin,
  withPathLock,
  workspaceRoot,
  workspaceStat,
  writeWorkspaceFile,
  writeWorkspaceFileFromStream,
  writeWorkspaceFileWithRevision,
} from "@/lib/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 测试用的临时工作区根目录（独立 tmp 目录，便于构造 workspace 外部 symlink 目标）
const TEST_ROOT = resolve(".test-workspaces");
const TEST_CHAT_ID = "test-workspace-unit";

// 覆盖 workspaceConfig.root
const originalRoot = process.env.SNOW_WORKSPACES_DIR;

beforeEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = TEST_ROOT;
  await rm(join(TEST_ROOT, TEST_CHAT_ID), { recursive: true, force: true });
});

afterEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = originalRoot;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("workspace", () => {
  it("workspaceRoot 应返回正确路径", () => {
    const root = workspaceRoot(TEST_CHAT_ID);
    expect(root).toBe(resolve(TEST_ROOT, TEST_CHAT_ID));
  });

  it("writeWorkspaceFile 应创建文件并返回相对路径", async () => {
    const relPath = await writeWorkspaceFile(TEST_CHAT_ID, "src/index.html", "<h1>Hello</h1>");
    expect(relPath).toBe("src/index.html");

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(TEST_ROOT, TEST_CHAT_ID, "src/index.html"), "utf8");
    expect(content).toBe("<h1>Hello</h1>");
  });

  it("writeWorkspaceFile 应拒绝 .. 越界路径", async () => {
    await expect(writeWorkspaceFile(TEST_CHAT_ID, "../../etc/passwd", "hacked")).rejects.toThrow(
      "非法路径",
    );
  });

  it("listWorkspaceFiles 应递归列出文件", async () => {
    await writeWorkspaceFile(TEST_CHAT_ID, "index.html", "html");
    await writeWorkspaceFile(TEST_CHAT_ID, "src/app.js", "js");
    await writeWorkspaceFile(TEST_CHAT_ID, "src/styles/main.css", "css");

    const files = await listWorkspaceFiles(TEST_CHAT_ID);
    expect(files).toContain("index.html");
    expect(files).toContain("src/app.js");
    expect(files).toContain("src/styles/main.css");
  });

  it("listWorkspaceFiles 对空目录应返回空数组", async () => {
    const files = await listWorkspaceFiles("nonexistent-chat-id");
    expect(files).toEqual([]);
  });
});

describe("workspace read/delete/stat (切片 B2)", () => {
  it("写入→读出往返一致", async () => {
    await writeWorkspaceFile(TEST_CHAT_ID, "notes.txt", "hello world");
    const content = await readWorkspaceFile(TEST_CHAT_ID, "notes.txt");
    expect(content).toBe("hello world");
  });

  it("readWorkspaceFile 不存在文件 → null", async () => {
    const content = await readWorkspaceFile(TEST_CHAT_ID, "missing.txt");
    expect(content).toBeNull();
  });

  it("deleteWorkspaceFile 删除后 read → null", async () => {
    await writeWorkspaceFile(TEST_CHAT_ID, "tmp.txt", "x");
    const deleted = await deleteWorkspaceFile(TEST_CHAT_ID, "tmp.txt");
    expect(deleted).toBe(true);
    expect(await readWorkspaceFile(TEST_CHAT_ID, "tmp.txt")).toBeNull();
  });

  it("deleteWorkspaceFile 不存在文件 → false（静默）", async () => {
    const deleted = await deleteWorkspaceFile(TEST_CHAT_ID, "nope.txt");
    expect(deleted).toBe(false);
  });

  it("deleteWorkspaceFile 拒绝删除目录 → throw", async () => {
    await writeWorkspaceFile(TEST_CHAT_ID, "dir/keep.txt", "x");
    await expect(deleteWorkspaceFile(TEST_CHAT_ID, "dir")).rejects.toThrow(WorkspacePathError);
  });

  it("workspaceStat 返回 size / mtime / isDirectory / revision", async () => {
    await writeWorkspaceFile(TEST_CHAT_ID, "stat.txt", "12345");
    const st = await workspaceStat(TEST_CHAT_ID, "stat.txt");
    expect(st).not.toBeNull();
    expect(st?.size).toBe(5);
    expect(st?.mtime).toBeInstanceOf(Date);
    expect(st?.isDirectory).toBe(false);
    // V9 阶段 4：revision 格式为 `${size}:${mtimeMs}`，至少包含 size 前缀
    expect(typeof st?.revision).toBe("string");
    expect(st?.revision?.startsWith("5:")).toBe(true);
  });

  it("workspaceStat 目录 isDirectory=true", async () => {
    await writeWorkspaceFile(TEST_CHAT_ID, "d/a.txt", "x");
    const st = await workspaceStat(TEST_CHAT_ID, "d");
    expect(st?.isDirectory).toBe(true);
  });

  it("workspaceStat 不存在 → null", async () => {
    expect(await workspaceStat(TEST_CHAT_ID, "ghost.txt")).toBeNull();
  });
});

describe("workspace 越界防护（.. 四入口）(切片 B2)", () => {
  it("readWorkspaceFile 拒绝 .. 越界", async () => {
    await expect(readWorkspaceFile(TEST_CHAT_ID, "../../etc/passwd")).rejects.toThrow("非法路径");
  });

  it("writeWorkspaceFile 拒绝 .. 越界", async () => {
    await expect(writeWorkspaceFile(TEST_CHAT_ID, "../escape.txt", "x")).rejects.toThrow(
      "非法路径",
    );
  });

  it("deleteWorkspaceFile 拒绝 .. 越界", async () => {
    await expect(deleteWorkspaceFile(TEST_CHAT_ID, "../escape.txt")).rejects.toThrow("非法路径");
  });

  it("workspaceStat 拒绝 .. 越界", async () => {
    await expect(workspaceStat(TEST_CHAT_ID, "../escape.txt")).rejects.toThrow("非法路径");
  });
});

describe("threadId 格式校验（P0-1 路径穿越根因）", () => {
  it("workspaceRoot 拒绝含 .. 的 threadId", () => {
    expect(() => workspaceRoot("../../etc")).toThrow("非法 threadId");
  });

  it("workspaceRoot 拒绝含路径分隔符的 threadId", () => {
    expect(() => workspaceRoot("a/b")).toThrow("非法 threadId");
  });

  it("workspaceRoot 拒绝空串与超长串", () => {
    expect(() => workspaceRoot("")).toThrow("非法 threadId");
    expect(() => workspaceRoot("x".repeat(65))).toThrow("非法 threadId");
  });

  it("workspaceRoot 接受合法 UUID / 字母数字-串", () => {
    expect(() => workspaceRoot("01234567-89ab-cdef-0123-456789abcdef")).not.toThrow();
    expect(() => workspaceRoot("test-thread-123")).not.toThrow();
  });

  it("safeJoin 拒绝被污染 threadId（不依赖 root 合法性）", () => {
    expect(() => safeJoin("../../etc", "foo")).toThrow("非法 threadId");
  });
});

describe("workspace symlink 越界防护（四入口）(切片 B2)", () => {
  // 构造 workspace 内 symlink 指向 workspace 外部文件
  async function makeExternalSymlink(linkRel: string): Promise<string> {
    const root = workspaceRoot(TEST_CHAT_ID);
    await mkdir(root, { recursive: true });
    const external = resolve(tmpdir(), `snow-ws-ext-${TEST_CHAT_ID}.txt`);
    await writeFile(external, "external-secret", "utf8");
    const linkPath = join(root, linkRel);
    await symlink(external, linkPath);
    return external;
  }

  async function makeRootSymlinkToExternalWorkspace(): Promise<string> {
    const externalRoot = resolve(tmpdir(), `snow-ws-root-ext-${TEST_CHAT_ID}`);
    await rm(externalRoot, { recursive: true, force: true });
    await mkdir(externalRoot, { recursive: true });
    await writeFile(join(externalRoot, "secret.txt"), "external-secret", "utf8");
    await mkdir(TEST_ROOT, { recursive: true });
    await symlink(externalRoot, workspaceRoot(TEST_CHAT_ID));
    return externalRoot;
  }

  it("readWorkspaceFile 拒绝 workspace 内 symlink 指向外部", async () => {
    await makeExternalSymlink("link.txt");
    await expect(readWorkspaceFile(TEST_CHAT_ID, "link.txt")).rejects.toThrow(WorkspacePathError);
  });

  it("writeWorkspaceFile 拒绝覆盖 workspace 内 symlink", async () => {
    await makeExternalSymlink("link.txt");
    await expect(writeWorkspaceFile(TEST_CHAT_ID, "link.txt", "x")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  it("deleteWorkspaceFile 拒绝删除 symlink（而非 unlink 符号链接）", async () => {
    await makeExternalSymlink("link.txt");
    await expect(deleteWorkspaceFile(TEST_CHAT_ID, "link.txt")).rejects.toThrow(WorkspacePathError);
  });

  it("workspaceStat 拒绝 workspace 内 symlink", async () => {
    await makeExternalSymlink("link.txt");
    await expect(workspaceStat(TEST_CHAT_ID, "link.txt")).rejects.toThrow(WorkspacePathError);
  });

  it("writeWorkspaceFile 经 symlink 父目录写入被拒绝", async () => {
    await makeExternalSymlink("linkdir"); // symlink 当作目录前缀
    await expect(writeWorkspaceFile(TEST_CHAT_ID, "linkdir/file.txt", "x")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  it("listWorkspaceFiles 拒绝 workspace 根目录本身是 symlink", async () => {
    const externalRoot = await makeRootSymlinkToExternalWorkspace();
    try {
      await expect(listWorkspaceFiles(TEST_CHAT_ID)).rejects.toThrow(WorkspacePathError);
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it("read/write/delete/stat 拒绝 workspace 根目录本身是 symlink", async () => {
    const externalRoot = await makeRootSymlinkToExternalWorkspace();
    try {
      await expect(readWorkspaceFile(TEST_CHAT_ID, "secret.txt")).rejects.toThrow(
        WorkspacePathError,
      );
      await expect(writeWorkspaceFile(TEST_CHAT_ID, "new.txt", "x")).rejects.toThrow(
        WorkspacePathError,
      );
      await expect(deleteWorkspaceFile(TEST_CHAT_ID, "secret.txt")).rejects.toThrow(
        WorkspacePathError,
      );
      await expect(workspaceStat(TEST_CHAT_ID, "secret.txt")).rejects.toThrow(WorkspacePathError);
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});

describe("workspace 内部目录隐藏 (V5-B1)", () => {
  it("isInternalDirName 识别内部目录名", () => {
    expect(isInternalDirName(".snow")).toBe(true);
    expect(isInternalDirName(".git")).toBe(true);
    expect(isInternalDirName("node_modules")).toBe(true);
    expect(isInternalDirName(".next")).toBe(true);
    expect(isInternalDirName("dist")).toBe(true);
    expect(isInternalDirName("build")).toBe(true);
    expect(isInternalDirName(".cache")).toBe(true);
    expect(isInternalDirName(".turbo")).toBe(true);
    // 非内部目录
    expect(isInternalDirName("src")).toBe(false);
    expect(isInternalDirName("assets")).toBe(false);
    expect(isInternalDirName("README.md")).toBe(false);
  });

  it("isInternalPath 检查路径任意段", () => {
    expect(isInternalPath(".snow/secret.log")).toBe(true);
    expect(isInternalPath(".git/HEAD")).toBe(true);
    expect(isInternalPath("node_modules/react/index.js")).toBe(true);
    expect(isInternalPath("src/node_modules/app.js")).toBe(true); // 中段也命中
    expect(isInternalPath(".next/dev/types.d.ts")).toBe(true);
    // 非内部路径
    expect(isInternalPath("README.md")).toBe(false);
    expect(isInternalPath("src/app.js")).toBe(false);
    expect(isInternalPath("assets/logo.png")).toBe(false);
    // 反斜杠也识别
    expect(isInternalPath("node_modules\\react\\index.js")).toBe(true);
    // 空路径
    expect(isInternalPath("")).toBe(false);
    expect(isInternalPath("/")).toBe(false);
  });

  it("listWorkspaceFiles skipInternal=true 跳过内部目录", async () => {
    await writeWorkspaceFile(TEST_CHAT_ID, "index.html", "<h1>1</h1>");
    await writeWorkspaceFile(TEST_CHAT_ID, "README.md", "readme");
    await writeWorkspaceFile(TEST_CHAT_ID, "src/app.js", "app");
    // 内部目录文件——应该被跳过
    await writeWorkspaceFile(TEST_CHAT_ID, ".snow/log.txt", "secret");
    await writeWorkspaceFile(TEST_CHAT_ID, "node_modules/react/index.js", "module");
    await writeWorkspaceFile(TEST_CHAT_ID, ".next/types.d.ts", "types");
    await writeWorkspaceFile(TEST_CHAT_ID, ".git/HEAD", "ref: refs/heads/main");

    const files = await listWorkspaceFiles(TEST_CHAT_ID, { skipInternal: true });
    expect(files).toEqual(expect.arrayContaining(["index.html", "README.md", "src/app.js"]));
    // 内部目录下的文件不出现在前台
    expect(files).not.toContain(".snow/log.txt");
    expect(files).not.toContain("node_modules/react/index.js");
    expect(files).not.toContain(".next/types.d.ts");
    expect(files).not.toContain(".git/HEAD");
    // 仅前台可见文件
    expect(files.length).toBe(3);
  });

  it("listWorkspaceFiles 默认 skipInternal=false 列出全部文件（向后兼容）", async () => {
    await writeWorkspaceFile(TEST_CHAT_ID, "index.html", "<h1>1</h1>");
    await writeWorkspaceFile(TEST_CHAT_ID, ".snow/log.txt", "secret");

    const files = await listWorkspaceFiles(TEST_CHAT_ID);
    expect(files).toContain("index.html");
    expect(files).toContain(".snow/log.txt");
  });
});

describe("withPathLock 并发互斥 (V6-M2-3)", () => {
  it("同 path 并发调用串行执行，不丢失写入", async () => {
    // 准备初始文件
    await writeWorkspaceFile(TEST_CHAT_ID, "counter.txt", "0");
    const lockKey = `${TEST_CHAT_ID}:counter.txt`;

    // 并发发起 5 个 read-modify-write（每个 +1）
    const tasks = Array.from({ length: 5 }, () =>
      withPathLock(lockKey, async () => {
        const raw = (await readWorkspaceFile(TEST_CHAT_ID, "counter.txt")) ?? "0";
        const n = Number.parseInt(raw, 10);
        // 模拟异步间隙（让出控制权，验证锁确实串行化）
        await new Promise((r) => setTimeout(r, 5));
        await writeWorkspaceFile(TEST_CHAT_ID, "counter.txt", String(n + 1));
      }),
    );

    await Promise.all(tasks);

    // 串行执行 → 最终值应为 5（无丢失）
    const final = await readWorkspaceFile(TEST_CHAT_ID, "counter.txt");
    expect(final).toBe("5");
  });

  it("不同 path 互不阻塞", async () => {
    const order: string[] = [];
    const lockA = `${TEST_CHAT_ID}:a.txt`;
    const lockB = `${TEST_CHAT_ID}:b.txt`;

    const pA = withPathLock(lockA, async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("A");
    });
    const pB = withPathLock(lockB, async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("B");
    });

    await Promise.all([pA, pB]);
    // B 先完成（延迟更短），说明不同 path 并发无互斥
    expect(order).toEqual(["B", "A"]);
  });
});

describe("writeWorkspaceFileWithRevision (V9 阶段 4)", () => {
  it("不带 revision → 直接写入新文件，返回 stat 含 revision", async () => {
    const stat = await writeWorkspaceFileWithRevision(TEST_CHAT_ID, "new.txt", "hello");
    expect(stat.size).toBe(5);
    expect(typeof stat.revision).toBe("string");
    expect(await readWorkspaceFile(TEST_CHAT_ID, "new.txt")).toBe("hello");
  });

  it("revision 匹配 → 写入成功，返回新 revision", async () => {
    await writeWorkspaceFile(TEST_CHAT_ID, "edit.txt", "old");
    const before = await workspaceStat(TEST_CHAT_ID, "edit.txt");
    if (!before) throw new Error("test setup: workspaceStat 返回 null");

    const stat = await writeWorkspaceFileWithRevision(
      TEST_CHAT_ID,
      "edit.txt",
      "new content",
      before.revision,
    );
    expect(await readWorkspaceFile(TEST_CHAT_ID, "edit.txt")).toBe("new content");
    // 内容变化后 revision 改变
    expect(stat.revision).not.toBe(before.revision);
  });

  it("revision 不匹配 → 抛 WorkspaceRevisionConflict，携带当前内容与 revision", async () => {
    await writeWorkspaceFile(TEST_CHAT_ID, "conflict.txt", "original");
    const stale = await workspaceStat(TEST_CHAT_ID, "conflict.txt");
    if (!stale) throw new Error("test setup: workspaceStat 返回 null");
    // 模拟 AI 写入导致 revision 变化
    await writeWorkspaceFile(TEST_CHAT_ID, "conflict.txt", "AI changed");

    await expect(
      writeWorkspaceFileWithRevision(TEST_CHAT_ID, "conflict.txt", "user edit", stale.revision),
    ).rejects.toMatchObject({
      currentRevision: expect.any(String),
      currentContent: "AI changed",
    });
    // 用户编辑未被写入（不静默覆盖）
    expect(await readWorkspaceFile(TEST_CHAT_ID, "conflict.txt")).toBe("AI changed");
  });

  it("revision 不匹配时抛出 WorkspaceRevisionConflict 类型", async () => {
    await writeWorkspaceFile(TEST_CHAT_ID, "type.txt", "v1");
    const stale = await workspaceStat(TEST_CHAT_ID, "type.txt");
    if (!stale) throw new Error("test setup: workspaceStat 返回 null");
    // 用不同长度内容确保 revision 变化（size 不同）
    await writeWorkspaceFile(TEST_CHAT_ID, "type.txt", "version2-content");

    await expect(
      writeWorkspaceFileWithRevision(TEST_CHAT_ID, "type.txt", "v3", stale.revision),
    ).rejects.toBeInstanceOf(WorkspaceRevisionConflict);
  });

  it("内部目录路径 → 抛 WorkspacePathError", async () => {
    await expect(
      writeWorkspaceFileWithRevision(TEST_CHAT_ID, ".snow/secret.txt", "x"),
    ).rejects.toThrow(WorkspacePathError);
  });
});

describe("writeWorkspaceFileFromStream (V10 Phase 7-1)", () => {
  /** 将 Buffer 数组封装为 Web ReadableStream（模拟 request.body）。 */
  function toWebStream(chunks: Buffer[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new Uint8Array(chunk));
        }
        controller.close();
      },
    });
  }

  it("流式写入文件，size 与字节数一致", async () => {
    const content = "hello stream world";
    const stream = toWebStream([Buffer.from(content, "utf8")]);
    const result = await writeWorkspaceFileFromStream(TEST_CHAT_ID, "downloads/test.txt", stream);
    expect(result.size).toBe(Buffer.byteLength(content, "utf8"));

    // 内容可读回（用 readWorkspaceFileBytes 校验）
    const bytes = await readWorkspaceFileBytes(TEST_CHAT_ID, "downloads/test.txt");
    expect(bytes).not.toBeNull();
    const buf = Buffer.from(bytes as Uint8Array);
    expect(buf.toString("utf8")).toBe(content);
  });

  it("分多次 chunk 流式写入，最终拼接正确", async () => {
    const chunks = ["AAAA", "BBBB", "CCCC"];
    const stream = toWebStream(chunks.map((c) => Buffer.from(c, "utf8")));
    const result = await writeWorkspaceFileFromStream(TEST_CHAT_ID, "downloads/multi.bin", stream);
    expect(result.size).toBe(12);
    const bytes = await readWorkspaceFileBytes(TEST_CHAT_ID, "downloads/multi.bin");
    expect(Buffer.from(bytes as Uint8Array).toString("utf8")).toBe("AAAABBBBCCCC");
  });

  it("自动建父目录", async () => {
    const stream = toWebStream([Buffer.from("x")]);
    await writeWorkspaceFileFromStream(TEST_CHAT_ID, "downloads/nested/deep/file.txt", stream);
    const bytes = await readWorkspaceFileBytes(TEST_CHAT_ID, "downloads/nested/deep/file.txt");
    expect(bytes).not.toBeNull();
  });

  it("拒绝 .. 越界路径", async () => {
    const stream = toWebStream([Buffer.from("x")]);
    await expect(
      writeWorkspaceFileFromStream(TEST_CHAT_ID, "../../etc/passwd", stream),
    ).rejects.toThrow(WorkspacePathError);
  });

  it("覆盖已存在文件（原子 rename）", async () => {
    // 先写旧内容
    await writeWorkspaceFile(TEST_CHAT_ID, "downloads/overwritable.txt", "old-content");
    // 流式写入新内容
    const stream = toWebStream([Buffer.from("new-content")]);
    await writeWorkspaceFileFromStream(TEST_CHAT_ID, "downloads/overwritable.txt", stream);
    const content = await readWorkspaceFile(TEST_CHAT_ID, "downloads/overwritable.txt");
    expect(content).toBe("new-content");
  });

  it("空流写入返回 size=0", async () => {
    const stream = toWebStream([]);
    const result = await writeWorkspaceFileFromStream(TEST_CHAT_ID, "downloads/empty.bin", stream);
    expect(result.size).toBe(0);
    const stat = await workspaceStat(TEST_CHAT_ID, "downloads/empty.bin");
    expect(stat?.size).toBe(0);
  });
});
