import {
  extractModelInfo,
  resolveInvocationModelPreference,
} from "@/lib/runtime/resolve-execution-plan";
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
});

describe("resolveInvocationModelPreference", () => {
  it("按本次选择、会话默认、平台默认的顺序确定模型", () => {
    expect(resolveInvocationModelPreference("auto", "model-thread", "deepseek-v4-flash")).toBe(
      "auto",
    );
    expect(resolveInvocationModelPreference(undefined, "model-thread", "deepseek-v4-flash")).toBe(
      "model-thread",
    );
    expect(resolveInvocationModelPreference(undefined, null, "deepseek-v4-flash")).toBe(
      "deepseek-v4-flash",
    );
  });
});
