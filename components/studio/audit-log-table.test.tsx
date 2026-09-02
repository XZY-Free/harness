import { AUDIT_ACTION_TYPES } from "@/lib/persistence/schema/audit";
import type { StudioAuditRow } from "@/lib/studio/admin-audit";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLogTable } from "./audit-log-table";

function auditRow(overrides: Partial<StudioAuditRow> = {}): StudioAuditRow {
  return {
    id: "audit-00000000-0000-0000-0000-000000000001",
    tenantId: "tenant-00000000-0000-0000-0000-000000000001",
    actorType: "user",
    actorId: "user-00000000-0000-0000-0000-000000000001",
    actionType: "settings.user_roles.updated",
    targetType: "user",
    targetId: "user-target-00000000-0000-0000-0000-000000000099",
    beforeHash: null,
    afterHash: null,
    reason: null,
    outcome: "succeeded",
    metadataRedacted: { changedKeys: ["roleIds"], reasonCode: "manual_update" },
    requestId: "request-00000000-0000-0000-0000-000000000001",
    occurredAt: new Date("2026-08-31T01:30:00.000Z"),
    actorName: "林晓",
    actorEmail: "linxiao@example.com",
    ...overrides,
  };
}

function attributeValues(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("*")).flatMap((element) =>
    Array.from(element.attributes).map((attribute) => attribute.value),
  );
}

const REAL_AUDIT_TARGET_LABELS = [
  ["agent", "智能体"],
  ["agent_call", "智能体调用"],
  ["agent_revision", "智能体版本"],
  ["artifact_attestation", "产物证明"],
  ["deletion_request", "删除请求"],
  ["deployment_route", "部署路由"],
  ["governance_config", "治理配置"],
  ["legal_hold", "法务保留"],
  ["policy", "策略"],
  ["projection", "事件投影"],
  ["recovery_drill", "恢复演练"],
  ["retention_policy", "保留策略"],
  ["runtime_conformance_run", "运行服务验证"],
  ["runtime_revision", "运行服务版本"],
  ["security_incident", "安全事件"],
  ["skill", "技能"],
  ["tenant", "租户"],
  ["user", "用户"],
  ["workload_token", "运行凭证"],
] as const;

afterEach(cleanup);

