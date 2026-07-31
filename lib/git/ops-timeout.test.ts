import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1（09-P1-1）：git ops 超时集成测试。
 *
 * ops.test.ts 跑真实 git（op 时长不可控，无法稳定测超时）；本文件 mock simple-git，
 * 让每个 git 原语方法返回永不 resolve 的 pending promise，配合极小超时 env 验证：
 * 1. 每个 op 都经 withGitTimeout 包裹（超时后抛错，不挂死）。
 * 2. 超时错误消息含 `git op 超时（<ms>ms）`。
 *
 * 只 mock simple-git；workspaceRoot 仍 mock 指向临时目录；ops.ts 内 withGitTimeout / isRepoAt
 * 走真实实现。读原语需 `.git` 存在才进入 git op 调用，故在工作区建空 `.git` 目录。
 */

const tmp = vi.hoisted(() => ({ root: "" }));

vi.mock("@/lib/workspace", () => ({
  workspaceRoot: (threadId: string) => join(tmp.root, threadId),
}));

/** 永不 resolve 的 pending promise（模拟挂死的 git op）。 */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** mock simpleGit 工厂：返回对象，所有方法返回 pending promise。 */
vi.mock("simple-git", () => ({
  simpleGit: () => ({
    init: () => pending(),
    addConfig: () => pending(),
    status: () => pending(),
    diff: () => pending(),
    raw: () => pending(),
    getRemotes: () => pending(),
    add: () => pending(),
    commit: () => pending(),
    checkoutBranch: () => pending(),
    push: () => pending(),
    addTag: () => pending(),
    addRemote: () => pending(),
    remote: () => pending(),
    reset: () => pending(),
  }),
}));

import {
  ensureRemote,
  gitAdd,
  gitBranch,
  gitCommit,
  gitDiff,
  gitPush,
  gitRemoteUrl,
  gitResetHard,
  gitStatus,
  gitTag,
} from "@/lib/git/ops";

const TID = "timeout-thread";
const TIMEOUT_MS = 15;

function ws(): string {
  return join(tmp.root, TID);
}

beforeEach(() => {
  tmp.root = mkdtempSync(join(tmpdir(), "snow-git-timeout-"));
  mkdirSync(ws(), { recursive: true });
  // 读原语（gitStatus/gitDiff/gitRemoteUrl）需 isRepoAt=true 才进入 git op 调用
  mkdirSync(join(ws(), ".git"));
  // 写一个文件（gitAdd 等写原语经 ensureRepo，非 repo 时 isRepoAt=false 跳过 init，
  // 但 addConfig 仍会被调；让 .git 不存在会更纯，但写原语本身不依赖 .git 存在。
  // 这里保留 .git 让读原语路径覆盖到。）
  writeFileSync(join(ws(), "a.txt"), "x");
  process.env.SNOW_GIT_OP_TIMEOUT_MS = String(TIMEOUT_MS);
});

afterEach(() => {
  rmSync(tmp.root, { recursive: true, force: true });
  process.env.SNOW_GIT_OP_TIMEOUT_MS = undefined;
});

/** 断言 op 超时抛 `git op 超时（<ms>ms）`。 */
async function expectTimeout<T>(fn: () => Promise<T>): Promise<void> {
  await expect(fn()).rejects.toThrow(new RegExp(`git op 超时（${TIMEOUT_MS}ms）`));
}

describe("git ops 超时全覆盖（mock simple-git pending）", () => {
  it("gitStatus 超时", async () => {
    await expectTimeout(() => gitStatus(TID));
  });

  it("gitDiff 超时（无 pathFilter，走 .diff()）", async () => {
    await expectTimeout(() => gitDiff(TID));
  });

  it("gitDiff 超时（有 pathFilter，走 .raw()）", async () => {
    await expectTimeout(() => gitDiff(TID, { pathFilter: "a.txt" }));
  });

  it("gitRemoteUrl 超时（.getRemotes()）", async () => {
    await expectTimeout(() => gitRemoteUrl(TID));
  });

  it("gitAdd 超时（经 ensureRepo → init / addConfig / add 任一 pending）", async () => {
    await expectTimeout(() => gitAdd(TID));
  });

  it("gitCommit 超时（ensureRepo + .commit()）", async () => {
    await expectTimeout(() => gitCommit(TID, "msg"));
  });

  it("gitBranch 超时（ensureRepo + .status() / .checkoutBranch()）", async () => {
    await expectTimeout(() => gitBranch(TID, "feature"));
  });

  it("gitPush 超时（ensureRepo + .push()）", async () => {
    await expectTimeout(() => gitPush(TID, { remote: "origin", branch: "main" }));
  });

  it("gitTag 超时（ensureRepo + .raw(rev-parse) / .addTag()）", async () => {
    await expectTimeout(() => gitTag(TID, "snow-checkpoint-xxxx2222"));
  });

  it("gitResetHard 超时（ensureRepo + .reset()）", async () => {
    await expectTimeout(() => gitResetHard(TID, "HEAD"));
  });

  it("ensureRemote 超时（ensureRepo + .getRemotes()）", async () => {
    await expectTimeout(() => ensureRemote(TID, "origin", "/tmp/remote.git"));
  });
});

/**
 * 验证 ensureRepo 内部的 init / addConfig 也单独受超时保护：
 * 让 .git 不存在（isRepoAt=false → 走 init 分支），init pending → 超时。
 */
describe("ensureRepo 内部原语超时（init / addConfig）", () => {
  beforeEach(() => {
    // 移除 .git，强制 ensureRepo 走 init 分支
    rmSync(join(ws(), ".git"), { recursive: true, force: true });
  });

  it("init 超时（非 repo → ensureRepo 调 .init()）", async () => {
    await expectTimeout(() => gitAdd(TID));
  });
});
