import { describe, expect, it } from "vitest";
import { INTERNAL_TOOL_NAMES, isInternalToolPart } from "./internal-tools";

/**
 * V5-E：前台内部工具过滤测试。
 *
 * 覆盖：
 * - 5 个内部工具名（listMcpTools / callMcpTool / spawnSubagent / joinSubagent / joinSubagents）
 *   的 tool-<name> part 应被识别为内部 → true
 * - 员工可见工具（writeFile / readFile / reportReady / startPreview / runCommand 等）
 *   → false
 * - 防御性边界：part.type 非字符串、不以 tool- 开头、未知名 → false
 */
describe("V5-E internal-tools", () => {
  describe("INTERNAL_TOOL_NAMES", () => {
    it("包含 5 个内部编排类工具", () => {
      expect(INTERNAL_TOOL_NAMES.has("listMcpTools")).toBe(true);
      expect(INTERNAL_TOOL_NAMES.has("callMcpTool")).toBe(true);
      expect(INTERNAL_TOOL_NAMES.has("spawnSubagent")).toBe(true);
      expect(INTERNAL_TOOL_NAMES.has("joinSubagent")).toBe(true);
      expect(INTERNAL_TOOL_NAMES.has("joinSubagents")).toBe(true);
    });

    it("不包含员工可见工具（writeFile / reportReady 等）", () => {
      // 这些工具的 ActionCard 是员工验收产物的入口，必须可见
      expect(INTERNAL_TOOL_NAMES.has("writeFile")).toBe(false);
      expect(INTERNAL_TOOL_NAMES.has("readFile")).toBe(false);
      expect(INTERNAL_TOOL_NAMES.has("reportReady")).toBe(false);
      expect(INTERNAL_TOOL_NAMES.has("startPreview")).toBe(false);
      expect(INTERNAL_TOOL_NAMES.has("runCommand")).toBe(false);
      expect(INTERNAL_TOOL_NAMES.has("runTests")).toBe(false);
      expect(INTERNAL_TOOL_NAMES.has("webFetch")).toBe(false);
      expect(INTERNAL_TOOL_NAMES.has("webSearch")).toBe(false);
    });

    it("数量恰好 5（防误增删——增删需同步更新文档与 MessageRow 测试）", () => {
      expect(INTERNAL_TOOL_NAMES.size).toBe(5);
    });
  });

  describe("isInternalToolPart", () => {
    it("tool-listMcpTools → true（MCP 列表，员工不可见）", () => {
      expect(isInternalToolPart({ type: "tool-listMcpTools" })).toBe(true);
    });

    it("tool-callMcpTool → true（MCP 调用，员工不可见）", () => {
      expect(isInternalToolPart({ type: "tool-callMcpTool" })).toBe(true);
    });

    it("tool-spawnSubagent / tool-joinSubagent / tool-joinSubagents → true（子代理编排）", () => {
      expect(isInternalToolPart({ type: "tool-spawnSubagent" })).toBe(true);
      expect(isInternalToolPart({ type: "tool-joinSubagent" })).toBe(true);
      expect(isInternalToolPart({ type: "tool-joinSubagents" })).toBe(true);
    });

    it("tool-writeFile → false（员工可见，C1 卡片打开文件视图）", () => {
      expect(isInternalToolPart({ type: "tool-writeFile" })).toBe(false);
    });

    it("tool-reportReady → false（员工可见，C1 卡片打开预览视图）", () => {
      expect(isInternalToolPart({ type: "tool-reportReady" })).toBe(false);
    });

    it("tool-startPreview → false（员工可见，C1 卡片打开预览视图）", () => {
      expect(isInternalToolPart({ type: "tool-startPreview" })).toBe(false);
    });

    it("tool-readFile → false（员工可见，C1 卡片打开文件视图）", () => {
      expect(isInternalToolPart({ type: "tool-readFile" })).toBe(false);
    });

    it("tool-runCommand → false（员工可见，显示「命令执行失败」友好摘要）", () => {
      expect(isInternalToolPart({ type: "tool-runCommand" })).toBe(false);
    });

    it("非 tool- 前缀的 part → false（不归本函数管）", () => {
      expect(isInternalToolPart({ type: "text" })).toBe(false);
      expect(isInternalToolPart({ type: "reasoning" })).toBe(false);
      expect(isInternalToolPart({ type: "step-start" })).toBe(false);
      expect(isInternalToolPart({ type: "file" })).toBe(false);
    });

    it("part.type 非字符串 → false（防御：未知 part 形态）", () => {
      expect(isInternalToolPart({ type: undefined })).toBe(false);
      expect(isInternalToolPart({ type: 42 })).toBe(false);
      expect(isInternalToolPart({ type: null })).toBe(false);
      expect(isInternalToolPart({} as { type: unknown })).toBe(false);
    });

    it("未注册的 tool- 名 → false（默认走 ActionCard 渲染）", () => {
      expect(isInternalToolPart({ type: "tool-unknownTool" })).toBe(false);
      expect(isInternalToolPart({ type: "tool-" })).toBe(false);
    });

    it("仅前缀匹配但 name 不在白名单 → false（防误伤）", () => {
      // 注意：tool-listMcpToolsX 不同于 tool-listMcpTools
      expect(isInternalToolPart({ type: "tool-listMcpToolsX" })).toBe(false);
      expect(isInternalToolPart({ type: "tool-callMcpToolX" })).toBe(false);
      expect(isInternalToolPart({ type: "tool-spawnSubagentX" })).toBe(false);
    });
  });
});
