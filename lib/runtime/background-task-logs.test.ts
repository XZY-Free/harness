import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLog,
  readFullLog,
  readLog,
  relativeLogPath,
  resolveContainerLogPath,
  resolveHostLogPath,
  resolveLogPath,
} from "./background-task-logs";

/**
 * V3.2 Stage A：后台任务日志读写单测。
 * 真实文件 IO（tmpdir），覆盖 append / offset / tail / window / 限长 / 越界 / 文件不存在。
 */

let dir: string;
const origHostLogDir = process.env.SNOW_BG_TASK_HOST_LOG_DIR;
const origMaxBytes = process.env.SNOW_BG_TASK_MAX_LOG_BYTES;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "snow-bg-logs-"));
  process.env.SNOW_BG_TASK_HOST_LOG_DIR = dir;
  process.env.SNOW_BG_TASK_MAX_LOG_BYTES = String(64 * 1024);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  if (origHostLogDir === undefined) delete process.env.SNOW_BG_TASK_HOST_LOG_DIR;
  else process.env.SNOW_BG_TASK_HOST_LOG_DIR = origHostLogDir;
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  if (origMaxBytes === undefined) delete process.env.SNOW_BG_TASK_MAX_LOG_BYTES;
  else process.env.SNOW_BG_TASK_MAX_LOG_BYTES = origMaxBytes;
});

describe("relativeLogPath / resolveLogPath", () => {
  it("相对路径形如 .snow/runtime/{threadId}/tasks/{taskId}.log", () => {
    const rel = relativeLogPath("t1", "task-9");
    expect(rel).toBe([".snow", "runtime", "t1", "tasks", "task-9.log"].join(sep));
  });

  it("host 解析到 hostLogDir 之下（非 workspace）", () => {
    const abs = resolveHostLogPath("t1", "task-9");
    expect(abs.startsWith(resolve(dir))).toBe(true);
    expect(abs).toContain("t1");
    expect(abs).toContain("task-9.log");
  });

  it("container 解析到 workspace bind mount 根下", () => {
    const orig = process.env.SNOW_WORKSPACES_DIR;
    process.env.SNOW_WORKSPACES_DIR = dir;
    try {
      const abs = resolveContainerLogPath("t1", "task-9");
      expect(abs.startsWith(resolve(dir, "t1"))).toBe(true);
      expect(abs).toContain("task-9.log");
    } finally {
      // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
      if (orig === undefined) delete process.env.SNOW_WORKSPACES_DIR;
      else process.env.SNOW_WORKSPACES_DIR = orig;
    }
  });

  it("resolveLogPath 按 runtimeType 选基目录", () => {
    const rel = relativeLogPath("t1", "task-9");
    const hostAbs = resolveLogPath(rel, "host", "t1");
    expect(hostAbs.startsWith(resolve(dir))).toBe(true);
    // container 基目录为 workspaceRoot（受 SNOW_WORKSPACES_DIR 影响）
    const orig = process.env.SNOW_WORKSPACES_DIR;
    process.env.SNOW_WORKSPACES_DIR = dir;
    try {
      const containerAbs = resolveLogPath(rel, "container", "t1");
      expect(containerAbs.startsWith(resolve(dir, "t1"))).toBe(true);
    } finally {
      // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
      if (orig === undefined) delete process.env.SNOW_WORKSPACES_DIR;
      else process.env.SNOW_WORKSPACES_DIR = orig;
    }
  });
});

