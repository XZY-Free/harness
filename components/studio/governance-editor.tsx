"use client";

import { Check, LockKeyhole, Save } from "lucide-react";
import { useState } from "react";

import { StudioSettingsSection } from "@/components/studio/studio-settings-section";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";

interface GovernanceConfigShape {
  protectedPaths: string[];
  commandDenyList: string[];
  formatOnWrite: boolean;
  verifyBeforeDelivery: boolean;
  harnessLoopLimits?: {
    maxLoopSteps?: number;
    maxAgentCalls?: number;
    maxToolCalls?: number;
    maxKnowledgeSearches?: number;
    maxConsecutiveSameAction?: number;
  };
}

interface Props {
  initialConfig: GovernanceConfigShape;
  initialVersionNo: number;
  canWrite: boolean;
  revisionNo: number;
  publishedAt: string | null;
}

function textToLines(value: string[]): string {
  return value.join("\n");
}

function linesToText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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

export function GovernanceEditor({
  initialConfig,
  initialVersionNo,
  canWrite,
  publishedAt,
}: Props) {
  const [protectedPathsText, setProtectedPathsText] = useState(() =>
    textToLines(initialConfig.protectedPaths),
  );
  const [commandDenyListText, setCommandDenyListText] = useState(() =>
    textToLines(initialConfig.commandDenyList),
  );
  const [formatOnWrite, setFormatOnWrite] = useState(initialConfig.formatOnWrite);
  const [verifyBeforeDelivery, setVerifyBeforeDelivery] = useState(
    initialConfig.verifyBeforeDelivery,
  );
  const [versionNo, setVersionNo] = useState(initialVersionNo);
  const [lastSavedAt, setLastSavedAt] = useState(publishedAt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setNotice(null);

    const config: GovernanceConfigShape = {
      ...initialConfig,
      protectedPaths: linesToText(protectedPathsText),
      commandDenyList: linesToText(commandDenyListText),
      formatOnWrite,
      verifyBeforeDelivery,
    };

    try {
      const response = await fetch("/studio/api/governance", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": String(versionNo),
        },
        body: JSON.stringify({ config }),
      });

      if (response.status === 412) {
        setError("其他管理员已更新这份配置，请刷新页面后再保存。当前修改不会覆盖对方的内容。");
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
      setNotice("配置已保存");
    } catch {
      setError("网络连接异常，配置未保存。请稍后重试。");
    } finally {
      setSaving(false);
    }
  }

  if (!canWrite) {
    return (
      <div className="space-y-6">
        <ReadOnlyNotice />
        <StudioSettingsSection title="路径与命令保护" description="这些限制会在执行操作前生效。">
          <SummaryRow title="受保护路径">
            <ReadonlyList values={initialConfig.protectedPaths} />
          </SummaryRow>
          <SummaryRow title="禁止执行的命令">
            <ReadonlyList values={initialConfig.commandDenyList} />
          </SummaryRow>
        </StudioSettingsSection>

        <StudioSettingsSection title="自动检查">
          <SummaryRow title="写入前自动格式化">
            <ValueBadge enabled={initialConfig.formatOnWrite} />
          </SummaryRow>
          <SummaryRow title="交付前校验">
            <ValueBadge enabled={initialConfig.verifyBeforeDelivery} />
          </SummaryRow>
        </StudioSettingsSection>
        <LastSaved publishedAt={publishedAt} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StudioSettingsSection
        title="路径与命令保护"
        description="每行填写一条规则。保存后，新的执行请求会立即使用这些限制。"
      >
        <FormRow
          title="受保护路径"
          description="禁止自动修改的重要目录或文件。"
          inputId="governance-protected-paths"
        >
          <Textarea
            id="governance-protected-paths"
            aria-label="受保护路径"
            value={protectedPathsText}
            onChange={(event) => setProtectedPathsText(event.target.value)}
            placeholder={"/workspace/.env\n/workspace/config"}
            className="min-h-24 font-mono text-sm"
          />
        </FormRow>
        <FormRow
          title="禁止执行的命令"
          description="阻止高风险或不符合团队规范的命令。"
          inputId="governance-command-deny-list"
        >
          <Textarea
            id="governance-command-deny-list"
            aria-label="禁止执行的命令"
            value={commandDenyListText}
            onChange={(event) => setCommandDenyListText(event.target.value)}
            placeholder={"rm -rf\ndd"}
            className="min-h-24 font-mono text-sm"
          />
        </FormRow>
      </StudioSettingsSection>

      <StudioSettingsSection
        title="自动检查"
        description="在文件写入和结果交付时自动执行基础质量检查。"
      >
        <ToggleRow
          id="governance-format-on-write"
          title="写入前自动格式化"
          description="保存文件前按项目规则整理格式。"
          checked={formatOnWrite}
          onToggle={() => setFormatOnWrite((current) => !current)}
        />
        <ToggleRow
          id="governance-verify-before-delivery"
          title="交付前校验"
          description="完成任务前检查相关验证是否通过。"
          checked={verifyBeforeDelivery}
          onToggle={() => setVerifyBeforeDelivery((current) => !current)}
        />
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
          {saving ? "保存中…" : "保存配置"}
        </Button>
      </div>
    </div>
  );
}

function FormRow({
  title,
  description,
  inputId,
  children,
}: {
  title: string;
  description: string;
  inputId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-slot="studio-settings-row"
      className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(10rem,0.7fr)_minmax(16rem,1fr)] sm:gap-6"
    >
      <div className="space-y-1">
        <label htmlFor={inputId} className="text-sm font-medium text-foreground">
          {title}
        </label>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

function ToggleRow({
  id,
  title,
  description,
  checked,
  onToggle,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      data-slot="studio-settings-row"
      className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-6 px-4 py-3.5"
    >
      <div className="space-y-0.5">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {title}
        </label>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <Checkbox id={id} aria-label={title} checked={checked} onCheckedChange={onToggle} />
    </div>
  );
}

function SummaryRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      data-slot="studio-settings-row"
      className="grid min-h-16 grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)] items-center gap-6 px-4 py-3.5"
    >
      <span className="text-sm font-medium text-foreground">{title}</span>
      <div className="min-w-0 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

function ReadonlyList({ values }: { values: string[] }) {
  return values.length ? (
    <div className="space-y-1">
      {values.map((value) => (
        <code key={value} className="block break-all font-mono text-xs text-foreground">
          {value}
        </code>
      ))}
    </div>
  ) : (
    <span>未设置</span>
  );
}

function ValueBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className="inline-flex rounded-lg bg-muted px-2 py-1 text-xs text-foreground">
      {enabled ? "已开启" : "未开启"}
    </span>
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
