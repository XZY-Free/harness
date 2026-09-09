/**
 * 用户操作 Item（user_action）—  统一四类 UserAction 体验。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md §3.18（解析 UserActionRequest）
 * - docs/architecture/product-surfaces-and-admin.md
 *
 * content 结构（按 request_type）：
 * - 通用字段：{ request_type, purpose?, reason?, impact?, state?, expires_at?, title?, summary? }
 * - confirmation：{ target_path?, line_additions?, line_deletions?, diff? }
 * - auth：{ scope?, auth_url? }
 * - grant：{ scope?, target_tool?, credential_ref_id? }
 * - input：{ input_schema? }
 *
 * 渲染规则：
 * - confirmation/auth/grant/input 四类使用统一卡片，展示请求方、原因、范围、有效期和影响。
 * - 高影响操作展示目标对象与预计副作用；超时或拒绝后不伪装成执行成功。
 * - Agent 与 Runtime Authority：废弃 handoff（「把会话交接给主 Agent」语义随 Agent 非前置移除），
 *   不再有 handoff 专属分支；一律走 useUserAction。
 * - auth 类型 :resolve 接口仅接受 cancel；approve 由可信 callback 写入，UI 显示「去授权」链接。
 * - input 类型 submit 时收集用户输入并作为 responseRedactedJson 提交。
 * - 超时（state=expired 或 expires_at 已过）不显示操作按钮，显示「已超时」。
 *
 * 样式：操作卡片（带图标 + 状态 + 按钮）。
 */
"use client";

import { useUserAction } from "@/components/hooks/use-user-action";
import type { ClientItem } from "@/lib/client/types";
import type { UserActionResolution } from "@/lib/persistence/schema/user-action-request";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  FilePenLine,
  ListTree,
  X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

interface UserActionItemProps {
  /** 当前 Thread id；用于构造 :resolve 路径。 */
  readonly threadId: string;
  /** user_action ThreadItem。 */
  readonly item: ClientItem;
}

/** user_action ThreadItem content 投影（按 request_type 收集所有可能字段）。 */
interface UserActionContent {
  request_type?: string;
  purpose?: string;
  reason?: string;
  impact?: string;
  /** 请求状态：pending | resolved | expired（由 user_action.resolved / 平台过期任务写入）。 */
  state?: string;
  /** 过期时间（ISO 8601 字符串）。 */
  expires_at?: string;
  /** auth/grant 类型：授权范围。 */
  scope?: string | readonly string[];
  /** auth 类型：可信授权 URL（OAuth/OIDC 入口）。 */
  auth_url?: string;
  /** grant 类型：目标工具名。 */
  target_tool?: string;
  /** input 类型：JSON Schema（描述用户应提交的响应结构）。 */
  input_schema?: Record<string, unknown>;
  /** UserActionRequest（Authority）id；:resolve 必须使用此 id，禁止 fallback 到 item.id。 */
  request_id?: string;
  /** 请求方提供的标题（覆盖默认类型标题）。 */
  title?: string;
  /** 请求方提供的摘要（覆盖 reason 显示）。 */
  summary?: string;
  /** 面向用户的问题；purpose 是内部分类，不作为展示正文。 */
  prompt?: string;
  /** Agent input-required 的安全目录名称。 */
  agent_display_name?: string | null;
  /** 外部 Agent confirmation 经过服务端协议校验后的安全预览。 */
  preview?: Record<string, unknown>;
  resolution?: UserActionResolution;
  /** confirmation 类型：等待确认的目标文件。 */
  target_path?: string;
  /** confirmation 类型：diff 新增/删除行数。 */
  line_additions?: number;
  line_deletions?: number;
  /** confirmation 类型：等待用户审阅的文本 diff。 */
  diff?: string;
}

/** request_type 中文映射。 */
function getRequestTypeLabel(requestType: string | undefined): string {
  switch (requestType) {
    case "confirmation":
      return "确认请求";
    case "auth":
      return "授权请求";
    case "grant":
      return "权限授予请求";
    case "input":
      return "输入请求";
    default:
      return "操作请求";
  }
}

/** resolution 中文映射。 */
function getResolutionLabel(resolution: UserActionResolution | null): string {
  switch (resolution) {
    case "approve":
      return "已同意";
    case "deny":
      return "已拒绝";
    case "submit":
      return "已提交";
    case "cancel":
      return "已取消";
    default:
      return "已解析";
  }
}

