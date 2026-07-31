import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1（09-P1-2）：token 不落 .git/config 专项测试。
 *
 * 原 deliver.test.ts 用真实 bare remote(无 token 场景),无法验证含 token URL 的处理。
 * 本文件 mock ops + simple-git,验证:
 * ① extractToken 剥离 token,ensureRemote 收到 cleanUrl(无 token → 不落 .git/config)
 * ② 有 token 时 push 用 -c http.extraHeader 注入(不持久化)
 * ③ 无 token 时走普通 gitPush
 */

const ops = vi.hoisted(() => ({
  gitAdd: vi.fn().mockResolvedValue(undefined),
  gitCommit: vi.fn().mockResolvedValue({ commitSha: "abc123" }),
  gitStatus: vi.fn().mockResolvedValue({ current: "main" }),
  gitBranch: vi.fn().mockResolvedValue(undefined),
  gitPush: vi.fn().mockResolvedValue(undefined),
  ensureRemote: vi.fn().mockResolvedValue(undefined),
}));

const simpleGitMock = vi.hoisted(() => ({ raw: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/git/ops", () => ({
  gitAdd: ops.gitAdd,
  gitCommit: ops.gitCommit,
  gitStatus: ops.gitStatus,
  gitBranch: ops.gitBranch,
  gitPush: ops.gitPush,
  ensureRemote: ops.ensureRemote,
  // deliver.ts 复用 withGitTimeout 包裹 extraHeader push；mock 为透传，不引入真实超时
  withGitTimeout: <T>(p: Promise<T>) => p,
}));

vi.mock("@/lib/workspace", () => ({ workspaceRoot: () => "/tmp/ws" }));

vi.mock("simple-git", () => ({
  simpleGit: () => ({ raw: simpleGitMock.raw }),
}));

import { deliverToGit } from "@/lib/git/deliver";

beforeEach(() => {
  vi.clearAllMocks();
  // 重新绑定 mock 实现(clearAllMocks 不清实现,但为稳态显式重置)
  ops.gitAdd.mockResolvedValue(undefined);
  ops.gitCommit.mockResolvedValue({ commitSha: "abc123" });
  ops.gitStatus.mockResolvedValue({ current: "main" });
  ops.gitBranch.mockResolvedValue(undefined);
  ops.gitPush.mockResolvedValue(undefined);
  ops.ensureRemote.mockResolvedValue(undefined);
  simpleGitMock.raw.mockResolvedValue(undefined);
});

describe("deliverToGit token 不落 .git/config（09-P1-2）", () => {
  it("含 token URL → ensureRemote 收到 cleanUrl(无 token)", async () => {
    await deliverToGit("t1", "https://x-access-token:SECRET@git.example.com/repo.git");
    // ensureRemote 第三参数应是 cleanUrl,不含 SECRET
    expect(ops.ensureRemote).toHaveBeenCalledWith(
      "t1",
      "origin",
      "https://git.example.com/repo.git",
    );
    const receivedUrl = ops.ensureRemote.mock.calls[0]?.[2];
    expect(receivedUrl).not.toContain("SECRET");
    expect(receivedUrl).not.toContain("x-access-token");
  });

  it("含 token → push 用 -c http.extraHeader 注入 Authorization(不落 config)", async () => {
    await deliverToGit("t1", "https://user:TOKEN@git.example.com/repo.git");
    // simple-git.raw 被调,push args 含 extraHeader
    expect(simpleGitMock.raw).toHaveBeenCalledTimes(1);
    const args = simpleGitMock.raw.mock.calls[0]?.[0];
    expect(args).toContain("-c");
    const headerArg = args.find((a: string) =>
      a.startsWith("http.extraHeader=Authorization: token "),
    );
    expect(headerArg).toBeTruthy();
    expect(headerArg).toContain("TOKEN");
    // 走 extraHeader 分支,不调普通 gitPush
    expect(ops.gitPush).not.toHaveBeenCalled();
  });

  it("含 token → extraHeader 不含 user 部分(只取 token,非 user:token)", async () => {
    await deliverToGit("t1", "https://user:TOKEN@git.example.com/repo.git");
    const args = simpleGitMock.raw.mock.calls[0]?.[0];
    const headerArg = args.find((a: string) => a.includes("extraHeader"));
    // Authorization: token TOKEN(user 不进 header)
    expect(headerArg).toBe("http.extraHeader=Authorization: token TOKEN");
  });

  it("无 token URL(plain https) → 走普通 gitPush,不注入 extraHeader", async () => {
    await deliverToGit("t1", "https://git.example.com/repo.git");
    expect(ops.gitPush).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ remote: "origin", branch: "main" }),
    );
    expect(simpleGitMock.raw).not.toHaveBeenCalled();
    // ensureRemote 收到原 url(无 token 可剥离)
    expect(ops.ensureRemote).toHaveBeenCalledWith(
      "t1",
      "origin",
      "https://git.example.com/repo.git",
    );
  });

  it("force + token → push args 含 --force", async () => {
    await deliverToGit("t1", "https://u:T@git.example.com/repo.git", { force: true });
    const args = simpleGitMock.raw.mock.calls[0]?.[0];
    expect(args).toContain("--force");
  });

  it("自定义 branch + token → push 到指定分支", async () => {
    await deliverToGit("t1", "https://u:T@git.example.com/repo.git", { branch: "feature" });
    const args = simpleGitMock.raw.mock.calls[0]?.[0];
    expect(args).toContain("feature");
  });
});
