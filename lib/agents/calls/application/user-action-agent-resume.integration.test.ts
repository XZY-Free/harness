import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { UserActionRequest } from "@/lib/persistence/schema/user-action-request";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resumeAgentCall } = vi.hoisted(() => ({
  resumeAgentCall: vi.fn(),
}));

vi.mock("@/lib/agents/calls/application/resume-agent-call", () => ({ resumeAgentCall }));

import { resumeAgentCallFromUserAction } from "./resume-agent-call-from-user-action";

describe("UserAction resumes the same AgentCall", () => {
  beforeEach(() => {
    resumeAgentCall.mockReset();
  });

  it("从冻结请求关联恢复同一 call，并传递可信 subject", async () => {
    resumeAgentCall.mockResolvedValue({ id: "call-1", state: "running" });
    const request = {
      requestType: "input",
      purpose: "a2a_input_required",
      promptJson: { agent_call_id: "call-1" },
    } as UserActionRequest;

    await expect(
      resumeAgentCallFromUserAction({
        tenantId: "tenant-1",
        request,
        responseRedactedJson: { text: "我的入职日期是周一" },
        executionSubject: {
          tenantId: "tenant-1",
          subjectType: "user",
          subjectId: "user-1",
        },
      }),
    ).resolves.toEqual({ resumed: true, callId: "call-1", state: "running" });
    expect(resumeAgentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        callId: "call-1",
        text: "我的入职日期是周一",
        contextEnvironment: expect.objectContaining({
          executionSubject: expect.objectContaining({ subjectId: "user-1" }),
        }),
      }),
    );
  });

  it("confirmation approve/deny 都恢复同一 AgentCall，不创建新的 call 或文本确认", async () => {
    resumeAgentCall.mockResolvedValue({ id: "call-1", state: "running" });
    const request = {
      requestType: "confirmation",
      purpose: "a2a_confirmation",
      resolution: "deny",
      resolvedAt: new Date("2026-09-05T00:00:00.000Z"),
      promptJson: { agent_call_id: "call-1", proposal_id: "proposal-1" },
    } as UserActionRequest;

    await expect(
      resumeAgentCallFromUserAction({
        tenantId: "tenant-1",
        request,
        responseRedactedJson: null,
        executionSubject: {
          tenantId: "tenant-1",
          subjectType: "user",
          subjectId: "user-1",
        },
      }),
    ).resolves.toEqual({ resumed: true, callId: "call-1", state: "running" });
    expect(resumeAgentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "call-1",
        confirmation: {
          proposalId: "proposal-1",
          resolution: "deny",
          resolvedAt: "2026-09-05T00:00:00.000Z",
        },
      }),
    );
    expect(resumeAgentCall).not.toHaveBeenCalledWith(expect.objectContaining({ text: "确认" }));
  });

  it("非 Agent UAR 不触发外部 Agent resume", async () => {
    const request = {
      requestType: "input",
      purpose: "generic_question",
      promptJson: {},
    } as UserActionRequest;
    await expect(
      resumeAgentCallFromUserAction({
        tenantId: "tenant-1",
        request,
        responseRedactedJson: { text: "回答" },
        executionSubject: {
          tenantId: "tenant-1",
          subjectType: "user",
          subjectId: "user-1",
        },
      }),
    ).resolves.toEqual({ resumed: false });
    expect(resumeAgentCall).not.toHaveBeenCalled();
  });

  it("生产 resolve 事务先写 durable agent resume，HTTP 路由不再同步抢跑", () => {
    const queries = readFileSync(
      resolve(process.cwd(), "lib/conversations/user-action-resolve-queries.ts"),
      "utf8",
    );
    const route = readFileSync(
      resolve(
        process.cwd(),
        "app/api/v1/threads/[thread_id]/user-actions/[request_id]/resolve/route.ts",
      ),
      "utf8",
    );
    expect(queries).toContain('kind: "resume_agent_after_user_response"');
    expect(queries).toContain('consumerName: "invocation_continuation"');
    expect(route).not.toContain("resumeAgentCallFromUserAction");
  });
});
