/**
 * A2A host_controls 合同。
 *
 * 外部 Agent 只能提交结构化提议；本模块把它收敛成 SnowHarness 可持久化的安全 DTO。
 * 不从文本猜动作，不接受客户端声明的 authorized，不携带内部 ID、凭证或企业权限。
 */
import { isSafeExternalUrl } from "@/lib/external/url-safety";

export const HOST_CONTROL_VERSION = "1" as const;
export const HOST_ACTION_TYPES = ["navigate", "open_external_link", "offer_human_support"] as const;
export type HostActionType = (typeof HOST_ACTION_TYPES)[number];

export interface HostControlCapabilityPolicy {
  confirmationActionKeys: string[];
  uiActionTypes: HostActionType[];
  uiActionTargetKeys: string[];
}

export interface ConfirmationProposal {
  proposal_id: string;
  action_key: string;
  title: string;
  summary: string;
  impact: string;
  preview: Record<string, unknown>;
}

export interface HostAction {
  action_id: string;
  action_type: HostActionType;
  title: string;
  label: string;
  description: string | null;
  target_key: string | null;
  url: string | null;
  /** 服务端解析后的目标；外部 Agent 不会看到该字段。 */
  web_path: string | null;
  client_support: { web: boolean; desktop: boolean };
}

export type ParsedHostControls =
  | { kind: "confirmation"; proposal: ConfirmationProposal }
  | { kind: "ui_actions"; actions: HostAction[] };

export const HOST_ACTION_TARGET_CATALOG: Readonly<
  Record<string, { webPath: string; desktop: boolean }>
> = Object.freeze({
  "thread.current": { webPath: "/threads", desktop: true },
  "settings.profile": { webPath: "/settings/profile", desktop: true },
});

export function defaultHostControlCapabilityPolicy(): HostControlCapabilityPolicy {
  return { confirmationActionKeys: [], uiActionTypes: [], uiActionTargetKeys: [] };
}

/** 从 AgentRevision 的接口要求读取 Host Control 能力；未声明即全拒绝。 */
export function parseHostControlCapabilityPolicy(raw: unknown): HostControlCapabilityPolicy {
  if (!isRecord(raw)) throw new HostControlProtocolError("agentInterfaceRequirements 必须是对象");
  const block = raw.host_controls;
  if (block === undefined) return defaultHostControlCapabilityPolicy();
  if (!isRecord(block)) throw new HostControlProtocolError("host_controls 必须是对象");
  const allowedKeys = new Set([
    "confirmation_action_keys",
    "ui_action_types",
    "ui_action_target_keys",
  ]);
  const unknown = Object.keys(block).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0)
    throw new HostControlProtocolError(`host_controls 含未知键：${unknown.join(",")}`);

  const confirmationActionKeys = readStringList(
    block.confirmation_action_keys,
    "confirmation_action_keys",
  );
  const rawTypes = readStringList(block.ui_action_types, "ui_action_types");
  const uiActionTypes = rawTypes.map((value) => {
    if (!(HOST_ACTION_TYPES as readonly string[]).includes(value)) {
      throw new HostControlProtocolError(`ui_action_types 含未知动作：${value}`);
    }
    return value as HostActionType;
  });
  const uiActionTargetKeys = readStringList(block.ui_action_target_keys, "ui_action_target_keys");
  for (const targetKey of uiActionTargetKeys) {
    if (!Object.hasOwn(HOST_ACTION_TARGET_CATALOG, targetKey)) {
      throw new HostControlProtocolError(`ui_action_target_keys 含未知目标：${targetKey}`);
    }
  }
  return { confirmationActionKeys, uiActionTypes, uiActionTargetKeys };
}

