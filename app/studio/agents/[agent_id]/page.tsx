"use client";

import { StudioGatePage } from "@/components/studio/gate-page";
import { StudioPage } from "@/components/studio/studio-page";
import { useStudioContext } from "@/components/studio/studio-shell";
import { apiFetch } from "@/lib/api-fetch";
import {
  snapshotAllowsAgentAction,
  snapshotAllowsTenantAction,
} from "@/lib/client/studio-permissions";
import {
  type AgentContractSnapshotDTO,
  type AgentDTO,
  type AgentRevisionDTO,
  ControlPlaneRequestError,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });

/** 修订的接口需求（只读展示用；wire JSON）。 */
interface InterfaceRequirements {
  enterprise_user_context?: { allowed_fields?: string[]; profile_requirement?: string };
  host_controls?: { confirmation_action_keys?: string[] };
}

interface AgentDetailData {
  readonly agent: AgentDTO;
  readonly contract: AgentContractSnapshotDTO | null;
  readonly revision: AgentRevisionDTO | null;
  readonly routeCount: number;
}

type LoadState =
  | { status: "loading" }
  | { status: "denied"; message: string }
  | { status: "not_found" }
  | { status: "error"; message: string }
  | { status: "ok"; data: AgentDetailData };

/**
 * 智能体详情页（页面数据 API 化）。
 *
 * 数据来源：
 * - GET /admin/api/agents/[id]（agent）+ /revisions + /contracts（control-plane-client）
 * - GET /admin/api/deployment-routes?target_kind=agent（发布配置计数）
 * - 权限判定走权限快照轻量断言（canRead / canConfigure / canManageAccess；服务端 API 兜底）。
 */
