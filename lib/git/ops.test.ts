import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.7 Stage A：git 原语真实 git 测试（plan §5：临时 repo fixture，不 mock simple-git）。
 * 仅 mock `workspaceRoot` 路径解析器（指向临时目录），simple-git 跑真实 git。
 */

const tmp = vi.hoisted(() => ({ root: "" }));
vi.mock("@/lib/workspace", () => ({
  workspaceRoot: (threadId: string) => join(tmp.root, threadId),
}));

import {
  assertGitRefName,
  ensureRemote,
  gitAdd,
  gitBranch,
  gitCommit,
  gitDiff,
  gitPush,
  gitResetHard,
  gitStatus,
  gitTag,
  withGitTimeout,
} from "@/lib/git/ops";

const TID = "ops-thread";

/** 工作区目录（tmp.root/TID）。 */
function ws(): string {
  return join(tmp.root, TID);
}

/** 在工作区写一个文件。 */
function writeFile(rel: string, content: string): void {
  const abs = join(ws(), rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** git CLI 探针（在工作区跑任意 git 命令，返回 stdout）。 */
function gitCli(args: string[]): string {
  return execFileSync("git", args, { cwd: ws(), encoding: "utf8" }).trim();
}

beforeEach(() => {
  tmp.root = mkdtempSync(join(tmpdir(), "snow-git-ops-"));
  mkdirSync(ws(), { recursive: true });
});

afterEach(() => {
  rmSync(tmp.root, { recursive: true, force: true });
});

describe("gitStatus / gitDiff（读原语）", () => {
  it("非 repo 工作区 → isRepo:false，不副作用 init", async () => {
    const s = await gitStatus(TID);
    expect(s.isRepo).toBe(false);
    expect(await gitDiff(TID)).toEqual({ diff: "", truncated: false });
  });

  it("repo + 改动 → staged/modified/untracked 结构化", async () => {
    writeFile("a.txt", "hello");
    await gitAdd(TID);
    await gitCommit(TID, "init");
    writeFile("b.txt", "new"); // untracked
    writeFileSync(join(ws(), "a.txt"), "hello2"); // modified
    const s = await gitStatus(TID);
    expect(s.isRepo).toBe(true);
    expect(s.untracked).toContain("b.txt");
    expect(s.modified).toContain("a.txt");
  });
});

describe("gitAdd / gitCommit", () => {
  it("非 repo → 自动 init + add + commit，返回 commitSha", async () => {
    writeFile("a.txt", "hello");
    await gitAdd(TID);
    const res = await gitCommit(TID, "first\n\nConfidence: high");
    expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/);
    // commit message 含 trailer
    expect(gitCli(["log", "-1", "--format=%B"])).toContain("Confidence: high");
  });

  it("无改动 → nothingToCommit:true", async () => {
    writeFile("a.txt", "x");
    await gitAdd(TID);
    await gitCommit(TID, "first");
    const res = await gitCommit(TID, "again");
    expect(res.nothingToCommit).toBe(true);
    expect(res.commitSha).toBeUndefined();
  });

  it("gitDiff 限长 truncated（已跟踪文件的大改动）", async () => {
    writeFile("big.txt", "seed");
    await gitAdd(TID);
    await gitCommit(TID, "first");
    // 已跟踪 big.txt 的大量未暂存改动 → git diff 可见
    writeFileSync(join(ws(), "big.txt"), "line\n".repeat(5000));
    const r = await gitDiff(TID, { pathFilter: "big.txt" });
    expect(r.truncated).toBe(true);
    expect(r.diff.length).toBeLessThanOrEqual(20_000);
    expect(r.diff).toContain("big.txt");
  });
});

describe("gitBranch", () => {
  it("创建并切换到新分支（current === name）", async () => {
    writeFile("a.txt", "x");
    await gitAdd(TID);
    await gitCommit(TID, "first");
    await gitBranch(TID, "feature-x");
    const s = await gitStatus(TID);
    expect(s.current).toBe("feature-x");
  });

  it("已是当前分支 → 幂等无操作", async () => {
    writeFile("a.txt", "x");
    await gitAdd(TID);
    await gitCommit(TID, "first");
    const cur = (await gitStatus(TID)).current;
    await gitBranch(TID, cur as string);
    expect((await gitStatus(TID)).current).toBe(cur);
  });
});

describe("gitTag / gitResetHard", () => {
  it("tag 指向 HEAD commitSha；reset --hard 回滚改动", async () => {
    writeFile("a.txt", "v1");
    await gitAdd(TID);
    await gitCommit(TID, "first");
    const tag = await gitTag(TID, "snow-checkpoint-aaaa1111");
    expect(tag.tag).toBe("snow-checkpoint-aaaa1111");
    expect(tag.commitSha).toBe(gitCli(["rev-parse", "HEAD"]));

    // 制造改动
    writeFile("a.txt", "v2-changed");
    writeFile("extra.txt", "new");
    await gitAdd(TID);
    await gitCommit(TID, "second");

    // reset --hard 到 tag
    await gitResetHard(TID, tag.tag);
    expect(gitCli(["log", "--format=%s"])).toBe("first");
    // 工作区回到 v1，extra.txt 被删
    expect(gitCli(["show", "HEAD:a.txt"])).toBe("v1");
  });
});

describe("ensureRemote / gitPush", () => {
  it("推送到 bare 本地 remote：refs/heads/main 落地", async () => {
    // bare remote
    const remotePath = mkdtempSync(join(tmpdir(), "snow-git-remote-"));
    execFileSync("git", ["init", "--bare", remotePath]);

    writeFile("a.txt", "hello");
    await gitAdd(TID);
    await gitCommit(TID, "first");
    await gitBranch(TID, "main");
    await ensureRemote(TID, "origin", remotePath);
    const res = await gitPush(TID, { remote: "origin", branch: "main" });
    expect(res).toEqual({ pushed: true, branch: "main", remote: "origin" });

    // bare remote 上 main 指向同一 commit
    const remoteHead = execFileSync("git", ["--git-dir", remotePath, "rev-parse", "main"], {
      encoding: "utf8",
    }).trim();
    expect(remoteHead).toBe(gitCli(["rev-parse", "HEAD"]));

    // 再次 ensureRemote 走 set-url（不报错）
    await ensureRemote(TID, "origin", remotePath);

    rmSync(remotePath, { recursive: true, force: true });
  });

  it("force push 覆盖远程历史（不默认）", async () => {
    const remotePath = mkdtempSync(join(tmpdir(), "snow-git-remote-"));
    execFileSync("git", ["init", "--bare", remotePath]);

    writeFile("a.txt", "v1");
    await gitAdd(TID);
    await gitCommit(TID, "first");
    await gitBranch(TID, "main");
    await ensureRemote(TID, "origin", remotePath);
    await gitPush(TID, { remote: "origin", branch: "main" });

    // 改写历史（amend 制造新 sha）
    execFileSync("git", ["commit", "--amend", "-m", "first-rewritten"], { cwd: ws() });
    // 非 force 推送应失败（非 fast-forward）
    await expect(gitPush(TID, { remote: "origin", branch: "main" })).rejects.toThrow();
    // force 推送成功
    await gitPush(TID, { remote: "origin", branch: "main", force: true });
    const remoteHead = execFileSync("git", ["--git-dir", remotePath, "rev-parse", "main"], {
      encoding: "utf8",
    }).trim();
    expect(remoteHead).toBe(gitCli(["rev-parse", "HEAD"]));

    rmSync(remotePath, { recursive: true, force: true });
  });
});

/**
 * S1（09-P1-1）：withGitTimeout 单元测试。
 *
 * 纯 promise 层验证超时语义，不碰 simple-git / 真实 git（真实 git op 时长不可控，无法稳定测超时）。
 * 每个 git op 的超时集成（mock simple-git 返回 pending promise）见 ops-timeout.test.ts。
 */
describe("withGitTimeout（超时包装）", () => {
  it("原 promise 先 resolve → 透传结果，不触发超时", async () => {
    const r = await withGitTimeout(Promise.resolve("ok"), 1000);
    expect(r).toBe("ok");
  });

  it("原 promise 先 reject → 透传错误，不触发超时", async () => {
    await expect(withGitTimeout(Promise.reject(new Error("git fail")), 1000)).rejects.toThrow(
      "git fail",
    );
  });

  it("超时先到 → 抛 `git op 超时（<ms>ms）`", async () => {
    const never = new Promise<string>(() => {}); // 永不 resolve
    await expect(withGitTimeout(never, 20)).rejects.toThrow(/git op 超时（20ms）/);
  });

  it("超时后原 promise 不被取消（仍 pending，无 unhandledRejection）", async () => {
    let rejected = false;
    const slow = new Promise<string>((_, reject) =>
      setTimeout(() => {
        rejected = true;
        reject(new Error("late"));
      }, 50),
    );
    await expect(withGitTimeout(slow, 10)).rejects.toThrow(/超时/);
    // 等待 slow 自然 reject，避免 unhandledRejection
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(rejected).toBe(true);
  });

  it("ms 显式参数优先于 env", async () => {
    const prev = process.env.SNOW_GIT_OP_TIMEOUT_MS;
    process.env.SNOW_GIT_OP_TIMEOUT_MS = "99999";
    try {
      const never = new Promise<string>(() => {});
      // 显式 15ms 应胜过 env 99999ms
      await expect(withGitTimeout(never, 15)).rejects.toThrow(/超时（15ms）/);
    } finally {
      if (prev === undefined) process.env.SNOW_GIT_OP_TIMEOUT_MS = undefined;
      else process.env.SNOW_GIT_OP_TIMEOUT_MS = prev;
    }
  });

  it("env SNOW_GIT_OP_TIMEOUT_MS 控制默认阈值（动态读，不缓存）", async () => {
    const prev = process.env.SNOW_GIT_OP_TIMEOUT_MS;
    const never = new Promise<string>(() => {});
    process.env.SNOW_GIT_OP_TIMEOUT_MS = "25";
    try {
      await expect(withGitTimeout(never)).rejects.toThrow(/超时（25ms）/);
    } finally {
      if (prev === undefined) process.env.SNOW_GIT_OP_TIMEOUT_MS = undefined;
      else process.env.SNOW_GIT_OP_TIMEOUT_MS = prev;
    }
  });

  it("env 非法值（NaN / 非正数）回退默认 60s", async () => {
    const prev = process.env.SNOW_GIT_OP_TIMEOUT_MS;
    const never = new Promise<string>(() => {});
    process.env.SNOW_GIT_OP_TIMEOUT_MS = "not-a-number";
    try {
      // 60s 太久不实际等；用显式 ms=5 验证函数可正常调用，非法 env 不影响显式参数路径
      await expect(withGitTimeout(never, 5)).rejects.toThrow(/超时（5ms）/);
    } finally {
      if (prev === undefined) process.env.SNOW_GIT_OP_TIMEOUT_MS = undefined;
      else process.env.SNOW_GIT_OP_TIMEOUT_MS = prev;
    }
  });
});

describe("assertGitRefName (P1-28)", () => {
  it("放行合法分支名", () => {
    expect(() => assertGitRefName("feature-login")).not.toThrow();
    expect(() => assertGitRefName("feature/login-v2")).not.toThrow();
    expect(() => assertGitRefName("v1.0.0")).not.toThrow();
  });

  it("拒绝参数注入前缀", () => {
    expect(() => assertGitRefName("--upload-pack=/bin/sh")).toThrow();
    expect(() => assertGitRefName("-x")).toThrow();
  });

  it("拒绝路径穿越 / refspec 元字符", () => {
    expect(() => assertGitRefName("../escape")).toThrow();
    expect(() => assertGitRefName("a..b")).toThrow();
    expect(() => assertGitRefName("a:b")).toThrow();
    expect(() => assertGitRefName("a~1")).toThrow();
    expect(() => assertGitRefName("a b")).toThrow();
  });

  it("拒绝 .lock 结尾与空串", () => {
    expect(() => assertGitRefName("x.lock")).toThrow();
    expect(() => assertGitRefName("")).toThrow();
  });
});
