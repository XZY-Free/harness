import {
  BUILTIN_TOOL_NAMES,
  getToolManifest,
  getToolMetadata,
  listToolMetadata,
} from "@/lib/ai/tool-registry";
import { buildTools } from "@/lib/ai/tools";
import { describe, expect, it } from "vitest";

/**
 * V3.0 Stage B：ToolRegistry 元数据完整性，以及与 buildTools 可见工具名的一致性。
 */

const TID = "tid-registry";

describe("ToolRegistry 元数据完整性", () => {
  it("覆盖全部 64 个内置工具（含 V3.3b rememberFact + V3.4 web 三件套 + MCP 通用入口 + V3.5 子代理控制 + V3.6 QA 五件套 + V3.8 部署三件套 + V9 浏览器工具十四件套）", () => {
    expect(BUILTIN_TOOL_NAMES).toEqual([
      "writeFile",
      "editFile",
      "multiEditFile",
      "applyPatch",
      "deleteFile",
      "readFile",
      "readFileRange",
      "statFile",
      "glob",
      "grep",
      "listFiles",
      "runCommand",
      "runTests",
      "reportReady",
      "readSkillFile",
      "startPreview",
      "stopPreview",
      "getPreviewStatus",
      "startBackgroundTask",
      "readTaskLogs",
      "stopBackgroundTask",
      "listBackgroundTasks",
      "runBuild",
      "installDependencies",
      "gitStatus",
      "gitDiff",
      "gitCheckpoint",
      "gitRestoreCheckpoint",
      "gitCreateBranch",
      "gitCommit",
      "gitPush",
      "createPullRequest",
      "deliverySummary",
      "rememberFact",
      "webFetch",
      "webSearch",
      "searchDocs",
      "listMcpTools",
      "callMcpTool",
      "spawnSubagent",
      "joinSubagent",
      "joinSubagents",
      "capturePreview",
      "runBrowserCheck",
      "runResponsiveCheck",
      "runAccessibilitySmoke",
      "visualVerdict",
      "deployToEnvironment",
      "deployStatus",
      "rollback",
      // V9 阶段 6：AI 浏览器工具
      "browserGetTabs",
      "browserSnapshot",
      "browserGetConsole",
      "browserGetNetwork",
      "browserScreenshot",
      "browserGetPageText",
      "browserNavigate",
      "browserClick",
      "browserType",
      "browserScroll",
      "browserPressKey",
      "browserSelectOption",
      "browserListDownloads",
      "browserUploadFile",
    ]);
    expect(listToolMetadata()).toHaveLength(64);
  });

  it("每个工具元数据字段完整且 permissionKey 形如已知前缀.<...>", () => {
    const prefixes = ["tool.", "mcp.", "web.", "docs.", "custom."];
    for (const m of listToolMetadata()) {
      expect(m.displayName).toBeTruthy();
      expect(m.description).toBeTruthy();
      // 内置工具为 tool.<name>；V3.4 web 工具为 web.fetch/web.search/docs.search
      expect(prefixes.some((p) => m.permissionKey.startsWith(p))).toBe(true);
      expect(["file", "command", "test", "delivery", "skill", "preview", "memory"]).toContain(
        m.category,
      );
      expect(["read", "write", "execute", "network", "delivery"]).toContain(m.risk);
      expect(["always", "skillContext", "previewRuntime"]).toContain(m.availableWhen);
    }
  });

  it("V3.4 web 工具：category=command、risk=network、非 tool. 前缀 permissionKey", () => {
    expect(getToolMetadata("webFetch")?.permissionKey).toBe("web.fetch");
    expect(getToolMetadata("webSearch")?.permissionKey).toBe("web.search");
    expect(getToolMetadata("searchDocs")?.permissionKey).toBe("docs.search");
    for (const n of ["webFetch", "webSearch", "searchDocs"]) {
      expect(getToolMetadata(n)?.category).toBe("command");
      expect(getToolMetadata(n)?.risk).toBe("network");
    }
  });

  it("V3.4 MCP 通用入口：listMcpTools/callMcpTool 静态 permissionKey 为 mcp.list/mcp.call", () => {
    expect(getToolMetadata("listMcpTools")?.permissionKey).toBe("mcp.list");
    expect(getToolMetadata("callMcpTool")?.permissionKey).toBe("mcp.call");
    expect(getToolMetadata("listMcpTools")?.category).toBe("command");
    expect(getToolMetadata("callMcpTool")?.category).toBe("command");
  });

  it("readSkillFile 标记为 skillContext 可见", () => {
    expect(getToolMetadata("readSkillFile")?.availableWhen).toBe("skillContext");
  });

  it("startPreview/stopPreview/getPreviewStatus 标记为 preview 分类", () => {
    for (const n of ["startPreview", "stopPreview", "getPreviewStatus"]) {
      expect(getToolMetadata(n)?.category).toBe("preview");
    }
  });

  it("runCommand/runTests 标记为 execute 高风险，但 registry 不触发审批", () => {
    expect(getToolMetadata("runCommand")?.risk).toBe("execute");
    expect(getToolMetadata("runTests")?.risk).toBe("execute");
    expect(getToolMetadata("runCommand")?.startsProcess).toBe(true);
  });

  it("writeFile 是唯一写工作区工具；readFile/listFiles 只读", () => {
    expect(getToolMetadata("writeFile")?.writesWorkspace).toBe(true);
    expect(getToolMetadata("readFile")?.readsWorkspace).toBe(true);
    expect(getToolMetadata("listFiles")?.readsWorkspace).toBe(true);
    expect(getToolMetadata("readFile")?.writesWorkspace).toBe(false);
  });

  it("未登记工具名 → null", () => {
    expect(getToolMetadata("nope")).toBeNull();
  });
});

describe("ToolRegistry 与 buildTools 一致性", () => {
  it("buildTools(无 skillContext) 可见工具名全部在 registry", () => {
    const names = Object.keys(buildTools(TID));
    expect(names).toHaveLength(63);
    for (const n of names) {
      expect(getToolMetadata(n)).not.toBeNull();
    }
    // 无 skillContext 时不暴露 readSkillFile
    expect(names).not.toContain("readSkillFile");
  });

  it("buildTools(带 skillContext) 暴露 readSkillFile，全部在 registry", () => {
    const names = Object.keys(
      buildTools(TID, undefined, undefined, { source: "local", name: "s", commitSha: "abc" }),
    );
    expect(names).toHaveLength(64);
    expect(names).toContain("readSkillFile");
    for (const n of names) {
      expect(getToolMetadata(n)).not.toBeNull();
    }
  });

  it("registry 不含 buildTools 之外的虚构工具（防漂移）", () => {
    const visible = new Set(
      Object.keys(
        buildTools(TID, undefined, undefined, { source: "local", name: "s", commitSha: "abc" }),
      ),
    );
    for (const n of BUILTIN_TOOL_NAMES) {
      expect(visible.has(n)).toBe(true);
    }
  });
});

describe("getToolManifest", () => {
  it("按可见名输出精简条目，跳过未登记名", () => {
    const manifest = getToolManifest(["readFile", "writeFile", "ghostTool"]);
    expect(manifest).toEqual([
      { name: "readFile", category: "file", risk: "read", permissionKey: "tool.readFile" },
      { name: "writeFile", category: "file", risk: "write", permissionKey: "tool.writeFile" },
    ]);
  });

  it("空入参 → 空数组", () => {
    expect(getToolManifest([])).toEqual([]);
  });
});