/** 严格解析 A2A DataPart 中的 host_controls；非法协议直接抛 protocol_schema。 */
export function parseHostControls(
  data: unknown,
  stage: "input-required" | "completed",
  policy: HostControlCapabilityPolicy = defaultHostControlCapabilityPolicy(),
): ParsedHostControls | null {
  if (!isRecord(data) || data.host_controls === undefined) return null;
  const controls = data.host_controls;
  if (!isRecord(controls)) throw new HostControlProtocolError("host_controls 必须是对象");
  const unknown = Object.keys(controls).filter(
    (key) => key !== "version" && key !== "confirmation" && key !== "ui_actions",
  );
  if (unknown.length > 0)
    throw new HostControlProtocolError(`host_controls 含未知键：${unknown.join(",")}`);
  if (controls.version !== HOST_CONTROL_VERSION) {
    throw new HostControlProtocolError("host_controls.version 不受支持");
  }
  if (stage === "input-required") {
    if (controls.ui_actions !== undefined) {
      throw new HostControlProtocolError("input-required 不允许 ui_actions");
    }
    if (controls.confirmation === undefined) {
      throw new HostControlProtocolError("input-required host_controls 必须包含 confirmation");
    }
    if (!policy.confirmationActionKeys.length) {
      throw new HostControlProtocolError("当前 Agent Revision 未声明 confirmation 能力");
    }
    const proposal = parseConfirmationProposal(controls.confirmation);
    if (!policy.confirmationActionKeys.includes(proposal.action_key)) {
      throw new HostControlProtocolError("confirmation action_key 未被当前 Agent Revision 允许");
    }
    return { kind: "confirmation", proposal };
  }

  if (controls.confirmation !== undefined) {
    throw new HostControlProtocolError("completed 不允许 confirmation");
  }
  if (controls.ui_actions === undefined) {
    throw new HostControlProtocolError("completed host_controls 必须包含 ui_actions");
  }
  if (!policy.uiActionTypes.length) {
    throw new HostControlProtocolError("当前 Agent Revision 未声明 ui_actions 能力");
  }
  if (
    !Array.isArray(controls.ui_actions) ||
    controls.ui_actions.length < 1 ||
    controls.ui_actions.length > 3
  ) {
    throw new HostControlProtocolError("ui_actions 数量必须为 1-3");
  }
  const actions = controls.ui_actions.map((value) => parseHostAction(value, policy));
  const ids = new Set(actions.map((action) => action.action_id));
  if (ids.size !== actions.length)
    throw new HostControlProtocolError("ui_actions.action_id 不得重复");
  return { kind: "ui_actions", actions };
}

export class HostControlProtocolError extends Error {
  readonly code = "host_control_protocol_invalid";

  constructor(message: string) {
    super(message);
    this.name = "HostControlProtocolError";
  }
}

function parseConfirmationProposal(value: unknown): ConfirmationProposal {
  if (!isRecord(value)) throw new HostControlProtocolError("confirmation 必须是对象");
  assertExactKeys(value, ["proposal_id", "action_key", "title", "summary", "impact", "preview"]);
  const proposalId = boundedString(value.proposal_id, "proposal_id", 128);
  const actionKey = boundedString(value.action_key, "action_key", 128);
  if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(actionKey)) {
    throw new HostControlProtocolError("confirmation.action_key 格式非法");
  }
  const preview = value.preview;
  if (!isRecord(preview) || Object.keys(preview).length > 8) {
    throw new HostControlProtocolError("confirmation.preview 必须是最多 8 个字段的对象");
  }
  assertSafePreview(preview);
  return {
    proposal_id: proposalId,
    action_key: actionKey,
    title: boundedString(value.title, "title", 200),
    summary: boundedString(value.summary, "summary", 2_000),
    impact: boundedString(value.impact, "impact", 2_000),
    preview,
  };
}

