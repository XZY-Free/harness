import {
  HostControlProtocolError,
  parseHostControlCapabilityPolicy,
  parseHostControls,
} from "@/lib/agents/calls/transport/a2a/host-control-contract";
import { describe, expect, it } from "vitest";

const policy = parseHostControlCapabilityPolicy({
  host_controls: {
    confirmation_action_keys: ["hr.leave.submit"],
    ui_action_types: ["navigate", "open_external_link", "offer_human_support"],
    ui_action_target_keys: ["thread.current", "settings.profile"],
  },
});

describe("A2A host_controls 合同", () => {
  it("默认拒绝未在 AgentRevision 声明的 confirmation 和 ui_actions", () => {
    expect(() =>
      parseHostControls(
        {
          host_controls: {
            version: "1",
            confirmation: {
              proposal_id: "proposal-1",
              action_key: "hr.leave.submit",
              title: "提交请假",
              summary: "将提交请假申请",
              impact: "提交后进入审批",
              preview: { days: 1 },
            },
          },
        },
        "input-required",
      ),
    ).toThrow(HostControlProtocolError);
  });

  it("只接受 allowlist 内的用户确认提议，并保留安全预览", () => {
    const parsed = parseHostControls(
      {
        host_controls: {
          version: "1",
          confirmation: {
            proposal_id: "proposal-1",
            action_key: "hr.leave.submit",
            title: "提交请假",
            summary: "将提交请假申请",
            impact: "提交后进入审批",
            preview: { days: 1 },
          },
        },
      },
      "input-required",
      policy,
    );

    expect(parsed).toEqual({
      kind: "confirmation",
      proposal: expect.objectContaining({ proposal_id: "proposal-1", preview: { days: 1 } }),
    });
  });

  it("拒绝权限、数据范围、凭证和未登记字段进入 confirmation preview", () => {
    for (const preview of [
      { permissions: ["payroll.read"] },
      { dataScopes: ["factory-a"] },
      { access_token: "secret" },
      { unknown_internal_id: "id-1" },
    ]) {
      expect(() =>
        parseHostControls(
          {
            host_controls: {
              version: "1",
              confirmation: {
                proposal_id: "proposal-1",
                action_key: "hr.leave.submit",
                title: "提交请假",
                summary: "将提交请假申请",
                impact: "提交后进入审批",
                preview,
              },
            },
          },
          "input-required",
          policy,
        ),
      ).toThrow(HostControlProtocolError);
    }
  });

  it("把 navigate 目标解析为服务端登记路径，拒绝未登记目标", () => {
    const parsed = parseHostControls(
      {
        host_controls: {
          version: "1",
          ui_actions: [
            {
              action_id: "action-1",
              action_type: "navigate",
              title: "打开当前会话",
              label: "打开",
              description: null,
              target_key: "thread.current",
              url: null,
            },
          ],
        },
      },
      "completed",
      policy,
    );
    expect(parsed).toEqual({
      kind: "ui_actions",
      actions: [expect.objectContaining({ web_path: "/threads", url: null })],
    });

    expect(() =>
      parseHostControls(
        {
          host_controls: {
            version: "1",
            ui_actions: [
              {
                action_id: "action-1",
                action_type: "navigate",
                title: "越权目标",
                label: "打开",
                description: null,
                target_key: "admin.users",
                url: null,
              },
            ],
          },
        },
        "completed",
        policy,
      ),
    ).toThrow(HostControlProtocolError);
  });

  it("外链只接受 HTTPS，拒绝明文、内网和 userinfo", () => {
    for (const url of [
      "http://example.com",
      "https://localhost/path",
      "https://user:password@example.com/path",
      "javascript:alert(1)",
    ]) {
      expect(() =>
        parseHostControls(
          {
            host_controls: {
              version: "1",
              ui_actions: [
                {
                  action_id: "action-1",
                  action_type: "open_external_link",
                  title: "打开链接",
                  label: "打开",
                  description: null,
                  target_key: null,
                  url,
                },
              ],
            },
          },
          "completed",
          policy,
        ),
      ).toThrow(HostControlProtocolError);
    }
  });

  it("completed 不接受 confirmation，input-required 不接受 ui_actions", () => {
    const baseConfirmation = {
      proposal_id: "proposal-1",
      action_key: "hr.leave.submit",
      title: "提交请假",
      summary: "将提交请假申请",
      impact: "提交后进入审批",
      preview: {},
    };
    expect(() =>
      parseHostControls(
        { host_controls: { version: "1", confirmation: baseConfirmation } },
        "completed",
        policy,
      ),
    ).toThrow(HostControlProtocolError);
    expect(() =>
      parseHostControls(
        { host_controls: { version: "1", ui_actions: [] } },
        "input-required",
        policy,
      ),
    ).toThrow(HostControlProtocolError);
    expect(() =>
      parseHostControls({ host_controls: { version: "1" } }, "input-required", policy),
    ).toThrow(HostControlProtocolError);
    expect(() =>
      parseHostControls({ host_controls: { version: "1" } }, "completed", policy),
    ).toThrow(HostControlProtocolError);
  });
});