describe("appendLog / readLog 基础", () => {
  it("append 写入并可读全量", async () => {
    const p = resolve(dir, "a.log");
    await appendLog(p, "hello\n");
    await appendLog(p, "world\n");
    expect(await readFullLog(p)).toBe("hello\nworld\n");
  });

  it("append 自动建父目录", async () => {
    const p = resolve(dir, "nested", "dir", "b.log");
    await appendLog(p, "x");
    expect((await readFullLog(p)).length).toBe(1);
  });

  it("文件不存在 → 空内容 + totalBytes 0", async () => {
    const r = await readLog(resolve(dir, "missing.log"));
    expect(r.content).toBe("");
    expect(r.totalBytes).toBe(0);
    expect(r.truncated).toBe(false);
  });

  // S1 修复（02-P1-7）：日志轮转
  it("appendLog 超 maxLogFileSize 时轮转（保留尾部一半）", async () => {
    const orig = process.env.SNOW_BG_TASK_MAX_LOG_FILE_SIZE;
    process.env.SNOW_BG_TASK_MAX_LOG_FILE_SIZE = "100"; // 100 bytes cap
    try {
      const p = resolve(dir, "rotate.log");
      // 写 110 字节（首次 append 时文件为空不轮转 → 110 字节）
      await appendLog(p, "A".repeat(110));
      expect((await readFullLog(p)).length).toBe(110);
      // 再 append 30 字节：append 前 size=110 > 100 → 轮转保留尾部 50 + 新 30 = 80
      await appendLog(p, "B".repeat(30));
      const content = await readFullLog(p);
      expect(content.length).toBe(80);
      expect(content.endsWith("B".repeat(30))).toBe(true);
      expect(content.startsWith("A".repeat(50))).toBe(true); // 尾部保留的是 A
    } finally {
      if (orig === undefined) {
        // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
        delete process.env.SNOW_BG_TASK_MAX_LOG_FILE_SIZE;
      } else {
        process.env.SNOW_BG_TASK_MAX_LOG_FILE_SIZE = orig;
      }
    }
  });
});

describe("readLog offset / window", () => {
  it("offset 读取从指定字节开始", async () => {
    const p = resolve(dir, "c.log");
    await writeFile(p, "0123456789");
    const r = await readLog(p, { offset: 3 });
    expect(r.content).toBe("3456789");
    expect(r.offset).toBe(3);
    expect(r.totalBytes).toBe(10);
    expect(r.truncated).toBe(false);
  });

  it("window 限制返回长度", async () => {
    const p = resolve(dir, "d.log");
    await writeFile(p, "0123456789");
    const r = await readLog(p, { offset: 2, window: 4 });
    expect(r.content).toBe("2345");
    expect(r.truncated).toBe(false);
  });

  it("window 超出文件尾 → 返回剩余，不截断", async () => {
    const p = resolve(dir, "e.log");
    await writeFile(p, "0123456789");
    const r = await readLog(p, { offset: 7, window: 100 });
    expect(r.content).toBe("789");
    expect(r.truncated).toBe(false);
  });

  it("offset 越界 → 空内容，totalBytes 仍真实", async () => {
    const p = resolve(dir, "f.log");
    await writeFile(p, "abc");
    const r = await readLog(p, { offset: 99 });
    expect(r.content).toBe("");
    expect(r.totalBytes).toBe(3);
    expect(r.offset).toBe(99);
  });
});

describe("readLog tail", () => {
  it("tail 返回最后 N 字节，offset 置为 totalBytes-N", async () => {
    const p = resolve(dir, "g.log");
    await writeFile(p, "0123456789");
    const r = await readLog(p, { tail: 4 });
    expect(r.content).toBe("6789");
    expect(r.offset).toBe(6);
    expect(r.totalBytes).toBe(10);
  });

  it("tail 大于文件 → 返回全量，offset=0", async () => {
    const p = resolve(dir, "h.log");
    await writeFile(p, "abc");
    const r = await readLog(p, { tail: 100 });
    expect(r.content).toBe("abc");
    expect(r.offset).toBe(0);
  });
});

describe("readLog 限长 maxBytes", () => {
  it("超过 maxBytes → 截断并置 truncated=true", async () => {
    const p = resolve(dir, "i.log");
    await writeFile(p, "0123456789");
    const r = await readLog(p, { offset: 0, maxBytes: 4 });
    expect(r.content).toBe("0123");
    expect(r.truncated).toBe(true);
    expect(r.totalBytes).toBe(10);
  });

  it("tail 受 maxBytes 约束", async () => {
    const p = resolve(dir, "j.log");
    await writeFile(p, "0123456789");
    const r = await readLog(p, { tail: 8, maxBytes: 4 });
    expect(r.content).toBe("6789");
    expect(r.truncated).toBe(true);
  });
});