export default function AgentDetailsPage() {
  const { principal, snapshot, authCenterBaseUrl } = useStudioContext();
  const params = useParams<{ agent_id: string }>();
  const id = params?.agent_id ?? "";
  const canRead =
    snapshotAllowsTenantAction(snapshot, "agent.read") ||
    (id !== "" && snapshotAllowsAgentAction(snapshot, "agent.read", id));
  const canConfigure =
    id !== "" && snapshotAllowsAgentAction(snapshot, "agent.revision.create", id);

  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!id) return;
    if (!canRead) {
      setState({ status: "denied", message: "当前账号不能查看这个智能体。" });
      return;
    }
    let active = true;
    setState({ status: "loading" });
    void (async () => {
      try {
        const agent = await client.agents.get(id);
        const [contractsResponse, routesResponse] = await Promise.all([
          client.agents.listContracts(id),
          apiFetch(
            `/admin/api/deployment-routes?target_kind=agent&agent_id=${encodeURIComponent(id)}&scope_key=default`,
            { cache: "no-store" },
          )
            .then(async (response) =>
              response.ok ? ((await response.json()) as { items?: unknown[] }) : null,
            )
            .catch(() => null),
        ]);
        let revision: AgentRevisionDTO | null = null;
        if (agent.current_revision_id) {
          revision = await client.agents.getRevision(agent.current_revision_id).catch(() => null);
        }
        if (!active) return;
        const contracts = contractsResponse.items;
        const contract =
          contracts.find((item) => item.snapshot_id === revision?.agent_contract_snapshot_id) ??
          contracts[0] ??
          null;
        setState({
          status: "ok",
          data: { agent, contract, revision, routeCount: routesResponse?.items?.length ?? 0 },
        });
      } catch (error) {
        if (!active) return;
        const httpStatus = error instanceof ControlPlaneRequestError ? error.status : 0;
        if (httpStatus === 404) {
          setState({ status: "not_found" });
          return;
        }
        if (httpStatus === 401) {
          setState({ status: "error", message: "登录状态已失效，请刷新后重新登录。" });
          return;
        }
        setState({ status: "error", message: "加载失败，请稍后重试。" });
      }
    })();
    return () => {
      active = false;
    };
  }, [id, canRead]);

  if (state.status === "loading") {
    return (
      <StudioPage title="智能体" width="wide">
        <div className="rounded-xl border border-border bg-card px-5 py-10 text-center text-sm text-muted-foreground">
          正在加载…
        </div>
      </StudioPage>
    );
  }
  if (state.status === "denied") {
    return <StudioGatePage status={403} message={state.message} />;
  }
  if (state.status === "not_found") {
    return <StudioGatePage status={404} message="智能体不存在或已删除。" />;
  }
  if (state.status === "error") {
    return <StudioGatePage status={500} message={state.message} />;
  }

  const { agent, contract, revision, routeCount } = state.data;
  const requirements = (revision?.agent_interface_requirements ??
    null) as InterfaceRequirements | null;
  const labels: Record<string, string> = {
    employeeNo: "员工编号",
    departmentCode: "部门编号",
    buCode: "业务单元",
    factoryCode: "工厂编号",
    jobLevel: "职级",
  };
  const canManageAccess =
    agent.owner_user_id === principal.id || snapshotAllowsTenantAction(snapshot, "user.manage");
  const fields = requirements?.enterprise_user_context?.allowed_fields ?? [];
  const accessConsoleUrl = authCenterBaseUrl ? `${authCenterBaseUrl}/console/agents/${id}` : "";

  return (
    <StudioPage
      title={agent.display_name}
      width="wide"
      actions={
        canConfigure ? (
          <Link
            className="rounded-lg bg-foreground px-4 py-2 text-sm text-background"
            href={`/studio/resources?agent=${id}&step=configure`}
          >
            配置智能体
          </Link>
        ) : undefined
      }
    >
      <Link
        href="/studio/resources"
        className="inline-block text-sm text-muted-foreground hover:text-foreground"
      >
        ← 返回智能体列表
      </Link>
      <section className="grid gap-6 border-b pb-8 sm:grid-cols-3" aria-label="接入概况">
        <div>
          <h2 className="text-sm text-muted-foreground">登记状态</h2>
          <p className="mt-2 font-medium">
            {agent.lifecycle_state === "disabled"
              ? "已停用"
              : agent.lifecycle_state === "retired"
                ? "已退役"
                : "已登记"}
          </p>
        </div>
        <div>
          <h2 className="text-sm text-muted-foreground">使用设置</h2>
          <p className="mt-2 font-medium">
            {revision ? `第 ${revision.revision_no} 版 · 已保存` : "尚未设置"}
          </p>
        </div>
        <div>
          <h2 className="text-sm text-muted-foreground">员工使用入口</h2>
          <p className="mt-2 font-medium">{routeCount ? "已提交发布配置" : "尚未发布"}</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {routeCount
              ? "发布配置已存在，员工目录及实际连接是否可用仍需验证。"
              : "完成服务连接并发布后，员工才能通过平台使用。"}
          </p>
        </div>
      </section>
      {canManageAccess && (
        <section
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-5 py-4"
          aria-label="访问设置"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">使用范围与协作权限</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              已迁移至统一身份中心（auth-center），变更立即生效。
            </p>
          </div>
          {accessConsoleUrl ? (
            <a
              href={accessConsoleUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 shrink-0 items-center rounded-[10px] border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              前往配置 ↗
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">未配置身份中心地址</span>
          )}
        </section>
      )}
      <section aria-labelledby="capabilities-title">
        <h2 id="capabilities-title" className="text-lg font-semibold">
          能为员工做什么
        </h2>
        {agent.description && (
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{agent.description}</p>
        )}
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {contract?.capabilities.map((capability) => (
            <article key={capability.key} className="rounded-xl border p-5">
              <h3 className="font-medium">
                {capability.name["zh-CN"] || capability.name.en || "服务事项"}
              </h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {capability.description["zh-CN"] ||
                  capability.description.en ||
                  "服务提供方尚未补充说明。"}
              </p>
              {capability.examples.length > 0 && (
                <div className="mt-4 border-t pt-3">
                  <p className="text-xs text-muted-foreground">员工可以这样问</p>
                  {capability.examples.slice(0, 3).map((example) => (
                    <p key={example} className="mt-2 text-sm">
                      “{example}”
                    </p>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
        {!contract?.capabilities.length && (
          <p className="mt-3 text-sm text-muted-foreground">尚未提供服务事项说明。</p>
        )}
      </section>
      <section className="rounded-xl border p-6" aria-labelledby="privacy-title">
        <h2 id="privacy-title" className="text-lg font-semibold">
          员工资料与办理确认
        </h2>
        <dl className="mt-5 space-y-5 text-sm">
          <div>
            <dt className="font-medium">允许使用的员工资料</dt>
            <dd className="mt-2 leading-6 text-muted-foreground">
              {!revision
                ? "尚未设置"
                : fields.length
                  ? fields.map((field) => labels[field] ?? "其他已授权资料").join("、")
                  : "不提供员工资料"}
            </dd>
          </div>
          <div>
            <dt className="font-medium">办理前的员工确认</dt>
            <dd className="mt-2 leading-6 text-muted-foreground">
              {!revision
                ? "尚未设置"
                : requirements?.host_controls?.confirmation_action_keys?.length
                  ? `已设置 ${requirements.host_controls.confirmation_action_keys.length} 项办理确认规则。命中这些规则时，需要员工确认后继续。`
                  : "尚未设置平台办理确认规则。"}
            </dd>
          </div>
        </dl>
      </section>
      <details className="border-t pt-5">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          服务接入资料（供技术人员核对）
        </summary>
        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt>服务标识</dt>
            <dd className="mt-1 break-all text-muted-foreground">{agent.agent_key}</dd>
          </div>
          <div>
            <dt>服务版本</dt>
            <dd className="mt-1 text-muted-foreground">
              {contract?.public_agent_version ?? "未提供"}
            </dd>
          </div>
          <div>
            <dt>通信协议</dt>
            <dd className="mt-1 text-muted-foreground">
              {contract?.protocol_type} {contract?.protocol_contract_revision}
            </dd>
          </div>
          <div>
            <dt>最近更新</dt>
            <dd className="mt-1 text-muted-foreground">
              {agent.updated_at ? new Date(agent.updated_at).toLocaleString("zh-CN") : "—"}
            </dd>
          </div>
        </dl>
      </details>
    </StudioPage>
  );
}