function parseHostAction(value: unknown, policy: HostControlCapabilityPolicy): HostAction {
  if (!isRecord(value)) throw new HostControlProtocolError("ui_action 必须是对象");
  assertExactKeys(value, [
    "action_id",
    "action_type",
    "title",
    "label",
    "description",
    "target_key",
    "url",
  ]);
  const actionType = value.action_type;
  if (!(HOST_ACTION_TYPES as readonly string[]).includes(String(actionType))) {
    throw new HostControlProtocolError("ui_action.action_type 不受支持");
  }
  const typedAction = actionType as HostActionType;
  if (!policy.uiActionTypes.includes(typedAction)) {
    throw new HostControlProtocolError("ui_action 类型未被当前 Agent Revision 允许");
  }
  const actionId = boundedString(value.action_id, "action_id", 128);
  const title = boundedString(value.title, "title", 200);
  const label = boundedString(value.label, "label", 120);
  const description =
    value.description === undefined || value.description === null
      ? null
      : boundedString(value.description, "description", 1_000);
  const targetKey =
    value.target_key === undefined || value.target_key === null
      ? null
      : boundedString(value.target_key, "target_key", 128);
  const url =
    value.url === undefined || value.url === null ? null : boundedString(value.url, "url", 2_048);

  if (typedAction === "navigate") {
    if (!targetKey || url !== null || !policy.uiActionTargetKeys.includes(targetKey)) {
      throw new HostControlProtocolError("navigate 必须使用当前 Agent 允许的 target_key");
    }
    const target = HOST_ACTION_TARGET_CATALOG[targetKey];
    if (!target) throw new HostControlProtocolError("navigate target_key 未登记");
    return {
      action_id: actionId,
      action_type: typedAction,
      title,
      label,
      description,
      target_key: targetKey,
      url: null,
      web_path: target.webPath,
      client_support: { web: true, desktop: target.desktop },
    };
  }
  if (typedAction === "open_external_link") {
    if (
      targetKey !== null ||
      !url ||
      !isSafeExternalUrl(url) ||
      !isHttpsUrl(url) ||
      hasCredentials(url)
    ) {
      throw new HostControlProtocolError("open_external_link.url 不符合 HTTPS 外链安全策略");
    }
    return {
      action_id: actionId,
      action_type: typedAction,
      title,
      label,
      description,
      target_key: null,
      url,
      web_path: null,
      client_support: { web: true, desktop: true },
    };
  }
  if (targetKey !== null || url !== null) {
    throw new HostControlProtocolError("offer_human_support 不允许携带 target 或 url");
  }
  return {
    action_id: actionId,
    action_type: typedAction,
    title,
    label,
    description,
    target_key: null,
    url: null,
    web_path: null,
    client_support: { web: true, desktop: true },
  };
}

function readStringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new HostControlProtocolError(`${name} 必须是最多 64 项的字符串数组`);
  }
  const values = value.map((item) => (item as string).trim());
  if (values.some((item) => item.length === 0 || item.length > 128)) {
    throw new HostControlProtocolError(`${name} 含空值或过长值`);
  }
  if (new Set(values).size !== values.length)
    throw new HostControlProtocolError(`${name} 不得重复`);
  return values;
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new HostControlProtocolError(`${name} 必须是非空且不超过 ${max} 字符的字符串`);
  }
  if (hasSecretLikeText(value)) throw new HostControlProtocolError(`${name} 含禁止的敏感内容`);
  return value.trim();
}

function assertSafePreview(value: Record<string, unknown>): void {
  const serialized = JSON.stringify(value);
  if (
    serialized.length > 8_000 ||
    hasSecretLikeText(serialized) ||
    Object.keys(value).some((key) => hasForbiddenPreviewKey(key))
  ) {
    throw new HostControlProtocolError("confirmation.preview 含敏感内容或超过大小限制");
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Array.isArray(child))
      assertSafePreview(child as Record<string, unknown>);
  }
}

function hasForbiddenPreviewKey(value: string): boolean {
  return /(?:permission|data[_-]?scope|token|secret|password|credential|user[_-]?id|tenant[_-]?id|invocation[_-]?id|internal[_-]?id)/i.test(
    value,
  );
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new HostControlProtocolError(`结构含未知键：${unknown.join(",")}`);
}

function hasSecretLikeText(value: string): boolean {
  return /(?:bearer\s+|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|private[_-]?key|tenant[_-]?id|invocation[_-]?id|user[_-]?id)/i.test(
    value,
  );
}

function hasCredentials(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return true;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
