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
import { Check, CircleAlert, FilePenLine } from "lucide-react";
import { useMemo, useState } from "react";

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
      label: (def.title as string | undefined) ?? defaultFieldLabel(key, fieldIndex),
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

  // input 类型的字段（schema 缺失/空/不支持/非法 pattern → ok=false，fail-closed）
  const inputSchema = useMemo(
    () => extractInputFields(content.input_schema),
    [content.input_schema],
  );
  const inputFields = inputSchema.fields;
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [diffOpen, setDiffOpen] = useState(false);

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

  const handleInputSubmit = () => {
    if (busy || !showActions || !requestId || !inputFormValid) return;
    // 把表单值转换为对应类型（字符串 trim）；可选字段留空 → 省略该键
    const response: Record<string, unknown> = {};
    for (const field of inputFields) {
      const normalized = normalizeFieldValue(field, inputValues[field.key] ?? "");
      if (normalized.ok && !normalized.omit) response[field.key] = normalized.value;
    }
    handleUserActionResolve("submit", { responseRedactedJson: response });
  };

  // 状态标签
  const statusLabel = isExpired
    ? "已超时"
    : resolvedResolution
      ? getResolutionLabel(resolvedResolution)
      : isRequestPending
        ? "待处理"
        : item.item_state === "completed"
          ? "已完成"
          : item.item_state === "failed"
            ? "失败"
            : "待处理";

  const statusColor = isExpired
    ? "border-destructive/30 bg-destructive/5"
    : resolvedResolution
      ? "border-success/25 bg-success/5"
      : isRequestPending
        ? "border-warning/30 bg-warning/5"
        : "border-border bg-muted/40";

  const statusTagColor = isExpired
    ? "bg-destructive/10 text-destructive"
    : resolvedResolution
      ? "bg-success/10 text-success"
      : isRequestPending
        ? "bg-[var(--warning)]/10 text-warning"
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

      case "input": {
        // input 类型：渲染简单表单 + submit/cancel 按钮
        return (
          <div className="mt-3 space-y-2">
            {!inputSchema.ok ? (
              <div className="text-2xs text-warning" role="alert">
                请求的输入定义不可用，无法提交；请刷新会话后重试。
              </div>
            ) : inputFields.length > 0 ? (
              <div className="space-y-2">
                {inputFields.map((field) => (
                  <div key={field.key} className="space-y-0.5">
                    <label
                      htmlFor={`ua-input-${item.id}-${field.key}`}
                      className="text-2xs text-muted-foreground"
                    >
                      {field.label}
                      {field.required ? "*" : ""}
                    </label>
                    {field.enum ? (
                      <select
                        id={`ua-input-${item.id}-${field.key}`}
                        value={inputValues[field.key] ?? ""}
                        onChange={(e) => handleInputChange(field.key, e.target.value)}
                        disabled={busy || !requestId}
                        className="w-full rounded-[var(--radius-sm)] border border-border bg-card px-2 py-1 text-xs text-foreground disabled:opacity-40"
                      >
                        <option value="">请选择…</option>
                        {field.enum.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : field.type === "boolean" ? (
                      // boolean 必须显式选择是/否（提交实际布尔值），不允许自由文本。
                      <select
                        id={`ua-input-${item.id}-${field.key}`}
                        value={inputValues[field.key] ?? ""}
                        onChange={(e) => handleInputChange(field.key, e.target.value)}
                        disabled={busy || !requestId}
                        className="w-full rounded-[var(--radius-sm)] border border-border bg-card px-2 py-1 text-xs text-foreground disabled:opacity-40"
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
                        onChange={(e) => handleInputChange(field.key, e.target.value)}
                        disabled={busy || !requestId}
                        placeholder={field.description ?? ""}
                        className="w-full rounded-[var(--radius-sm)] border border-border bg-card px-2 py-1 text-xs text-foreground disabled:opacity-40"
                      />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-2xs text-muted-foreground">
                请求未提供输入字段定义，可直接提交或取消。
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleInputSubmit}
                disabled={busy || !requestId || !inputFormValid}
                className="flex-1 rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-xs transition hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "处理中…" : isAgentInputRequired ? "继续同一任务" : "提交"}
              </button>
              <button
                type="button"
                onClick={() => handleUserActionResolve("cancel")}
                disabled={busy || !requestId}
                className="flex-1 rounded-md border border-border px-3 py-1.5 text-muted-foreground text-xs transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "处理中…" : "取消"}
              </button>
            </div>
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "w-full overflow-hidden rounded-[15px] border",
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
              isRequestPending &&
                !isExpired &&
                !isDiffResolved &&
                (isDiffConfirmation
                  ? "bg-muted text-foreground"
                  : "bg-[var(--warning)]/10 text-warning"),
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
              <div className="mt-1 text-2xs text-warning">影响：{content.impact}</div>
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
