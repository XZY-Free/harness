import { AgentAccessManager } from "@/components/studio/agent-access-manager";
import { StudioGatePage } from "@/components/studio/gate-page";
import { StudioPage } from "@/components/studio/studio-page";
import {
  loadAgentContractSnapshotsByAgent,
  projectAgentContractWire,
} from "@/lib/agents/application/submit-agent-contract-registration";
import { mysqlAgentContractStore } from "@/lib/agents/persistence/agent-contract-store";
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import type { AgentContractSnapshotDTO } from "@/lib/control-plane-client";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { listEnabledRouteProjections } from "@/lib/routes/application/deployment-route-service";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";
import Link from "next/link";
import { notFound } from "next/navigation";
export const dynamic = "force-dynamic";

export default async function AgentDetailsPage({
  params,
}: { params: Promise<{ agent_id: string }> }) {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;
  const { agent_id: id } = await params;
  const canRead =
    (await hasStudioAction(gate.principal, "agent.read")) ||
    (await hasStudioAction(gate.principal, "agent.read", { type: "agent", id }));
  if (!canRead) return <StudioGatePage status={403} message="当前账号不能查看这个智能体。" />;
  const agent = await getAgentById(gate.principal.tenantId, id);
  if (!agent || agent.deletedAt) notFound();
  const [snapshots, revision, routes, canConfigure] = await Promise.all([
    loadAgentContractSnapshotsByAgent(mysqlAgentContractStore, gate.principal.tenantId, id),
    agent.currentRevisionId ? getRevisionById(agent.currentRevisionId) : null,
    listEnabledRouteProjections(gate.principal.tenantId, id, "default"),
    hasStudioAction(gate.principal, "agent.revision.create", { type: "agent", id }),
  ]);
  const contracts = snapshots.map(
    (snapshot) => projectAgentContractWire(snapshot) as unknown as AgentContractSnapshotDTO,
  );
  const contract =
    contracts.find((item) => item.snapshot_id === revision?.agentContractSnapshotId) ??
    contracts[0] ??
    null;
  const requirements = revision?.agentInterfaceRequirementsJson as
    | {
        enterprise_user_context?: { allowed_fields?: string[]; profile_requirement?: string };
        host_controls?: { confirmation_action_keys?: string[] };
      }
    | undefined;
  const labels: Record<string, string> = {
    employeeNo: "员工编号",
    departmentCode: "部门编号",
    buCode: "业务单元",
    factoryCode: "工厂编号",
    jobLevel: "职级",
  };
  const canManageAccess =
    agent.ownerUserId === gate.principal.userIdentityId ||
    (await hasStudioAction(gate.principal, "user.manage"));
  const fields = requirements?.enterprise_user_context?.allowed_fields ?? [];
  return (
    <StudioPage
      title={agent.displayName}
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
            {agent.lifecycleState === "disabled"
              ? "已停用"
              : agent.lifecycleState === "retired"
                ? "已退役"
                : "已登记"}
          </p>
        </div>
        <div>
          <h2 className="text-sm text-muted-foreground">使用设置</h2>
          <p className="mt-2 font-medium">
            {revision ? `第 ${revision.revisionNo} 版 · 已保存` : "尚未设置"}
          </p>
        </div>
        <div>
          <h2 className="text-sm text-muted-foreground">员工使用入口</h2>
          <p className="mt-2 font-medium">{routes.length ? "已提交发布配置" : "尚未发布"}</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {routes.length
              ? "发布配置已存在，员工目录及实际连接是否可用仍需验证。"
              : "完成服务连接并发布后，员工才能通过平台使用。"}
          </p>
        </div>
      </section>
      {canManageAccess && <AgentAccessManager agentId={id} />}
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
            <dd className="mt-1 break-all text-muted-foreground">{agent.agentKey}</dd>
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
              {agent.updatedAt.toLocaleString("zh-CN")}
            </dd>
          </div>
        </dl>
      </details>
    </StudioPage>
  );
}
