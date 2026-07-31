import {
  POST,
  assertThreadVisible,
  composeSkillSystemPrompt,
  decideApprovalResume,
} from "@/app/api/chat/route";
import { afterEach, describe, expect, it } from "vitest";

/**
 * V8 阶段 3：route skill 解析的纯函数部分。
 *
 * route POST 涉及 streamText / createUIMessageStream，端到端 mock 成本高且脆，
 * 故按「route/preview 测试风格」只测可独立验证的纯逻辑：
 * - composeSkillSystemPrompt：promptTemplate 真实生效 + completionCriteria 软约束注入
 * - assertThreadVisible：foreign thread id 守卫（Phase 4-3）
 * - decideApprovalResume：V3.1 审批恢复决策
 * V8：resolveMatchedSkill 已移除，Skill 解析改为 Run 级 Resolver
 * （lib/skill/resolver.test.ts 覆盖 Resolver 决策；本文件不再 mock matcher）。
 * reportReady 预览闸门行为在 preview-gate.test.ts 已覆盖（不回归）。
 */

describe("composeSkillSystemPrompt (Phase 3 §6.3 + 目录形态)", () => {
  it("commitSha 存在（目录形态）：注入 skill 描述 + readSkillFile 指引", () => {
    const s = composeSkillSystemPrompt({
      skill: { name: "build-from-idea", description: "从想法到上线" },
      version: { commitSha: "abc1234", completionCriteria: null },
    });
    expect(s).toContain("build-from-idea");
    expect(s).toContain("readSkillFile");
    expect(s).toContain("SKILL.md");
  });

  it("hasSkillFile=true（无 commitSha）也注入 readSkillFile 指引", () => {
    // 02 文档后同步 Skill 与本地自建 Skill 一样有本地 commitSha;此用例验证 hasSkillFile
    // 显式为 true 时（即使 commitSha 缺省）仍走目录形态指引,不回退 promptTemplate。
    const s = composeSkillSystemPrompt({
      skill: { name: "deploy-review", description: "部署审查" },
      version: { hasSkillFile: true, completionCriteria: null },
    });
    expect(s).toContain("deploy-review");
    expect(s).toContain("readSkillFile");
    expect(s).toContain("SKILL.md");
    // 不应回退到 promptTemplate 分支
    expect(s).not.toBe("你是助手");
  });

  it("迁移期旧版本（无 commitSha，有 promptTemplate）：原样返回", () => {
    const s = composeSkillSystemPrompt({
      skill: { name: "s" },
      version: { promptTemplate: "你是助手", completionCriteria: null },
    });
    expect(s).toBe("你是助手");
  });

  it("有 completionCriteria：作为软约束注入 prompt 尾部", () => {
    const s = composeSkillSystemPrompt({
      skill: { name: "s" },
      version: { promptTemplate: "你是助手", completionCriteria: { mustPassPreview: true } },
    });
    expect(s).toContain("你是助手");
    expect(s).toContain("## 完成判定（软约束）");
    expect(s).toContain('"mustPassPreview":true');
  });

  it("completionCriteria 为 undefined / null → 不注入", () => {
    expect(
      composeSkillSystemPrompt({
        skill: { name: "s" },
        version: { promptTemplate: "p", completionCriteria: undefined },
      }),
    ).toBe("p");
    expect(
      composeSkillSystemPrompt({
        skill: { name: "s" },
        version: { promptTemplate: "p", completionCriteria: null },
      }),
    ).toBe("p");
  });
});

describe("assertThreadVisible (Phase 4-3 owner guard)", () => {
  it("请求带 thread id，且该 thread 已存在但不属于当前用户 → 404", () => {
    const res = assertThreadVisible(true, null, { id: "t1", userId: "other-user" });
    expect(res).not.toBeNull();
    expect(res?.status).toBe(404);
  });

  it("请求带 thread id 且属于当前用户 → 放行（null）", () => {
    expect(assertThreadVisible(true, { id: "t1", userId: "u1" })).toBeNull();
  });

  it("请求未带 thread id（新建）→ 放行，即便 existingThread 为 null", () => {
    expect(assertThreadVisible(false, null)).toBeNull();
  });

  it("请求带候选 thread id，但该 id 尚不存在 → 放行新建", () => {
    expect(assertThreadVisible(true, null, null)).toBeNull();
  });
});

describe("POST /api/chat auth guard", () => {
  const originalMode = process.env.SNOW_AUTH_MODE;

  afterEach(() => {
    process.env.SNOW_AUTH_MODE = originalMode;
  });

  it("trusted-headers 缺 SSO 身份 → 401，不抛 500", async () => {
    process.env.SNOW_AUTH_MODE = "trusted-headers";

    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "candidate-thread",
          message: {
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          },
        }),
      }),
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      error: { code: "missing_identity" },
    });
  });
});

// ─── V3.1：审批恢复决策（纯函数） ───────────────────────────

describe("decideApprovalResume (V3.1 ask 暂停-恢复)", () => {
  it("非 awaiting_approval → 不可恢复", () => {
    expect(decideApprovalResume({ threadStatus: "executing", latestResolved: null })).toEqual({
      resume: false,
    });
    expect(
      decideApprovalResume({
        threadStatus: "idle",
        latestResolved: { id: "a1", status: "approved" },
      }),
    ).toEqual({
      resume: false,
    });
  });

  it("awaiting_approval + 最近 approved → 恢复执行", () => {
    expect(
      decideApprovalResume({
        threadStatus: "awaiting_approval",
        latestResolved: { id: "a1", status: "approved" },
      }),
    ).toEqual({ resume: true, kind: "approved", approvalId: "a1" });
  });

  it("awaiting_approval + 最近 denied → 回 idle（不重试同工具）", () => {
    expect(
      decideApprovalResume({
        threadStatus: "awaiting_approval",
        latestResolved: { id: "a2", status: "denied" },
      }),
    ).toEqual({ resume: true, kind: "denied", approvalId: "a2" });
  });

  it("awaiting_approval 但无已决议审批 → 不可恢复（仍待审批）", () => {
    expect(
      decideApprovalResume({ threadStatus: "awaiting_approval", latestResolved: null }),
    ).toEqual({ resume: false });
  });

  it("已决议但状态非 approved/denied（如 expired）→ 不可恢复", () => {
    expect(
      decideApprovalResume({
        threadStatus: "awaiting_approval",
        latestResolved: { id: "a3", status: "expired" },
      }),
    ).toEqual({ resume: false });
  });
});

// ─── V3.3a：压缩 fail-safe 回退（route 装配边界）──────────────
//
// route 用 assembleModelMessages 包裹 buildContextPackage：builder 抛错 → 回退直通
// convertToModelMessages(history) + log，压缩 bug 不让 chat 500。
// 完整 POST 500 检查为 §10 手动 E2E；此处测 route 依赖的回退契约本身。

import { assembleModelMessages } from "@/lib/context/package-builder";

describe("V3.3a chat route 压缩 fail-safe", () => {
  it("buildContextPackage 抛错 → 回退直通，不传播异常", async () => {
    const history = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: new Date() },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "yo" }], createdAt: new Date() },
    ] as never;

    const result = await assembleModelMessages({
      threadId: "t1",
      history,
      build: async () => {
        throw new Error("builder boom");
      },
    });

    expect(result.fallback).toBe(true);
    expect(result.compressed).toBe(false);
    // 回退后仍产出可送 streamText 的 messages（不 500）
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