/** 格式化过期时间倒计时（粗略，不自动刷新）。 */
function formatExpiresAt(expiresAt: string | undefined): string | null {
  if (!expiresAt) return null;
  const target = new Date(expiresAt).getTime();
  if (!Number.isFinite(target)) return null;
  const now = Date.now();
  if (target <= now) return "已超时";
  const diff = target - now;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟后超时`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时后超时`;
  const days = Math.floor(hours / 24);
  return `${days} 天后超时`;
}

/** 从 input_schema 提取字段定义（轻量实现，不引入完整 JSON Schema 库）。 */
interface InputFieldDef {
  key: string;
  label: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** 字段无 title 时的中文默认 label：不暴露裸技术键。 */
function defaultFieldLabel(key: string, index: number): string {
  if (key === "text") return "补充信息";
  return `输入项 ${index + 1}`;
}

/** input_schema 解析结果：ok=false 表示 schema 缺失/空/不支持/含非法 pattern，fail-closed。 */
interface InputSchemaParseResult {
  readonly ok: boolean;
  readonly fields: readonly InputFieldDef[];
}

function extractInputFields(schema: Record<string, unknown> | undefined): InputSchemaParseResult {
  const fail: InputSchemaParseResult = { ok: false, fields: [] };
  if (!schema || typeof schema !== "object") return fail;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || typeof properties !== "object") return fail;
  const entries = Object.entries(properties);
  if (entries.length === 0) return fail;
  const requiredList = (schema.required as readonly string[] | undefined) ?? [];
  const fields: InputFieldDef[] = [];
  let index = 0;
  for (const [key, def] of entries) {
    if (!def || typeof def !== "object") return fail;
    const type = (def.type as string | undefined) ?? "string";
    if (type !== "string" && type !== "number" && type !== "boolean") return fail;
    const pattern = typeof def.pattern === "string" ? def.pattern : undefined;
    if (pattern) {
      try {
        void new RegExp(pattern);
      } catch {
        // 非法正则：schema 本身不可用，UI 与服务端一致 fail-closed。
        return fail;
      }
    }
    const fieldIndex = index;
    index += 1;
    fields.push({
      key,
      label:
        (def.title as string | undefined) ??
        (def.description as string | undefined) ??
        defaultFieldLabel(key, fieldIndex),
      type,
      required: requiredList.includes(key),
      description: def.description as string | undefined,
      enum: Array.isArray(def.enum) ? (def.enum as readonly string[]) : undefined,
      minLength: typeof def.minLength === "number" ? def.minLength : undefined,
      maxLength: typeof def.maxLength === "number" ? def.maxLength : undefined,
      pattern,
    });
  }
  return { ok: true, fields };
}

/**
 * 客户端按已支持 schema 子集校验单字段，返回归一后的提交值。
 * omitted/required 语义：可选字段留空 → omit（提交对象省略该键）；
 * 必填字段留空非法；boolean 必须显式选择 true/false（提交实际布尔值）。
 */
type NormalizedFieldValue =
  | { ok: true; omit: true }
  | { ok: true; omit: false; value: string | number | boolean }
  | { ok: false };

function normalizeFieldValue(field: InputFieldDef, raw: string): NormalizedFieldValue {
  const trimmed = raw.trim();
  if (field.type === "number") {
    if (!trimmed) return field.required ? { ok: false } : { ok: true, omit: true };
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return { ok: false };
    return { ok: true, omit: false, value: num };
  }
  if (field.type === "boolean") {
    // 未选择（空）→ 可选则省略，必填则非法；任意其他文本不接受（防把杂串归一成 false）。
    if (!trimmed) return field.required ? { ok: false } : { ok: true, omit: true };
    if (trimmed === "true") return { ok: true, omit: false, value: true };
    if (trimmed === "false") return { ok: true, omit: false, value: false };
    return { ok: false };
  }
  if (!trimmed) return field.required ? { ok: false } : { ok: true, omit: true };
  if (field.enum && !field.enum.includes(trimmed)) return { ok: false };
  if (field.minLength !== undefined && trimmed.length < field.minLength) return { ok: false };
  if (field.maxLength !== undefined && trimmed.length > field.maxLength) return { ok: false };
  if (field.pattern && !new RegExp(field.pattern).test(trimmed)) return { ok: false };
  return { ok: true, omit: false, value: trimmed };
}

/** 历史数据也按受限结构显示，永不把未知对象当 HTML、链接或可执行内容处理。 */
function isStructuredPreview(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).length <= 8
  );
}

