import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * V3.6 Stage A：QA 证据落盘 / 路径 / 事件 payload 单测。
 * 路径解析复用 backgroundTaskConfig.hostLogDir（设临时目录隔离）。
 */

const TEST_LOG_DIR = resolve(".test-qa-artifacts");
const origLogDir = process.env.SNOW_BG_TASK_HOST_LOG_DIR;
const TID = "qa-artifact-thread";

beforeEach(async () => {
  process.env.SNOW_BG_TASK_HOST_LOG_DIR = TEST_LOG_DIR;
  await rm(TEST_LOG_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  process.env.SNOW_BG_TASK_HOST_LOG_DIR = origLogDir;
  await rm(TEST_LOG_DIR, { recursive: true, force: true });
});

import {
  buildQaFailedPayload,
  buildQaPassedPayload,
  cleanupQaArtifacts,
  readQaArtifact,
  relQaPath,
  resolveQaDir,
  resolveQaPath,
  saveQaReport,
  saveScreenshot,
} from "@/lib/qa/artifact";

describe("路径解析", () => {
  it("resolveQaDir = hostLogDir/{threadId}/qa", () => {
    expect(resolveQaDir(TID)).toBe(resolve(TEST_LOG_DIR, TID, "qa"));
  });
  it("resolveQaPath 追加文件名", () => {
    expect(resolveQaPath(TID, "chk1.json")).toBe(resolve(TEST_LOG_DIR, TID, "qa", "chk1.json"));
  });
  it("relQaPath 不暴露绝对路径，相对 hostLogDir", () => {
    expect(relQaPath(TID, "chk1.png")).toBe(`${TID}/qa/chk1.png`);
  });
});

describe("saveScreenshot", () => {
  it("落盘 png 并返回相对路径", async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const rel = await saveScreenshot(TID, "chk1", buf, 375);
    expect(rel).toBe(`${TID}/qa/chk1-375.png`);
    const abs = resolveQaPath(TID, "chk1-375.png");
    expect((await readFile(abs)).equals(buf)).toBe(true);
  });
  it("无 viewport → 文件名不带后缀", async () => {
    const rel = await saveScreenshot(TID, "chk2", Buffer.from("x"));
    expect(rel).toBe(`${TID}/qa/chk2.png`);
  });
});

describe("saveQaReport", () => {
  it("落盘 JSON 并返回相对路径", async () => {
    const report = { ok: true, failures: [] };
    const rel = await saveQaReport(TID, "chk3", report);
    expect(rel).toBe(`${TID}/qa/chk3.json`);
    const abs = resolveQaPath(TID, "chk3.json");
    expect(JSON.parse(await readFile(abs, "utf8"))).toEqual(report);
  });
});

describe("readQaArtifact", () => {
  it("读回已落盘文件", async () => {
    await saveScreenshot(TID, "chk4", Buffer.from("hello"));
    const buf = await readQaArtifact(TID, "chk4.png");
    expect(buf?.toString()).toBe("hello");
  });
  it("不存在 → null", async () => {
    expect(await readQaArtifact(TID, "nope.png")).toBeNull();
  });
  it("防 `..` 越界 → null", async () => {
    expect(await readQaArtifact(TID, "../../etc/passwd")).toBeNull();
  });
});

