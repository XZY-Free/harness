"use client";

import { Check, LockKeyhole, Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import { StudioSettingsSection } from "@/components/studio/studio-settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Decision = "allow" | "pause" | "block";

interface RuleRow {
  id: string;
  ruleKey: string;
  toolPattern: string;
  argMatcher: Record<string, string> | null;
  decision: Decision;
  scope: { type: string; ref?: string };
  priority: number;
  reason: string | null;
}

interface Props {
  initialDefaultDecision: Decision;
  initialRules: RuleRow[];
  initialVersionNo: number;
  canWrite: boolean;
  revisionNo: number;
  publishedAt: string | null;
}

const DECISION_LABEL: Record<Decision, string> = {
  allow: "允许执行",
  pause: "确认后继续",
  block: "阻止执行",
};

const RISK_LABEL: Record<string, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  high_with_confirmation: "高风险，需要确认",
  critical: "严重风险",
};

function newRow(index: number): RuleRow {
  return {
    id: `__new_${index}_${Math.random()}`,
    ruleKey: `rule-${Date.now()}-${index}`,
    toolPattern: "tool.*",
    argMatcher: null,
    decision: "pause",
    scope: { type: "tenant" },
    priority: 0,
    reason: null,
  };
}

function errorMessageFrom(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as { error?: unknown; message?: unknown };
  if (typeof envelope.error === "string") return envelope.error;
  if (envelope.error && typeof envelope.error === "object") {
    const message = (envelope.error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return typeof envelope.message === "string" && envelope.message.trim() ? envelope.message : null;
}

function nextVersionFrom(etag: string | null): number | null {
  if (!etag) return null;
  const version = Number(etag.replace(/^W\//, "").replaceAll('"', ""));
  return Number.isInteger(version) ? version : null;
}

function publishedAtFromSuccessEnvelope(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const revision = (data as { revision?: unknown }).revision;
  if (!revision || typeof revision !== "object") return null;
  const nextPublishedAt = (revision as { publishedAt?: unknown }).publishedAt;
  return typeof nextPublishedAt === "string" && nextPublishedAt.trim() ? nextPublishedAt : null;
}

export function PermissionRulesEditor({
  initialDefaultDecision,
  initialRules,
  initialVersionNo,
  canWrite,
  publishedAt,
}: Props) {
  const [defaultDecision, setDefaultDecision] = useState(initialDefaultDecision);
  const [rules, setRules] = useState<RuleRow[]>(initialRules);
  const [versionNo, setVersionNo] = useState(initialVersionNo);
  const [lastSavedAt, setLastSavedAt] = useState(publishedAt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function updateRule(index: number, patch: Partial<RuleRow>) {
    setRules((current) =>
      current.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch } : rule)),
    );
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/studio/api/permission-rules", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": String(versionNo),
        },
        body: JSON.stringify({
          defaultDecision,
          rules: rules.map((rule) => ({
            ruleKey: rule.ruleKey,
            toolPattern: rule.toolPattern,
            argMatcher: rule.argMatcher,
            decision: rule.decision,
            scope: rule.scope,
            priority: rule.priority,
            reason: rule.reason,
          })),
        }),
      });

      if (response.status === 412) {
        setError("其他管理员已更新这些规则，请刷新页面后再保存。当前修改不会覆盖对方的内容。");
        return;
      }

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(errorMessageFrom(body) ?? `保存失败（${response.status}）`);
        return;
      }

      const body = await response.json().catch(() => null);
      const nextVersion = nextVersionFrom(response.headers.get("etag"));
      if (nextVersion !== null) setVersionNo(nextVersion);
      const nextPublishedAt = publishedAtFromSuccessEnvelope(body);
      if (nextPublishedAt) setLastSavedAt(nextPublishedAt);
      setNotice("规则已保存");
    } catch {
      setError("网络连接异常，规则未保存。请稍后重试。");
    } finally {
      setSaving(false);
    }
  }

  if (!canWrite) {
    return (
      <div className="space-y-6">
        <ReadOnlyNotice />
        <StudioSettingsSection title="默认处理">
          <SummaryRow title="默认处理方式">
            <DecisionBadge decision={initialDefaultDecision} />
          </SummaryRow>
        </StudioSettingsSection>
        <StudioSettingsSection title="工具规则" description="规则按优先级匹配，数值越大越先执行。">
          {initialRules.length ? (
            initialRules.map((rule, index) => (
              <ReadonlyRuleCard key={rule.id} rule={rule} index={index} />
            ))
          ) : (
            <EmptyRules />
          )}
        </StudioSettingsSection>
        <LastSaved publishedAt={publishedAt} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StudioSettingsSection
        title="默认处理"
        description="当没有匹配规则时，系统会采用这里的处理方式。"
      >
        <div
          data-slot="studio-settings-row"
          className="flex min-h-16 flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <div className="text-sm font-medium text-foreground">默认处理方式</div>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              建议默认阻止，再按需要逐条放行。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={defaultDecision}
              onValueChange={(value) => setDefaultDecision(value as Decision)}
            >
              <SelectTrigger aria-label="默认处理方式" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>{decisionOptions()}</SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRules((current) => [...current, newRow(current.length)])}
            >
              <Plus aria-hidden="true" />
              新增规则
            </Button>
          </div>
        </div>
      </StudioSettingsSection>

      <StudioSettingsSection title="工具规则" description="规则按优先级匹配，数值越大越先执行。">
        {rules.length ? (
          rules.map((rule, index) => (
            <EditableRuleCard
              key={rule.id}
              rule={rule}
              index={index}
              onChange={(patch) => updateRule(index, patch)}
              onDelete={() =>
                setRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index))
              }
            />
          ))
        ) : (
          <EmptyRules />
        )}
      </StudioSettingsSection>

      {error && (
        <div
          role="alert"
          className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      {notice && (
        <output className="flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-sm text-success">
          <Check className="size-4" aria-hidden="true" />
          {notice}
        </output>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <LastSaved publishedAt={lastSavedAt} />
        <Button onClick={handleSave} disabled={saving} className="self-start sm:self-auto">
          <Save aria-hidden="true" />
          {saving ? "保存中…" : "保存规则"}
        </Button>
      </div>
    </div>
  );
}

function EditableRuleCard({
  rule,
  index,
  onChange,
  onDelete,
}: {
  rule: RuleRow;
  index: number;
  onChange: (patch: Partial<RuleRow>) => void;
  onDelete: () => void;
}) {
  const prefix = `permission-rule-${rule.id}`;
  return (
    <article data-slot="studio-settings-row" className="space-y-4 px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">规则 {index + 1}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">设置匹配范围与执行方式</p>
        </div>
        <Button type="button" variant="destructive" size="sm" onClick={onDelete}>
          <Trash2 aria-hidden="true" />
          删除
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <InputField id={`${prefix}-key`} label="规则名称">
          <Input
            id={`${prefix}-key`}
            aria-label="规则名称"
            value={rule.ruleKey}
            onChange={(event) => onChange({ ruleKey: event.target.value })}
            className="font-mono"
          />
        </InputField>
        <InputField id={`${prefix}-pattern`} label="工具匹配范围">
          <Input
            id={`${prefix}-pattern`}
            aria-label="工具匹配范围"
            value={rule.toolPattern}
            onChange={(event) => onChange({ toolPattern: event.target.value })}
            className="font-mono"
          />
        </InputField>
        <InputField id={`${prefix}-decision`} label="处理方式">
          <Select
            value={rule.decision}
            onValueChange={(value) => onChange({ decision: value as Decision })}
          >
            <SelectTrigger id={`${prefix}-decision`} aria-label="处理方式" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>{decisionOptions()}</SelectContent>
          </Select>
        </InputField>
        <InputField id={`${prefix}-priority`} label="优先级">
          <Input
            id={`${prefix}-priority`}
            aria-label="优先级"
            type="number"
            value={rule.priority}
            onChange={(event) => onChange({ priority: Number(event.target.value) || 0 })}
          />
        </InputField>
        <InputField id={`${prefix}-reason`} label="说明" className="sm:col-span-2">
          <Input
            id={`${prefix}-reason`}
            aria-label="说明"
            value={rule.reason ?? ""}
            onChange={(event) => onChange({ reason: event.target.value || null })}
            placeholder="说明这条规则的用途"
          />
        </InputField>
      </div>
    </article>
  );
}

function ReadonlyRuleCard({ rule, index }: { rule: RuleRow; index: number }) {
  return (
    <article data-slot="studio-settings-row" className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-foreground">规则 {index + 1}</h3>
          <code className="mt-0.5 block break-all font-mono text-xs text-muted-foreground">
            {rule.ruleKey}
          </code>
        </div>
        <DecisionBadge decision={rule.decision} />
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <SummaryTerm label="工具匹配范围" value={rule.toolPattern} mono />
        <SummaryTerm label="参数条件" value={<MatcherSummary matcher={rule.argMatcher} />} />
        <SummaryTerm label="适用范围" value={scopeLabel(rule.scope)} />
        <SummaryTerm label="优先级" value={String(rule.priority)} />
        <SummaryTerm label="说明" value={rule.reason || "未填写"} />
      </dl>
    </article>
  );
}

function InputField({
  id,
  label,
  className = "",
  children,
}: {
  id: string;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function SummaryRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      data-slot="studio-settings-row"
      className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-6 px-4 py-3.5"
    >
      <span className="text-sm font-medium text-foreground">{title}</span>
      {children}
    </div>
  );
}

function SummaryTerm({
  label,
  value,
  mono = false,
}: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all text-foreground ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function MatcherSummary({ matcher }: { matcher: RuleRow["argMatcher"] }) {
  if (!matcher || Object.keys(matcher).length === 0) return <span>所有参数</span>;
  return (
    <div className="space-y-1">
      {matcher.pathRegex ? (
        <div>
          <span className="text-xs text-muted-foreground">路径匹配</span>
          <code className="ml-1 break-all font-mono text-xs text-foreground">
            {matcher.pathRegex}
          </code>
        </div>
      ) : null}
      {matcher.commandRegex ? (
        <div>
          <span className="text-xs text-muted-foreground">命令匹配</span>
          <code className="ml-1 break-all font-mono text-xs text-foreground">
            {matcher.commandRegex}
          </code>
        </div>
      ) : null}
      {matcher.risk ? (
        <div>
          <span className="text-xs text-muted-foreground">风险等级</span>
          <span className="ml-1 text-foreground">{RISK_LABEL[matcher.risk] ?? "其他等级"}</span>
        </div>
      ) : null}
    </div>
  );
}

function scopeLabel(scope: RuleRow["scope"]): string {
  switch (scope.type) {
    case "tenant":
      return "当前租户";
    case "global":
      return "全部租户";
    case "thread":
      return scope.ref ? "指定对话" : "全部对话";
    case "project":
      return scope.ref ? "指定项目" : "全部项目";
    case "skill":
      return scope.ref ? "指定技能" : "全部技能";
    default:
      return "其他限定范围";
  }
}

function DecisionBadge({ decision }: { decision: Decision }) {
  return (
    <span className="inline-flex rounded-lg bg-muted px-2 py-1 text-xs text-foreground">
      {DECISION_LABEL[decision]}
    </span>
  );
}

function EmptyRules() {
  return (
    <div
      data-slot="studio-settings-row"
      className="px-4 py-8 text-center text-sm text-muted-foreground"
    >
      暂无单独规则，将使用默认处理方式。
    </div>
  );
}

function ReadOnlyNotice() {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">
      <LockKeyhole className="size-4" aria-hidden="true" />
      <span>仅可查看</span>
    </div>
  );
}

function LastSaved({ publishedAt }: { publishedAt: string | null }) {
  if (!publishedAt) return null;
  return (
    <p className="text-xs text-muted-foreground">
      最近保存：{new Date(publishedAt).toLocaleString("zh-CN")}
    </p>
  );
}

function decisionOptions() {
  return (Object.entries(DECISION_LABEL) as Array<[Decision, string]>).map(([value, label]) => (
    <SelectItem key={value} value={value}>
      {label}
    </SelectItem>
  ));
}