function previewText(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

const PREVIEW_FIELD_LABELS: Readonly<Record<string, string>> = {
  leave_type: "假期类型",
  days: "天数",
  dates: "日期",
  reviewer: "审批人",
  name: "姓名",
  start_date: "开始日期",
  end_date: "结束日期",
  reason: "事由",
  amount: "金额",
  currency: "币种",
  recipient: "接收方",
};

/** 外部协议键只用于读取，不直接暴露给员工界面。 */
function previewFieldLabel(key: string, index: number): string {
  return PREVIEW_FIELD_LABELS[key] ?? `信息 ${index + 1}`;
}

function PreviewValue({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return previewText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth >= 2) return "已省略嵌套内容";
  if (Array.isArray(value)) {
    return (
      <ul className="space-y-0.5">
        {value.slice(0, 12).map((entry, index) => (
          <li
            key={`${depth}:${index}:${typeof entry === "string" ? entry : JSON.stringify(entry)}`}
            className="break-words"
          >
            <PreviewValue value={entry} depth={depth + 1} />
          </li>
        ))}
        {value.length > 12 ? <li>已省略其余项目</li> : null}
      </ul>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 8);
    return (
      <dl className="space-y-1 border-l border-border pl-2">
        {entries.map(([key, nested], index) => (
          <div key={key} className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-2">
            <dt className="max-w-32 truncate text-muted-foreground">
              {previewFieldLabel(key, index)}
            </dt>
            <dd className="min-w-0 break-words">
              <PreviewValue value={nested} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return "—";
}

export function UserActionItem({ threadId, item }: UserActionItemProps) {
  const content = item.content as UserActionContent;

  // userAction hook 处理 confirmation/auth/grant/input 类型。
  // Agent 与 Runtime Authority 废弃 handoff（「把会话交接给主 Agent」语义随 Agent 非前置移除），不再有 handoff 专属分支。
  const userActionHook = useUserAction({ threadId });

  // 请求状态：优先用 content.state，其次用 item.item_state 推断
  // - content.state=pending|resolved|expired（由 user_action.resolved 或平台过期任务写入）
  // - item.item_state=pending|completed|failed|cancelled（ThreadItem 自身状态）
  const isExpired =
    content.state === "expired" ||
    (content.expires_at ? new Date(content.expires_at).getTime() <= Date.now() : false);
  // Authority 引用：:resolve 只能使用非空 request_id；缺失/空白 → fail-closed（绝不 fallback 到 item.id）。
  const requestId =
    typeof content.request_id === "string" && content.request_id.trim().length > 0
      ? content.request_id.trim()
      : null;
  const isItemPending = item.item_state === "pending";
  const isRequestPending = content.state === "pending" || (!content.state && isItemPending);
  const isResolved =
    content.state === "resolved" || (!isRequestPending && !isExpired && !isItemPending);

  // 最近一次解析结果（用于 UI 显示 "已同意/已拒绝/已提交/已取消"）
  // 只按 Authority request_id 匹配；request_id 缺失时不回退到 item.id。
  const resolvedResolution =
    requestId && userActionHook.lastResolve?.request_id === requestId
      ? userActionHook.lastResolve.resolution
      : content.state === "resolved"
        ? (content.resolution ?? null)
        : null;

  const busy = userActionHook.busy;
  const error = userActionHook.error;
  const clearError = userActionHook.clearError;

  const requestTypeLabel = getRequestTypeLabel(content.request_type);
  const isAgentInputRequired =
    content.request_type === "input" && content.purpose === "a2a_input_required";
  const agentDisplayName =
    typeof content.agent_display_name === "string" && content.agent_display_name.trim().length > 0
      ? content.agent_display_name.trim()
      : "助手";
  const displayTitle =
    content.title ?? (isAgentInputRequired ? `${agentDisplayName}需要补充信息` : requestTypeLabel);
  const displayReason =
    [content.prompt, content.summary, content.reason].find(
      (value) => typeof value === "string" && value.trim().length > 0,
    ) ?? "需要你的操作";
  const preview = isStructuredPreview(content.preview) ? content.preview : null;

  // input 类型的字段（schema 缺失/空/不支持/非法 pattern → ok=false，fail-closed）
  const inputSchema = useMemo(
    () => extractInputFields(content.input_schema),
    [content.input_schema],
  );
  const inputFields = inputSchema.fields;
  const singleChoiceField =
    inputFields.length === 1 && inputFields[0]?.enum && inputFields[0].enum.length > 0
      ? inputFields[0]
      : null;
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [diffOpen, setDiffOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  // 是否展示操作按钮
  const showActions = isRequestPending && !isExpired && !resolvedResolution;
  const isDiffConfirmation =
    content.request_type === "confirmation" &&
    typeof content.diff === "string" &&
    content.diff.length > 0;
  const isDiffResolved = isDiffConfirmation && isResolved;

  const handleUserActionResolve = (
    resolution: UserActionResolution,
    options?: { responseRedactedJson?: unknown },
  ) => {
    if (busy || !showActions || !requestId) return;
    clearError();
    void userActionHook.resolve(requestId, resolution, options);
  };

  const handleInputChange = (key: string, value: string) => {
    setInputValues((prev) => ({ ...prev, [key]: value }));
  };

  // 客户端按已支持 schema 子集校验（omitted/required、type/minLength/maxLength/pattern/enum）。
  // 仅用于体验（禁用提交、避免消费后无法重试）；服务端 Ajv 校验仍是 Authority。
  const inputFormValid = (() => {
    if (!inputSchema.ok) return false;
    for (const field of inputFields) {
      const normalized = normalizeFieldValue(field, inputValues[field.key] ?? "");
      if (!normalized.ok) return false;
    }
    return true;
  })();

  const submitInputValues = (values: Readonly<Record<string, string>>) => {
    if (busy || !showActions || !requestId || !inputSchema.ok) return;
    // 把表单值转换为对应类型（字符串 trim）；可选字段留空 → 省略该键
    const response: Record<string, unknown> = {};
    for (const field of inputFields) {
      const normalized = normalizeFieldValue(field, values[field.key] ?? "");
      if (!normalized.ok) return;
      if (normalized.ok && !normalized.omit) response[field.key] = normalized.value;
    }
    handleUserActionResolve("submit", { responseRedactedJson: response });
  };

  const handleInputSubmit = () => {
    if (!inputFormValid) return;
    submitInputValues(inputValues);
  };

  const handleSingleChoiceSubmit = (field: InputFieldDef, value: string) => {
    const nextValues = { ...inputValues, [field.key]: value };
    setInputValues(nextValues);
    submitInputValues(nextValues);
  };

  // 状态标签
  const statusLabel = isExpired
    ? "已超时"
    : resolvedResolution
      ? getResolutionLabel(resolvedResolution)
      : isRequestPending
        ? content.request_type === "input"
          ? "需要你的输入"
          : content.request_type === "auth"
            ? "需要你授权"
            : "需要你的确认"
        : item.item_state === "completed"
          ? "已完成"
          : item.item_state === "failed"
            ? "失败"
            : "等待处理";

  const statusColor = isExpired
    ? "border-destructive/30 bg-destructive/5"
    : resolvedResolution
      ? "border-success/25 bg-success/5"
      : isRequestPending
        ? "border-border bg-card"
        : "border-border bg-muted/40";

  const statusTagColor = isExpired
    ? "bg-destructive/10 text-destructive"
    : resolvedResolution
      ? "bg-success/10 text-success"
      : isRequestPending
        ? "bg-muted text-muted-foreground"
        : "bg-muted-foreground/10 text-muted-foreground";

  const expiresLabel = formatExpiresAt(content.expires_at);

  // 渲染操作按钮区
  const renderActions = () => {
    if (!showActions) return null;

    switch (content.request_type) {
      case "confirmation":
        if (isDiffConfirmation) {
          return (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setDiffOpen((open) => !open)}
                className="rounded-full border border-border bg-background px-4 py-1.5 text-xs font-medium text-foreground transition hover:border-border-strong hover:bg-accent"
              >
                查看差异
              </button>
              <button
                type="button"
                onClick={() => handleUserActionResolve("approve")}
                disabled={busy || !requestId}
                className="rounded-full bg-primary px-[18px] py-[7px] text-primary-foreground text-xs font-medium transition hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "写入中…" : "确认写入"}
              </button>
            </div>
          );
        }
        return (
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => handleUserActionResolve("approve")}
              disabled={busy || !requestId}
              className="flex-1 rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-xs transition hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "处理中…" : "确认"}
            </button>
            <button
              type="button"
              onClick={() => handleUserActionResolve("deny")}
              disabled={busy || !requestId}
              className="flex-1 rounded-md border border-border px-3 py-1.5 text-muted-foreground text-xs transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "处理中…" : "拒绝"}
            </button>
          </div>
        );

      case "grant":
        return (
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => handleUserActionResolve("approve")}
              disabled={busy || !requestId}
              className="flex-1 rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-xs transition hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "处理中…" : "同意授权"}
            </button>
            <button
              type="button"
              onClick={() => handleUserActionResolve("deny")}
              disabled={busy || !requestId}
              className="flex-1 rounded-md border border-border px-3 py-1.5 text-muted-foreground text-xs transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "处理中…" : "拒绝"}
            </button>
          </div>
        );

      case "auth":
        // auth 类型 :resolve 仅接受 cancel；approve 由可信 callback 写入
        return (
          <div className="mt-3 flex gap-2">
            {content.auth_url ? (
              <a
                href={content.auth_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 rounded-md bg-primary px-3 py-1.5 text-center text-primary-foreground text-xs transition hover:bg-primary/85"
              >
                去授权
              </a>
            ) : (
              <span className="flex-1 rounded-[var(--radius-sm)] bg-card px-3 py-1.5 text-center text-xs text-muted-foreground">
                等待授权回调
              </span>
            )}
            <button
              type="button"
              onClick={() => handleUserActionResolve("cancel")}
              disabled={busy || !requestId}
              className="flex-1 rounded-md border border-border px-3 py-1.5 text-muted-foreground text-xs transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "处理中…" : "取消授权"}
            </button>
          </div>
        );

      default:
        return null;
    }
  };

  if (content.request_type === "input") {
    const panelState = isExpired ? "expired" : showActions ? "waiting" : "resolved";

    if (!showActions) {
      return (
        <div className="flex justify-start">
          <section
            aria-label="用户输入记录"
            data-user-action-state={panelState}
            className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-[0_10px_30px_-28px_rgba(15,23,42,0.45)]"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted/45 text-muted-foreground">
              {isExpired ? (
                <CircleAlert aria-hidden="true" className="size-3.5" strokeWidth={1.6} />
              ) : (
                <Check aria-hidden="true" className="size-3.5" strokeWidth={1.7} />
              )}
            </span>
            <p className="min-w-0 flex-1 truncate text-[13px] text-foreground">{displayReason}</p>
            <span className="shrink-0 text-[12px] text-muted-foreground">
              {isExpired
                ? "已超时"
                : resolvedResolution
                  ? getResolutionLabel(resolvedResolution)
                  : statusLabel}
            </span>
          </section>
        </div>
      );
    }

    return (
      <div className="flex justify-start">
        <section
          aria-label="需要用户输入"
          data-user-action-state={panelState}
          className="w-full rounded-[20px] border border-border bg-card p-3 shadow-[0_18px_48px_-40px_rgba(15,23,42,0.55)] sm:p-4"
        >
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-[13px] leading-5 text-foreground">{displayReason}</p>
              {isAgentInputRequired ? (
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {agentDisplayName}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => handleUserActionResolve("cancel")}
              disabled={busy || !requestId}
              aria-label="关闭输入请求"
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
            </button>
          </header>

          {!inputSchema.ok ? (
            <div
              className="mt-3 rounded-xl bg-muted/55 px-3 py-2 text-[12px] text-muted-foreground"
              role="alert"
            >
              请求的输入定义不可用，无法提交；请刷新会话后重试。
            </div>
          ) : singleChoiceField ? (
            <fieldset className="mt-2 space-y-0.5">
              <legend className="sr-only">可选答案</legend>
              {singleChoiceField.enum?.map((option, optionIndex) => (
                <button
                  key={option}
                  type="button"
                  aria-label={`选择 ${option}`}
                  onClick={() => handleSingleChoiceSubmit(singleChoiceField, option)}
                  disabled={busy || !requestId}
                  className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-background text-[11px] text-muted-foreground">
                    {optionIndex + 1}
                  </span>
                  <span className="min-w-0 flex-1 font-medium text-[12.5px] leading-5 text-foreground">
                    {option}
                  </span>
                  <ArrowRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                    strokeWidth={1.5}
                  />
                </button>
              ))}
            </fieldset>
          ) : (
            <div className="mt-3 space-y-2">
              {inputFields.map((field) => (
                <div key={field.key} className="space-y-1">
                  <label
                    htmlFor={`ua-input-${item.id}-${field.key}`}
                    className="block px-1 text-[11px] leading-4 text-muted-foreground"
                  >
                    {field.label}
                    {field.required ? "*" : ""}
                  </label>
                  {field.enum ? (
                    <select
                      id={`ua-input-${item.id}-${field.key}`}
                      value={inputValues[field.key] ?? ""}
                      onChange={(event) => handleInputChange(field.key, event.target.value)}
                      disabled={busy || !requestId}
                      className="h-10 w-full rounded-xl border border-transparent bg-muted/55 px-3 text-[13px] text-foreground outline-none transition focus:border-border-strong focus:bg-background focus:ring-2 focus:ring-ring/15 disabled:opacity-40"
                    >
                      <option value="">请选择…</option>
                      {field.enum.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : field.type === "boolean" ? (
                    <select
                      id={`ua-input-${item.id}-${field.key}`}
                      value={inputValues[field.key] ?? ""}
                      onChange={(event) => handleInputChange(field.key, event.target.value)}
                      disabled={busy || !requestId}
                      className="h-10 w-full rounded-xl border border-transparent bg-muted/55 px-3 text-[13px] text-foreground outline-none transition focus:border-border-strong focus:bg-background focus:ring-2 focus:ring-ring/15 disabled:opacity-40"
                    >
                      <option value="">请选择…</option>
                      <option value="true">是</option>
                      <option value="false">否</option>
                    </select>
                  ) : (
                    <input
                      id={`ua-input-${item.id}-${field.key}`}
                      type={field.type === "number" ? "number" : "text"}
                      value={inputValues[field.key] ?? ""}
                      onChange={(event) => handleInputChange(field.key, event.target.value)}
                      disabled={busy || !requestId}
                      placeholder={field.description ?? "输入你的回答"}
                      className="h-10 w-full rounded-xl border border-transparent bg-muted/55 px-3 text-[13px] text-foreground outline-none transition placeholder:text-muted-foreground/65 focus:border-border-strong focus:bg-background focus:ring-2 focus:ring-ring/15 disabled:opacity-40"
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {!requestId ? (
            <div
              className="mt-3 rounded-xl bg-muted px-3 py-2 text-[12px] text-foreground"
              role="alert"
            >
              操作信息不完整，无法执行操作；请刷新会话后重试。
            </div>
          ) : null}

          {error ? (
            <div
              className="mt-3 flex items-center justify-between rounded-xl bg-destructive/8 px-3 py-2 text-[12px] text-destructive"
              role="alert"
            >
              <span>
                {error.title}：{error.description}
              </span>
              <button
                type="button"
                onClick={clearError}
                aria-label="关闭错误提示"
                className="ml-2 flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-destructive/10"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </div>
          ) : null}

          <footer className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => handleUserActionResolve("cancel")}
              disabled={busy || !requestId}
              aria-label="取消"
              className="rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              跳过
            </button>
            {!singleChoiceField ? (
              <button
                type="button"
                onClick={handleInputSubmit}
                disabled={busy || !requestId || !inputFormValid}
                className="group flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-35"
              >
                <span>{busy ? "处理中…" : isAgentInputRequired ? "继续同一任务" : "提交"}</span>
                <ArrowRight
                  aria-hidden="true"
                  className="size-3.5 transition-transform group-hover:translate-x-0.5"
                  strokeWidth={1.6}
                />
              </button>
            ) : null}
          </footer>
        </section>
      </div>
    );
  }

  if (content.request_type === "confirmation" && !isDiffConfirmation) {
    const panelState = isExpired ? "expired" : showActions ? "waiting" : "resolved";
    const panelStatus = isExpired
      ? "已超时"
      : resolvedResolution
        ? getResolutionLabel(resolvedResolution)
        : showActions
          ? "需要你的确认"
          : statusLabel;

    return (
      <div className="flex justify-start">
        <section
          aria-label={showActions ? "需要用户确认" : "用户操作记录"}
          data-user-action-state={panelState}
          className="w-full overflow-hidden rounded-2xl border border-border bg-card shadow-[0_16px_40px_-32px_rgba(15,23,42,0.35)]"
        >
          <div className="px-4 pt-4 pb-3 sm:px-5 sm:pt-[18px]">
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                {resolvedResolution ? (
                  <Check aria-hidden="true" className="size-3.5" strokeWidth={1.7} />
                ) : (
                  <CircleHelp aria-hidden="true" className="size-3.5" strokeWidth={1.7} />
                )}
                {panelStatus}
              </span>
              {expiresLabel && showActions ? <span>{expiresLabel}</span> : null}
            </div>

            <h2 className="mt-2.5 font-medium text-[14px] leading-5 text-foreground">
              {displayTitle}
            </h2>
            <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">{displayReason}</p>
            {content.impact ? (
              <p className="mt-0.5 text-[12.5px] leading-5 text-muted-foreground">
                {content.impact}
              </p>
            ) : null}
          </div>

          {preview ? (
            <div className="px-2 pb-1.5 sm:px-3">
              <button
                type="button"
                onClick={() => setPreviewOpen((open) => !open)}
                aria-expanded={previewOpen}
                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="flex items-center gap-2">
                  <ListTree aria-hidden="true" className="size-3.5" strokeWidth={1.6} />
                  {previewOpen ? "收起操作详情" : "查看操作详情"}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn("size-3.5 transition-transform", previewOpen && "rotate-180")}
                  strokeWidth={1.6}
                />
              </button>

              {previewOpen ? (
                <section
                  aria-label="操作详情"
                  className="mx-1 mb-2 rounded-xl bg-muted/55 px-3 py-2.5 text-xs"
                >
                  <dl className="space-y-1.5">
                    {Object.entries(preview).map(([key, value], index) => (
                      <div
                        key={key}
                        className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 leading-5"
                      >
                        <dt className="truncate text-muted-foreground">
                          {previewFieldLabel(key, index)}
                        </dt>
                        <dd className="min-w-0 break-words text-foreground">
                          <PreviewValue value={value} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}
            </div>
          ) : null}

          {showActions ? (
            <div className="space-y-1.5 px-2 pb-2.5 sm:px-3 sm:pb-3">
              <button
                type="button"
                onClick={() => handleUserActionResolve("approve")}
                disabled={busy || !requestId}
                className="group flex w-full items-center gap-3 rounded-xl bg-muted/70 px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-background text-[11px] text-muted-foreground">
                  1
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-[12.5px] leading-5 text-foreground">
                    {busy ? "处理中…" : "确认并继续"}
                  </span>
                  <span className="block text-[11px] leading-4 text-muted-foreground">
                    允许助手执行上面的操作。
                  </span>
                </span>
                <ArrowRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                  strokeWidth={1.5}
                />
              </button>
              <button
                type="button"
                onClick={() => handleUserActionResolve("deny")}
                disabled={busy || !requestId}
                className="group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-background text-[11px] text-muted-foreground">
                  2
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-[12.5px] leading-5 text-foreground">
                    {busy ? "处理中…" : "拒绝此操作"}
                  </span>
                  <span className="block text-[11px] leading-4 text-muted-foreground">
                    不执行这项操作，并返回当前任务。
                  </span>
                </span>
                <ArrowRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                  strokeWidth={1.5}
                />
              </button>
            </div>
          ) : null}

          {showActions && !requestId ? (
            <div
              role="alert"
              className="mx-4 mb-3 rounded-lg bg-muted px-3 py-2 text-xs text-foreground"
            >
              操作信息不完整，无法执行操作；请刷新会话后重试。
            </div>
          ) : null}

          {error && showActions ? (
            <div
              role="alert"
              className="mx-4 mb-3 flex items-center justify-between rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive"
            >
              <span>
                {error.title}：{error.description}
              </span>
              <button
                type="button"
                onClick={clearError}
                className="ml-2 flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-destructive/10"
                aria-label="关闭错误提示"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </div>
          ) : null}

          {isExpired && !resolvedResolution ? (
            <div className="mx-4 mb-3 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              请求已超时，未执行任何操作。
            </div>
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "w-full overflow-hidden rounded-2xl border shadow-[0_16px_40px_-32px_rgba(15,23,42,0.35)]",
          isDiffConfirmation
            ? isDiffResolved
              ? "border-success/25 bg-background"
              : "border-warning/30 bg-background"
            : statusColor,
        )}
      >
        <div className="flex items-center gap-3 px-[17px] py-[13px]">
          {/* 图标 */}
          <div
            className={cn(
              "flex size-[34px] shrink-0 items-center justify-center rounded-[10px]",
              isExpired && "bg-destructive/10 text-destructive",
              (resolvedResolution || isDiffResolved) && "bg-success/10 text-success",
              isRequestPending && !isExpired && !isDiffResolved && "bg-muted text-muted-foreground",
              !isRequestPending &&
                !isExpired &&
                !resolvedResolution &&
                "bg-muted-foreground/10 text-muted-foreground",
            )}
          >
            {resolvedResolution || isDiffResolved ? (
              <Check className="size-4" aria-hidden="true" />
            ) : isDiffConfirmation ? (
              <FilePenLine className="size-4" aria-hidden="true" />
            ) : isRequestPending ? (
              <CircleHelp className="size-4" aria-hidden="true" />
            ) : (
              <CircleAlert className="size-4" aria-hidden="true" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm text-foreground">{displayTitle}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{displayReason}</div>
            {content.target_tool && (
              <div className="mt-1 text-2xs text-foreground">
                目标工具：<span className="font-medium">{content.target_tool}</span>
              </div>
            )}
            {content.scope && (
              <div className="mt-1 text-2xs text-muted-foreground">
                授权范围：
                <span className="font-medium text-foreground">
                  {Array.isArray(content.scope) ? content.scope.join(", ") : content.scope}
                </span>
              </div>
            )}
            {content.impact && (
              <div className="mt-1 text-2xs text-muted-foreground">{content.impact}</div>
            )}
            {expiresLabel && isRequestPending && !isExpired && (
              <div className="mt-1 text-2xs text-muted-foreground">{expiresLabel}</div>
            )}
          </div>

          {/* 状态标签 */}
          {isDiffConfirmation ? (
            showActions ? (
              renderActions()
            ) : isDiffResolved ? (
              <button
                type="button"
                onClick={() => setDiffOpen((open) => !open)}
                className="shrink-0 rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                查看差异 ›
              </button>
            ) : (
              <span className={cn("rounded px-2 py-0.5 text-3xs", statusTagColor)}>
                {statusLabel}
              </span>
            )
          ) : (
            <span className={cn("rounded px-2 py-0.5 text-3xs", statusTagColor)}>
              {statusLabel}
            </span>
          )}
        </div>

        {preview && content.request_type === "confirmation" ? (
          <section
            aria-label="操作预览"
            className="mx-[17px] mb-3 rounded-[var(--radius-sm)] border border-border bg-background/60 px-3 py-2 text-2xs"
          >
            <h3 className="mb-1 font-medium text-foreground">操作预览</h3>
            <dl className="space-y-1">
              {Object.entries(preview).map(([key, value]) => (
                <div key={key} className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-3">
                  <dt className="max-w-36 truncate text-muted-foreground">{previewText(key)}</dt>
                  <dd className="min-w-0 break-words text-foreground">
                    <PreviewValue value={value} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {/* Authority 引用缺失：fail-closed，所有操作不可用，绝不 fallback 到 item.id */}
        {showActions && !requestId && (
          <div
            role="alert"
            className="mx-[17px] mb-3 flex items-center rounded-sm border border-warning/40 bg-warning/5 px-2 py-1.5 text-2xs text-warning"
          >
            操作信息不完整，无法执行操作；请刷新会话后重试。
          </div>
        )}

        {/* 解析错误提示 */}
        {error && showActions && (
          <div
            role="alert"
            className="mx-[17px] mb-3 flex items-center justify-between rounded-sm border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-2xs text-destructive"
          >
            <span>
              {error.title}：{error.description}
            </span>
            <button
              type="button"
              onClick={clearError}
              className="ml-2 shrink-0 rounded px-1.5 py-0.5 text-3xs hover:bg-destructive/10"
              aria-label="关闭错误提示"
            >
              ✕
            </button>
          </div>
        )}

        {/* 解析成功提示 */}
        {resolvedResolution && (
          <div className="mx-[17px] mb-3 rounded-[var(--radius-sm)] bg-success/10 px-2 py-1 text-2xs text-success">
            {getResolutionLabel(resolvedResolution)}
          </div>
        )}

        {/* 超时提示 */}
        {isExpired && !resolvedResolution && (
          <div className="mx-[17px] mb-3 rounded-[var(--radius-sm)] bg-destructive/10 px-2 py-1 text-2xs text-destructive">
            请求已超时，未执行任何操作。
          </div>
        )}

        {isDiffConfirmation && diffOpen && (
          <pre className="max-h-[260px] overflow-auto border-t border-border bg-muted/50 px-[18px] py-3 font-mono text-[11.5px] leading-[1.75] text-muted-foreground whitespace-pre-wrap">
            {content.diff}
          </pre>
        )}

        {isDiffConfirmation && content.target_path && (
          <button
            type="button"
            onClick={() => setDiffOpen((open) => !open)}
            className="flex w-full items-center justify-between border-t border-border px-[18px] py-[9px] text-left text-[13px] transition hover:bg-muted"
          >
            <span className="truncate text-foreground">{content.target_path}</span>
            <span className="ml-3 shrink-0">
              <span className="text-success">+{content.line_additions ?? 0}</span>{" "}
              <span className="text-destructive">-{content.line_deletions ?? 0}</span>
            </span>
          </button>
        )}

        {/* 操作按钮 */}
        {!isDiffConfirmation && <div className="px-4 pb-3.5">{renderActions()}</div>}
      </div>
    </div>
  );
}
