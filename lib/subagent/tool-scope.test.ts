import type { SubagentDefinition } from "@/lib/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.5 Stage B：buildSubagentTools 工具/写范围收窄测试。
 *
 * 验证：allowedTools 白名单过滤、ScopedWorkspaceStore 注入（writeScope 外写被拒）、
 * 默认只读 definition 不暴露写工具。
 */

// mock resolveRuntimes：返回受控 fake runtime，捕获注入的 workspace 是否为 Scoped。
const fakeWorkspace = {
  root: vi.fn(),
  safeJoin: vi.fn(),
  read: vi.fn(),
  write: vi.fn(async (p: string) => p),
  delete: vi.fn(async () => true),
  stat: vi.fn(),
  list: vi.fn(),
  glob: vi.fn(),
  grep: vi.fn(),
  mountTarget: vi.fn(),
};
const fakeRuntime = {
  workspace: fakeWorkspace,
  execution: { exec: vi.fn() },
  preview: { start: vi.fn(), stop: vi.fn(), status: vi.fn() },
};

vi.mock("@/lib/runtime/registry", () => ({
  resolveRuntimes: vi.fn(() => fakeRuntime),
}));

// mock buildTools：捕获传入的 allowedTools 与 injectedRuntimes，返回以 allowedTools 为 key 的 map。
const buildToolsMock = vi.hoisted(() => ({
  lastAllowed: null as string[] | null | undefined,
  lastInjected: null as unknown,
}));
vi.mock("@/lib/ai/tools", () => ({
  buildTools: vi.fn(
    (
      _threadId: string,
      allowedTools?: string[] | null,
      _rt?: unknown,
      _skill?: unknown,
      _custom?: unknown,
      injectedRuntimes?: unknown,
    ) => {
      buildToolsMock.lastAllowed = allowedTools;
      buildToolsMock.lastInjected = injectedRuntimes;
      const allow = new Set(allowedTools ?? []);
      // 返回一个包含全部候选工具名的 map，按 allowedTools 过滤
      const all = [
        "readFile",
        "readFileRange",
        "glob",
        "grep",
        "statFile",
        "listFiles",
        "writeFile",
        "editFile",
        "applyPatch",
        "deleteFile",
        "runCommand",
      ];
      const out: Record<string, { name: string }> = {};
      for (const n of all) if (allow.size === 0 || allow.has(n)) out[n] = { name: n };
      return out;
    },
  ),
}));

import { resolveRuntimes } from "@/lib/runtime/registry";
import { ScopedWorkspaceStore, WriteScopeError } from "@/lib/runtime/scoped-workspace-store";
import { buildSubagentTools, definitionExposesWriteTools } from "./tool-scope";

function def(over: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    id: "def-1",
    name: "explore",
    role: "explore",
    modelProfileId: null,
    allowedTools: ["readFile", "glob", "grep"],
    contextPolicy: {},
    outputSchema: null,
    defaultWriteScope: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  buildToolsMock.lastAllowed = null;
  buildToolsMock.lastInjected = null;
  fakeWorkspace.write.mockClear();
  fakeWorkspace.delete.mockClear();
});

describe("buildSubagentTools allowedTools 白名单", () => {
  it("把 definition.allowedTools 透传 buildTools 过滤", () => {
    const tools = buildSubagentTools({
      parentThreadId: "tid",
      definition: def({ allowedTools: ["readFile", "glob"] }),
    });
    expect(buildToolsMock.lastAllowed).toEqual(["readFile", "glob"]);
    expect(Object.keys(tools).sort()).toEqual(["glob", "readFile"]);
  });

  it("allowedTools 外工具不可见", () => {
    const tools = buildSubagentTools({
      parentThreadId: "tid",
      definition: def({ allowedTools: ["readFile"] }),
    });
    expect(tools.writeFile).toBeUndefined();
    expect(tools.runCommand).toBeUndefined();
    expect(tools.readFile).toBeDefined();
  });
});

