/**
 * V11 错误码 → 员工可理解语义映射。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform/contracts/error-codes.json（normative）
 * - lib/v11/error-codes.ts（运行时投影，仅含 {http, retryable}）
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md
 *   S10-W01：「错误展示使用错误目录中的中文语义和可恢复动作，不把内部堆栈直接暴露给员工」
 *
 * 职责：
 * - 本模块只负责「码 → 中文 + 可恢复动作」的映射，不改变 contract_version 管控的 error-codes.json。
 * - 未知错误码 fall through 到 GENERIC_UNKNOWN，保证员工始终看到可读语义而非堆栈。
 * - 不在客户端注入服务端 message；中文 title/description 由本表给出，避免被服务端任意文本覆盖。
 */
import type { V11ClientErrorBody, V11ClientVisibleError } from "./types";

/** 错误映射条目。 */
interface ErrorMapping {
  readonly title: string;
  readonly description: string;
  readonly recoveryAction: V11ClientVisibleError["recoveryAction"];
}

const GENERIC_UNKNOWN: ErrorMapping = {
  title: "操作未完成",
  description: "系统暂时无法完成该请求，请稍后重试。若持续出现，请联系管理员。",
  recoveryAction: "reload_page",
};

/**
 * 员工端关心的错误码中文映射。
 *
 * 只列出员工端可能触达的码；服务端内部码（如 ARTIFACT_ATTESTATION_FAILED）
 * 不会通过 Employee API 冒泡到员工端，由系统层处理。
 */
const ERROR_MAPPINGS: Readonly<Record<string, ErrorMapping>> = {
  // ─── 鉴权与权限 ───────────────────────────────────────────
  AUTHENTICATION_REQUIRED: {
    title: "登录已失效",
    description: "请重新登录后再试。",
    recoveryAction: "reload_page",
  },
  ACCESS_DENIED: {
    title: "没有访问权限",
    description: "当前账号无法访问该资源。若认为有误，请联系管理员。",
    recoveryAction: "contact_admin",
  },
  ACTION_SCOPE_DENIED: {
    title: "操作未授权",
    description: "当前会话无权执行此操作，请联系管理员调整权限范围。",
    recoveryAction: "contact_admin",
  },
  POLICY_BLOCKED: {
    title: "策略已拦截",
    description: "当前操作被公司策略阻止。若有疑问，请联系管理员。",
    recoveryAction: "contact_admin",
  },
  RESOURCE_NOT_FOUND: {
    title: "内容不存在",
    description: "该会话或资源不存在，或已被删除。",
    recoveryAction: "reload_page",
  },

  // ─── 会话与事件流 ─────────────────────────────────────────
  EVENT_CURSOR_EXPIRED: {
    title: "会话已过期",
    description: "离线时间较长，正在为你重新加载最新会话内容。",
    recoveryAction: "resnapshot",
  },
  EVENT_SEQUENCE_GAP: {
    title: "同步出现空缺",
    description: "事件顺序不连续，正在为你重新加载会话。",
    recoveryAction: "resnapshot",
  },
  EVENT_SCHEMA_UNSUPPORTED: {
    title: "客户端版本过旧",
    description: "服务端事件格式已升级，请刷新页面获取最新版本。",
    recoveryAction: "reload_page",
  },
  STREAM_BACKPRESSURE: {
    title: "网络较慢",
    description: "数据量较大，正在重新建立连接。",
    recoveryAction: "reconnect",
  },

  // ─── Turn 与并发 ──────────────────────────────────────────
  TURN_ALREADY_TERMINAL: {
    title: "任务已结束",
    description: "该任务已完成或被停止，无法再进行此操作。",
    recoveryAction: "reload_page",
  },
  TURN_REQUIRES_USER_ACTION: {
    title: "需要你的确认",
    description: "任务正在等待你的操作，请处理后再试。",
    recoveryAction: "none",
  },
  IDEMPOTENCY_CONFLICT: {
    title: "请求已提交",
    description: "相同请求已处理，请勿重复提交。",
    recoveryAction: "none",
  },
  ETAG_MISMATCH: {
    title: "数据已被更新",
    description: "内容已被其他窗口或设备修改，请刷新后再试。",
    recoveryAction: "reload_page",
  },

  // ─── 网络与限流 ───────────────────────────────────────────
  RATE_LIMITED: {
    title: "请求过于频繁",
    description: "操作太快，请稍等片刻再试。",
    recoveryAction: "reconnect",
  },
  RUNTIME_UNAVAILABLE: {
    title: "Agent 暂时不可用",
    description: "执行环境暂时无法连接，请稍后重试。",
    recoveryAction: "reconnect",
  },

  // ─── 输入与容量 ───────────────────────────────────────────
  REQUEST_SCHEMA_INVALID: {
    title: "输入无效",
    description: "请检查输入内容后再试。",
    recoveryAction: "none",
  },
  CONTEXT_CHECKPOINT_TOO_LARGE: {
    title: "上下文过大",
    description: "当前会话内容过大，建议开启新会话。",
    recoveryAction: "contact_admin",
  },
  CHILD_BUDGET_EXCEEDED: {
    title: "子任务预算已用完",
    description: "子任务使用的资源已达上限。",
    recoveryAction: "contact_admin",
  },
  SHARED_BUDGET_EXHAUSTED: {
    title: "共享预算已用完",
    description: "本月可用资源已达上限，请联系管理员调整。",
    recoveryAction: "contact_admin",
  },
};

/**
 * 把服务端错误 Envelope 映射为员工可理解的 V11ClientVisibleError。
 *
 * - code 在映射表中 → 使用映射的中文 title/description + recoveryAction。
 * - code 未列出 → 使用 GENERIC_UNKNOWN，避免泄露内部细节。
 * - retryable 直接采用服务端 envelope 字段（与契约保持一致）。
 * - requestId 保留用于诊断，但不直接展示给员工。
 */
export function toVisibleError(body: V11ClientErrorBody): V11ClientVisibleError {
  const code = body.error.code;
  const mapping = ERROR_MAPPINGS[code] ?? GENERIC_UNKNOWN;
  return {
    code,
    title: mapping.title,
    description: mapping.description,
    retryable: body.error.retryable,
    recoveryAction: mapping.recoveryAction,
    requestId: body.error.request_id ?? null,
  };
}

/** 创建一个本地构造的可见错误（不经过服务端 envelope）。 */
export function makeLocalVisibleError(input: {
  readonly code: string;
  readonly retryable?: boolean;
  readonly requestId?: string | null;
}): V11ClientVisibleError {
  const mapping = ERROR_MAPPINGS[input.code] ?? GENERIC_UNKNOWN;
  return {
    code: input.code,
    title: mapping.title,
    description: mapping.description,
    retryable: input.retryable ?? false,
    recoveryAction: mapping.recoveryAction,
    requestId: input.requestId ?? null,
  };
}