describe("事件 payload 构造", () => {
  it("buildQaPassedPayload 结构（含 artifactPath）", () => {
    const p = buildQaPassedPayload({
      checkId: "c1",
      kind: "gate",
      viewports: [375, 768, 1280],
      durationMs: 1200,
      artifactPath: "t/qa/c1.json",
    });
    expect(p).toEqual({
      checkId: "c1",
      kind: "gate",
      viewports: [375, 768, 1280],
      durationMs: 1200,
      artifactPath: "t/qa/c1.json",
    });
  });
  it("buildQaFailedPayload 携带 failures[]", () => {
    const p = buildQaFailedPayload({
      checkId: "c2",
      kind: "browser",
      viewports: [1280],
      failures: [
        {
          type: "console_error",
          viewport: 1280,
          detail: "TypeError: x is undefined",
          artifactPath: null,
        },
        { type: "network_http_error", detail: "GET /main.js → 404" },
      ],
      durationMs: 800,
    });
    expect(p.failures).toHaveLength(2);
    expect(p.failures[0]?.type).toBe("console_error");
    expect(p.kind).toBe("browser");
  });
  it("payload 不含 DB blob——证据是 artifactPath 字符串", () => {
    const p = buildQaFailedPayload({
      checkId: "c3",
      kind: "a11y",
      viewports: [],
      failures: [],
      durationMs: 0,
    });
    expect(JSON.stringify(p)).not.toContain("Buffer");
    expect(typeof p.artifactPath).toBe("object"); // null
  });
});

// S1（05-P2-9）：QA 趋势统计
import { computeQaStats } from "./artifact";

describe("computeQaStats（05-P2-9）", () => {
  it("聚合 passed/failed/通过率/平均耗时/byKind/commonFailures", () => {
    const events = [
      { type: "qa.check_passed", payload: { kind: "gate", durationMs: 100 } },
      {
        type: "qa.check_failed",
        payload: {
          kind: "gate",
          durationMs: 200,
          failures: [{ type: "blank" }, { type: "console_error" }],
        },
      },
      {
        type: "qa.check_failed",
        payload: { kind: "a11y", durationMs: 300, failures: [{ type: "blank" }] },
      },
      { type: "agent.status_changed", payload: { to: "idle" } }, // 非 QA 事件忽略
    ];
    const s = computeQaStats(events);
    expect(s.totalChecks).toBe(3);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(2);
    expect(s.passRate).toBeCloseTo(1 / 3);
    expect(s.avgDurationMs).toBe(Math.round((100 + 200 + 300) / 3));
    expect(s.byKind.gate).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(s.byKind.a11y).toEqual({ total: 1, passed: 0, failed: 1 });
    // blank 出现 2 次（最常见），console_error 1 次
    expect(s.commonFailures[0]).toEqual({ type: "blank", count: 2 });
  });

  it("空事件 → 零统计", () => {
    const s = computeQaStats([]);
    expect(s.totalChecks).toBe(0);
    expect(s.passRate).toBe(0);
    expect(s.commonFailures).toEqual([]);
  });
});

// S1（05-P1-5）：cleanupQaArtifacts 物理删除 QA 证据目录
describe("cleanupQaArtifacts（05-P1-5）", () => {
  it("目录存在 → 递归删除整个 QA 目录", async () => {
    // 先落盘一些证据文件
    await saveScreenshot(TID, "chk1", Buffer.from("png-bytes"), 375);
    await saveQaReport(TID, "chk1", { ok: true });
    const dir = resolveQaDir(TID);
    expect(existsSync(dir)).toBe(true);

    await cleanupQaArtifacts(TID);

    expect(existsSync(dir)).toBe(false);
  });

  it("目录不存在 → 静默返回（不抛错，rm force 语义）", async () => {
    const dir = resolveQaDir("nonexistent-thread");
    expect(existsSync(dir)).toBe(false);

    await expect(cleanupQaArtifacts("nonexistent-thread")).resolves.toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it("只清目标 thread 的 QA 目录，不影响其他 thread", async () => {
    await saveScreenshot(TID, "chk1", Buffer.from("a"));
    await saveScreenshot("other-thread", "chk2", Buffer.from("b"));
    const dirA = resolveQaDir(TID);
    const dirB = resolveQaDir("other-thread");
    expect(existsSync(dirA)).toBe(true);
    expect(existsSync(dirB)).toBe(true);

    await cleanupQaArtifacts(TID);

    expect(existsSync(dirA)).toBe(false);
    expect(existsSync(dirB)).toBe(true); // 其他 thread 不受影响
  });
});