describe("AuditLogTable 后台只读审计表", () => {
  it("使用可横向滚动的语义表格、中文表头和只读说明", () => {
    const view = render(<AuditLogTable logs={[auditRow()]} />);

    const table = screen.getByRole("table", { name: "审计操作记录" });
    expect(table.className).toContain("min-w-");
    expect(table.querySelector("caption")?.textContent).toContain("只读");

    const scroll = view.container.querySelector('[data-slot="audit-log-scroll"]');
    expect(scroll?.className).toContain("overflow-x-auto");
    expect(scroll?.getAttribute("tabindex")).toBe("0");
    expect(scroll?.className).toContain("focus-visible:ring-");
    expect(scroll?.parentElement?.className).not.toContain("overflow-hidden");

    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual([
      "发生时间",
      "操作者",
      "操作",
      "操作对象",
      "执行结果",
      "变更摘要",
    ]);
    for (const header of headers) expect(header.getAttribute("scope")).toBe("col");

    expect(within(table).queryByRole("button")).toBeNull();
    expect(within(table).queryByRole("link")).toBeNull();
  });

  it("突出人类可读信息并弱化内部标识，结果状态不只依赖颜色", () => {
    const row = auditRow();
    const view = render(<AuditLogTable logs={[row]} />);

    expect(screen.getByText("林晓")).toBeTruthy();
    expect(screen.getByText("用户角色更新")).toBeTruthy();
    expect(screen.getByText("用户")).toBeTruthy();
    expect(document.body.textContent).not.toContain(row.actorId);
    expect(document.body.textContent).not.toContain(row.targetId ?? "");
    for (const value of attributeValues(view.container)) {
      expect(value).not.toContain(row.targetId ?? "");
    }

    const outcome = screen.getByText("成功").closest('[data-slot="badge"]');
    expect(outcome).not.toBeNull();
    expect(outcome?.querySelector("svg")).not.toBeNull();
  });

  it("canonical 目录中的每个合法动作都有中文名称", () => {
    render(
      <AuditLogTable
        logs={AUDIT_ACTION_TYPES.map((actionType, index) =>
          auditRow({
            id: `audit-action-${index}`,
            actionType,
            targetId: null,
            metadataRedacted: null,
          }),
        )}
      />,
    );

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(AUDIT_ACTION_TYPES.length);
    rows.forEach((row, index) => {
      const actionLabel = within(row).getAllByRole("cell")[2]?.textContent ?? "";
      expect(actionLabel).not.toBe("其他操作");
      expect(actionLabel).not.toContain(AUDIT_ACTION_TYPES[index] ?? "");
      expect(actionLabel).toMatch(/\p{Script=Han}/u);
    });
  });

  it.each(REAL_AUDIT_TARGET_LABELS)("真实目标类型 %s 显示为 %s", (targetType, label) => {
    render(<AuditLogTable logs={[auditRow({ targetType, targetId: null })]} />);

    expect(screen.getByText(label)).toBeTruthy();
    expect(document.body.textContent).not.toContain(targetType);
  });

  it("以 Asia/Shanghai 时区显示中文时间，同时保留机器可读 ISO 时间", () => {
    render(<AuditLogTable logs={[auditRow()]} />);

    const time = document.querySelector("time");
    expect(time?.textContent).toContain("09:30:00");
    expect(time?.getAttribute("datetime")).toBe("2026-08-31T01:30:00.000Z");
  });

  it("审计摘要只展示安全中文信息，不回显内部 key、枚举、标识或对象", () => {
    const privateValues = [
      "roleIds",
      "manual_update",
      "member",
      "admin",
      "internalPayload",
      "debug_mode",
      "/srv/private/stack.log",
      "version-private-0001",
    ];
    const view = render(
      <AuditLogTable
        logs={[
          auditRow({
            metadataRedacted: {
              changedKeys: ["roleIds", "futureInternalField"],
              reasonCode: "manual_update",
              roleIdsBefore: ["member"],
              roleIdsAfter: ["admin"],
              versionId: "version-private-0001",
              internalPayload: {
                mode: "debug_mode",
                stack: "/srv/private/stack.log",
              },
            },
          }),
        ]}
      />,
    );

    expect(screen.getByText(/角色权限/)).toBeTruthy();
    expect(screen.getByText("手动更新")).toBeTruthy();
    expect(screen.getByText("成员")).toBeTruthy();
    expect(screen.getByText("管理员")).toBeTruthy();
    expect(screen.getByText("其他信息")).toBeTruthy();
    expect(screen.getAllByText("已记录").length).toBeGreaterThanOrEqual(1);

    const rendered = `${view.container.textContent} ${attributeValues(view.container).join(" ")}`;
    for (const value of privateValues) expect(rendered).not.toContain(value);
    expect(rendered).not.toContain("futureInternalField");
  });

  it("缺少操作者与结果时使用中文中性回退，不暴露原始类型和 ID", () => {
    render(
      <AuditLogTable
        logs={[
          auditRow({
            actorType: "service",
            actorId: "service-private-identity-000000000001",
            actorName: null,
            actorEmail: null,
            actionType: "future.internal.action",
            targetType: "future_internal_resource",
            targetId: null,
            outcome: null,
            metadataRedacted: null,
          }),
        ]}
      />,
    );

    expect(screen.getByText("服务账号")).toBeTruthy();
    expect(screen.getByText("其他操作")).toBeTruthy();
    expect(screen.getByText("其他资源")).toBeTruthy();
    expect(screen.getByText("未记录")).toBeTruthy();
    expect(screen.getByText("无补充信息")).toBeTruthy();
    expect(document.body.textContent).not.toContain("future.internal.action");
    expect(document.body.textContent).not.toContain("future_internal_resource");
    expect(document.body.textContent).not.toContain("service-private-identity");
  });

  it("无记录时显示可感知的只读空状态", () => {
    render(<AuditLogTable logs={[]} />);

    const status = screen.getByRole("status");
    expect(within(status).getByText("暂无操作记录")).toBeTruthy();
    expect(status.textContent).toContain("只读");
    expect(status.querySelector("svg")).not.toBeNull();
  });
});