describe("buildSubagentTools writeScope 注入 ScopedWorkspaceStore", () => {
  it("注入的 workspace 是 ScopedWorkspaceStore 包装", () => {
    buildSubagentTools({
      parentThreadId: "tid",
      definition: def(),
      writeScope: ["src/**"],
    });
    const injected = buildToolsMock.lastInjected as { workspace: unknown };
    expect(injected.workspace).toBeInstanceOf(ScopedWorkspaceStore);
  });

  it("writeScope 外 write 被 ScopedWorkspaceStore 拒绝（存储层强制）", async () => {
    buildSubagentTools({
      parentThreadId: "tid",
      definition: def({ allowedTools: ["writeFile"] }),
      writeScope: ["src/**"],
    });
    const injected = buildToolsMock.lastInjected as { workspace: ScopedWorkspaceStore };
    await expect(injected.workspace.write("docs/a.ts", "x")).rejects.toBeInstanceOf(
      WriteScopeError,
    );
    expect(fakeWorkspace.write).not.toHaveBeenCalled();
  });

  it("writeScope 内 write 放行到底层", async () => {
    buildSubagentTools({
      parentThreadId: "tid",
      definition: def({ allowedTools: ["writeFile"] }),
      writeScope: ["src/**"],
    });
    const injected = buildToolsMock.lastInjected as { workspace: ScopedWorkspaceStore };
    await injected.workspace.write("src/a.ts", "x");
    expect(fakeWorkspace.write).toHaveBeenCalledWith("src/a.ts", "x");
  });

  it("read 不受 writeScope 限制（null scope 仍可读）", async () => {
    buildSubagentTools({
      parentThreadId: "tid",
      definition: def(),
      writeScope: null,
    });
    const injected = buildToolsMock.lastInjected as { workspace: ScopedWorkspaceStore };
    await injected.workspace.read("docs/a.ts");
    expect(fakeWorkspace.read).toHaveBeenCalledWith("docs/a.ts");
  });
});

describe("默认只读（无 writeScope 不暴露写工具）", () => {
  it("只读 lane allowedTools 不含写工具 → definitionExposesWriteTools=false", () => {
    expect(definitionExposesWriteTools(def({ allowedTools: ["readFile", "glob", "grep"] }))).toBe(
      false,
    );
  });

  it("含 writeFile 的 definition → definitionExposesWriteTools=true", () => {
    expect(definitionExposesWriteTools(def({ allowedTools: ["readFile", "writeFile"] }))).toBe(
      true,
    );
  });

  it("无 writeScope 时注入的 ScopedWorkspaceStore 为只读（write 一律 throw）", async () => {
    buildSubagentTools({
      parentThreadId: "tid",
      definition: def({ allowedTools: ["writeFile"] }),
      writeScope: null,
    });
    const injected = buildToolsMock.lastInjected as { workspace: ScopedWorkspaceStore };
    await expect(injected.workspace.write("src/a.ts", "x")).rejects.toBeInstanceOf(WriteScopeError);
  });
});

describe("buildSubagentTools 资源隔离（04-G2 真隔离）", () => {
  beforeEach(() => {
    (resolveRuntimes as ReturnType<typeof vi.fn>).mockClear();
  });

  it("传收紧的 quotaOverride 构造子代理专属 runtime（独立资源限额，非复用父 quota）", () => {
    buildSubagentTools({ parentThreadId: "tid", definition: def() });
    expect(resolveRuntimes).toHaveBeenCalledWith(
      "tid",
      undefined,
      expect.objectContaining({
        quotaOverride: expect.objectContaining({
          pidsLimit: 128,
          openFilesLimit: 512,
          timeoutMs: 30000,
          logCapBytes: 512 * 1024,
        }),
      }),
    );
  });

  it("runtimeType 透传 resolveRuntimes", () => {
    buildSubagentTools({ parentThreadId: "tid", definition: def(), runtimeType: "container" });
    expect(resolveRuntimes).toHaveBeenCalledWith(
      "tid",
      "container",
      expect.objectContaining({ quotaOverride: expect.any(Object) }),
    );
  });
});
