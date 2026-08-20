import { extractModelInfo } from "@/lib/runtime/resolve-execution-plan";
import { describe, expect, it } from "vitest";

describe("extractModelInfo", () => {
  it("员工为本次 Invocation 选择模型时覆盖 Agent 的默认模型", () => {
    expect(
      extractModelInfo(
        { default: "doubao-pro", provider: "tokenplan", revision: "policy-v1" },
        "auto",
      ),
    ).toEqual({
      modelProvider: "tokenplan",
      modelId: "auto",
      modelRevisionRef: "policy-v1",
    });
  });

  it("员工未选择模型时使用 AgentRevision 的默认模型", () => {
    expect(extractModelInfo({ default: "doubao-pro", provider: "doubao" }, null)).toEqual({
      modelProvider: "doubao",
      modelId: "doubao-pro",
      modelRevisionRef: null,
    });
  });

  it("AgentRevision 已声明模型策略时平台默认模型不参与解析", () => {
    expect(
      extractModelInfo({ default: "doubao-pro", provider: "doubao" }, null, "deepseek-v4-flash"),
    ).toEqual({
      modelProvider: "doubao",
      modelId: "doubao-pro",
      modelRevisionRef: null,
    });
  });

  it("会话与 AgentRevision 都未声明模型时回落平台默认模型", () => {
    expect(extractModelInfo({ provider: "doubao" }, null, "deepseek-v4-flash")).toEqual({
      modelProvider: "doubao",
      modelId: "deepseek-v4-flash",
      modelRevisionRef: null,
    });
  });

  it("平台默认模型缺省时回落占位值", () => {
    expect(extractModelInfo({}, null)).toEqual({
      modelProvider: "default",
      modelId: "default",
      modelRevisionRef: null,
    });
  });
});
