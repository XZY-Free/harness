"use client";

import { AgentContractRegistrationPanel } from "@/components/studio/agent-contract-registration-panel";
import { AgentRevisionActions } from "@/components/studio/agent-revision-actions";
import { AgentsViewer } from "@/components/studio/agents-viewer";
import { RouteActivationPanel } from "@/components/studio/route-activation-panel";
import { StudioPage } from "@/components/studio/studio-page";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  type AgentDTO,
  type RegisterAgentContractResponse,
  createControlPlaneClient,
} from "@/lib/control-plane-client";
import { ArrowLeft, Check, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const client = createControlPlaneClient({ baseUrl: "", headers: () => ({}) });
const STEPS = [
  {
    key: "contract",
    title: "认识智能体",
    description: "上传服务提供方交付的接入文件，核对名称和能为员工办理的事项。",
  },
  {
    key: "configure",
    title: "使用设置",
    description: "决定智能体可以使用哪些员工资料，以及办理业务时的确认要求。",
  },
  {
    key: "connect",
    title: "连接与发布",
    description: "使用服务提供方交付的连接信息，设置员工使用入口。",
  },
] as const;
type Step = (typeof STEPS)[number]["key"];
type Selection = { id: string; name: string; snapshotId: string | null; revisionId: string | null };

interface AgentRegistrationWorkspaceProps {
  readonly canDelete?: boolean;
  readonly canReadAgents: boolean;
  readonly canRegisterContract: boolean;
  readonly canManageRevisions: boolean;
  readonly canManageRoutes?: boolean;
  readonly projectableFields?: readonly string[];
}

/** 一次登记是一项连续任务；URL 仅保留已保存资源 id，不保存合同、凭证或表单正文。 */
export function AgentRegistrationWorkspace({
  canReadAgents,
  canDelete = false,
  canRegisterContract,
  canManageRevisions,
  canManageRoutes = false,
  projectableFields = [],
}: AgentRegistrationWorkspaceProps) {
  const [step, setStep] = useState<Step | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const openGeneration = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  function remember(next: Step | null, selection: Selection | null) {
    const url = new URL(window.location.href);
    for (const key of ["tab", "agent", "step"]) url.searchParams.delete(key);
    if (next && selection) {
      url.searchParams.set("agent", selection.id);
      url.searchParams.set("step", next);
    }
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }

  async function openAgent(agent: AgentDTO, preferredStep?: Step) {
    const generation = ++openGeneration.current;
    setRestoring(true);
    setError(null);
    try {
      const [contracts, revisions] = await Promise.all([
        client.agents.listContracts(agent.id),
        client.agents.listRevisions(agent.id),
      ]);
      if (generation !== openGeneration.current) return;
      const published = revisions.items.find(
        (r) => r.id === agent.current_revision_id && r.revision_state === "published",
      );
      const selection = {
        id: agent.id,
        name: agent.display_name,
        snapshotId: contracts.items[0]?.snapshot_id ?? null,
        revisionId: published?.id ?? null,
      };
      const next: Step =
        preferredStep === "connect" && published && canManageRoutes
          ? "connect"
          : canManageRevisions
            ? "configure"
            : canManageRoutes && published
              ? "connect"
              : "contract";
      setSelected(selection);
      setStep(next);
      remember(next, selection);
    } catch {
      if (generation !== openGeneration.current) return;
      setError("无法恢复登记进度，请稍后重试。已保存的合同和版本不会丢失。");
    } finally {
      if (generation === openGeneration.current) setRestoring(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅初始化恢复，后续由真实 API 响应交接
  useEffect(() => {
    const url = new URL(window.location.href);
    const id = url.searchParams.get("agent");
    if (!id || !canReadAgents) return;
    let active = true;
    setRestoring(true);
    client.agents
      .list()
      .then(async (list) => {
        if (!active) return;
        const agent = list.items.find((item) => item.id === id);
        if (!agent) {
          setError("该智能体不存在或当前账号无权访问，请从列表重新选择。");
          setRestoring(false);
          return;
        }
        await openAgent(
          agent,
          url.searchParams.get("step") === "connect" ? "connect" : "configure",
        );
      })
      .catch(() => {
        if (active) {
          setError("登记进度加载失败，请从列表重新打开。");
          setRestoring(false);
        }
      });
    return () => {
      active = false;
    };
    // 仅在进入页面时恢复；后续状态由当前任务的真实 API 响应交接。
  }, []);

  useEffect(() => {
    if (step) headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  function registered(result: RegisterAgentContractResponse) {
    const selection = {
      id: result.agent.id,
      name: result.agent.display_name,
      snapshotId: result.contract.snapshot_id,
      revisionId: null,
    };
    setSelected(selection);
    setRefreshToken((n) => n + 1);
    const next = canManageRevisions ? "configure" : "contract";
    setStep(next);
    remember(next, selection);
  }
  function ready(revisionId: string) {
    if (!selected) return;
    const selection = { ...selected, revisionId };
    setSelected(selection);
    setRefreshToken((n) => n + 1);
    if (canManageRoutes) {
      setStep("connect");
      remember("connect", selection);
    }
  }
  function leave() {
    openGeneration.current++;
    setStep(null);
    setSelected(null);
    setConfirmExit(false);
    setRefreshToken((n) => n + 1);
    remember(null, null);
  }
  const activeIndex = STEPS.findIndex((item) => item.key === step);
  const current = STEPS[activeIndex];

  return (
    <StudioPage
      title={step ? (selected?.name ?? "登记智能体") : "智能体"}
      width="wide"
      className="[&>header]:flex-row [&>header]:items-center [&_[data-slot=studio-page-actions]]:w-auto"
      actions={
        !step && canRegisterContract ? (
          <Button
            disabled={restoring}
            onClick={() => {
              setSelected(null);
              setStep("contract");
            }}
          >
            <Plus className="size-4" aria-hidden />
            登记智能体
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-5">
        {error && (
          <p role="alert" className="rounded-lg border p-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {restoring && (
          <output className="text-sm text-muted-foreground">正在读取已保存的登记进度…</output>
        )}
        {!step ? (
          <>
            {canReadAgents ? (
              <AgentsViewer
                canDelete={canDelete}
                refreshToken={refreshToken}
                onManage={
                  canManageRevisions || canManageRoutes
                    ? (agent) => void openAgent(agent)
                    : undefined
                }
              />
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">
                当前账号没有可查看的智能体。
              </p>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button variant="ghost" size="sm" onClick={() => setConfirmExit(true)}>
                <ArrowLeft className="size-4" aria-hidden />
                返回列表
              </Button>
              <span className="text-xs text-muted-foreground">
                {selected ? `${selected.name} · 已登记` : "登记新智能体"}
              </span>
            </div>
            <section aria-label="登记智能体" className="overflow-hidden rounded-xl border bg-card">
              <ol aria-label="登记步骤" className="grid grid-cols-3 border-b bg-muted/20">
                {STEPS.map((item, index) => (
                  <li
                    key={item.key}
                    aria-current={step === item.key ? "step" : undefined}
                    className={`flex min-w-0 items-center justify-center gap-2 px-2 py-4 text-xs sm:text-sm ${index === activeIndex ? "font-medium text-foreground" : "text-muted-foreground"}`}
                  >
                    <span
                      className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${index === activeIndex ? "bg-foreground text-background" : "border border-border"}`}
                    >
                      {index < activeIndex ? <Check className="size-3" aria-hidden /> : index + 1}
                    </span>
                    <span>{item.title}</span>
                  </li>
                ))}
              </ol>
              <div className="mx-auto max-w-3xl px-5 py-7 sm:px-8 sm:py-9">
                <header className="mb-7 space-y-2">
                  <h2
                    ref={headingRef}
                    tabIndex={-1}
                    className="text-xl font-semibold tracking-tight outline-none"
                  >
                    {current?.title}
                  </h2>
                  <p className="text-sm leading-6 text-muted-foreground">{current?.description}</p>
                </header>
                {step === "contract" &&
                  (canRegisterContract ? (
                    <AgentContractRegistrationPanel
                      onRegistered={registered}
                      submitLabel="确认合同并继续"
                      compact
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      合同已保存；当前账号没有配置版本的权限。
                    </p>
                  ))}
                {step === "configure" &&
                  selected &&
                  (canManageRevisions ? (
                    <AgentRevisionActions
                      key={selected.id}
                      agentId={selected.id}
                      preferredSnapshotId={selected.snapshotId}
                      refreshToken={refreshToken}
                      guided
                      projectableFields={projectableFields}
                      onPublished={(result) => ready(result.id)}
                      onContinue={canManageRoutes ? ready : undefined}
                    />
                  ) : (
                    <p>当前账号没有配置版本的权限。</p>
                  ))}
                {step === "connect" && selected && (
                  <RouteActivationPanel
                    canManage={canManageRoutes}
                    embedded
                    preferredAgentId={selected.id}
                    preferredAgentRevisionId={selected.revisionId}
                    refreshToken={refreshToken}
                    onBack={() => {
                      setStep("configure");
                      remember("configure", selected);
                    }}
                  />
                )}
              </div>
            </section>
            <p className="text-center text-xs leading-5 text-muted-foreground">
              合同与版本保存后，可从列表继续登记。新智能体需完成连接后，才能进入员工侧发布。
            </p>
          </>
        )}
        <AlertDialog open={confirmExit} onOpenChange={setConfirmExit}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>返回智能体列表？</AlertDialogTitle>
              <AlertDialogDescription>
                已保存的合同和版本会保留，下次可以继续。当前尚未保存的输入将丢失。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>继续登记</AlertDialogCancel>
              <AlertDialogAction onClick={leave}>返回列表</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </StudioPage>
  );
}
