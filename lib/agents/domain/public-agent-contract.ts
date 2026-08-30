/**
 * Public Agent Contract 领域模型：管理员登记时提供的 agent-contract.json 的严格解析与规范化。
 *
 * 关键不变量：
 * - 合同文件是 request-only 输入：解析结果只包含显式结构化事实（identity / capabilities /
 *   invocation contexts / interaction / result contract），绝不保留原始合同对象或整节 JSON。
 * - fail-closed：每个对象层级都有明确的 allowed-key 集合，未知键（含 secrets / URL / Tool 化
 *   字段）一律拒绝；interaction 六个布尔必须显式给出（false 合法，遗漏非法，不得默认补值）。
 * - digest 为 sha256: 前缀的稳定 canonical digest（递归 sortKeys；数组序即合同序）。
 * - protocol 事实不属于合同文件：由登记命令显式提供，本模块不解析、不默认。
 *
 * 事实源：Public Agent Contract 冻结目标模型（本切片）。
 */
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";

// ─── 语义枚举 ─────────────────────────────────────────────

/** 调用上下文必要性。 */
export const CONTEXT_NECESSITIES = ["required", "preferred", "accepted"] as const;
export type ContextNecessity = (typeof CONTEXT_NECESSITIES)[number];

/** 合同声明来源。 */
export const PROVENANCE_SOURCES = ["provider_declared", "operator_declared"] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

/** 运行时按冻结快照重建的调用上下文合同。 */
export interface InvocationContextContract {
  contexts: Array<{
    contextKind: string;
    necessity: ContextNecessity;
    purpose?: string;
    provenance?: ProvenanceSource;
  }>;
}

// ─── 错误 ─────────────────────────────────────────────────

export class PublicAgentContractError extends Error {
  constructor(message: string) {
    super(`Public Agent Contract 无效：${message}`);
    this.name = "PublicAgentContractError";
  }
}

// ─── 规范化模型（结构化事实，无原始合同保留）──────────────

export interface PublicAgentIdentity {
  id: string;
  version: string;
  nameZhCn: string;
  nameEn: string | null;
}

export interface PublicAgentCapability {
  key: string;
  nameZhCn: string;
  nameEn: string | null;
  descriptionZhCn: string | null;
  descriptionEn: string | null;
  tags: string[];
  examples: string[];
  inputModes: string[];
  outputModes: string[];
}

export interface PublicAgentInvocationContext {
  key: string;
  nameZhCn: string;
  nameEn: string | null;
  descriptionZhCn: string | null;
  descriptionEn: string | null;
  necessity: ContextNecessity;
  appliesTo: string[] | null;
  trustRequirement: string | null;
  /** wire 上可缺席（解析结果为 null）；持久化层另行赋系统 provenance。 */
  declarationSource: ProvenanceSource | null;
}

export interface PublicAgentInteraction {
  streamingTransport: boolean;
  incrementalContent: boolean;
  inputRequired: boolean;
  resume: boolean;
  cancel: boolean;
  durableTaskRecovery: boolean;
  supportedLocales: string[];
}

export interface PublicAgentContractFacts {
  contractVersion: string;
  agent: PublicAgentIdentity;
  capabilities: PublicAgentCapability[];
  invocationContexts: PublicAgentInvocationContext[];
  interaction: PublicAgentInteraction;
  resultFields: string[];
  errorCodes: string[];
  resultNotesZhCn: string | null;
  resultNotesEn: string | null;
  contractDigest: string;
  capabilityDigest: string;
  contextDigest: string;
}

// ─── allowed-key 集合（fail-closed：未知键一律拒绝）────────

const TOP_LEVEL_KEYS = [
  "contract_version",
  "agent",
  "capabilities",
  "invocation_context",
  "interaction",
  "result_contract",
] as const;

const AGENT_KEYS = ["id", "name", "version"] as const;
const LOCALIZED_KEYS = ["zh-CN", "en"] as const;
const CAPABILITY_KEYS = [
  "key",
  "name",
  "description",
  "tags",
  "examples",
  "input_modes",
  "output_modes",
] as const;
const CONTEXT_KEYS = [
  "key",
  "name",
  "necessity",
  "description",
  "applies_to",
  "trust_requirement",
  "declaration_source",
] as const;
const INTERACTION_KEYS = [
  "streaming_transport",
  "incremental_content",
  "input_required",
  "resume",
  "cancel",
  "durable_task_recovery",
  "supported_locales",
] as const;
const RESULT_CONTRACT_KEYS = ["fields", "error_codes", "notes"] as const;

const INTERACTION_FLAGS = [
  "streaming_transport",
  "incremental_content",
  "input_required",
  "resume",
  "cancel",
  "durable_task_recovery",
] as const;

/** locale 形态：language(-Script)?(-Region)?（下划线等非法形态拒绝）。 */
const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/i;

// ─── 基础校验工具 ─────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new PublicAgentContractError(`${where} 含未知键：${extra.join(", ")}`);
  }
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new PublicAgentContractError(`${where} 必须是对象`);
  }
  return value;
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PublicAgentContractError(`${where} 必须是非空字符串`);
  }
  return value;
}

/** 可选本地化文本：缺失/null/空串规范化为 null。 */
function optionalLocalizedText(
  holder: Record<string, unknown>,
  locale: string,
  where: string,
): string | null {
  if (!(locale in holder)) return null;
  const value = holder[locale];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new PublicAgentContractError(`${where}.${locale} 必须是字符串`);
  }
  return value.trim() === "" ? null : value;
}

function requiredLocalizedText(
  holder: Record<string, unknown>,
  locale: string,
  where: string,
): string {
  const value = optionalLocalizedText(holder, locale, where);
  if (value === null) {
    throw new PublicAgentContractError(`${where}.${locale} 不能为空`);
  }
  return value;
}

/** 本地化对象（zh-CN 必需，en 可选）。 */
function localizedObject(value: unknown, where: string): { zhCn: string; en: string | null } {
  if (!isPlainObject(value)) {
    throw new PublicAgentContractError(`${where} 必须是本地化对象`);
  }
  assertAllowedKeys(value, LOCALIZED_KEYS, where);
  return {
    zhCn: requiredLocalizedText(value, "zh-CN", where),
    en: optionalLocalizedText(value, "en", where),
  };
}

/** 可选本地化对象：缺失/null 规范化为全 null；en 可整体缺席。 */
function optionalLocalizedObject(
  value: unknown,
  where: string,
): { zhCn: string | null; en: string | null } {
  if (value === undefined || value === null) return { zhCn: null, en: null };
  if (!isPlainObject(value)) {
    throw new PublicAgentContractError(`${where} 必须是本地化对象`);
  }
  assertAllowedKeys(value, LOCALIZED_KEYS, where);
  return {
    zhCn: optionalLocalizedText(value, "zh-CN", where),
    en: optionalLocalizedText(value, "en", where),
  };
}

/** 可选字符串数组：缺失/null 规范化为空数组；元素必须非空字符串且不得重复。 */
function optionalStringArray(
  value: unknown,
  where: string,
  { unique = false }: { unique?: boolean } = {},
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PublicAgentContractError(`${where} 必须是字符串数组`);
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    const s = requiredString(item, `${where} 元素`);
    if (unique && seen.has(s)) {
      throw new PublicAgentContractError(`${where} 重复：${s}`);
    }
    seen.add(s);
    items.push(s);
  }
  return items;
}

function assertLocale(locale: string, where: string): void {
  if (!LOCALE_PATTERN.test(locale)) {
    throw new PublicAgentContractError(`${where} 非法 locale: ${locale}`);
  }
}

function assertNecessity(value: unknown, where: string): ContextNecessity {
  if (typeof value !== "string" || !(CONTEXT_NECESSITIES as readonly string[]).includes(value)) {
    throw new PublicAgentContractError(
      `${where} necessity 非法: ${String(value)}（必须 required|preferred|accepted）`,
    );
  }
  return value as ContextNecessity;
}

function assertDeclarationSource(value: unknown, where: string): ProvenanceSource {
  if (typeof value !== "string" || !(PROVENANCE_SOURCES as readonly string[]).includes(value)) {
    throw new PublicAgentContractError(
      `${where} declaration_source 非法: ${String(value)}（必须 provider_declared|operator_declared）`,
    );
  }
  return value as ProvenanceSource;
}

// ─── digest ───────────────────────────────────────────────

function digestOf(value: unknown): string {
  return computeCanonicalDigest(value);
}

/** 合同 digest 载荷：结构化事实本身（不含 digest 字段）。 */
function contractDigestPayload(
  facts: Omit<PublicAgentContractFacts, "contractDigest" | "capabilityDigest" | "contextDigest">,
): unknown {
  return {
    contractVersion: facts.contractVersion,
    agent: facts.agent,
    capabilities: facts.capabilities,
    invocationContexts: facts.invocationContexts,
    interaction: facts.interaction,
    resultFields: facts.resultFields,
    errorCodes: facts.errorCodes,
    resultNotesZhCn: facts.resultNotesZhCn,
    resultNotesEn: facts.resultNotesEn,
  };
}

/** 对已解析的合同事实计算稳定 contract digest（对象键序无关，数组序即合同序）。 */
export function computePublicAgentContractDigest(
  facts: Omit<PublicAgentContractFacts, "contractDigest" | "capabilityDigest" | "contextDigest">,
): string {
  return digestOf(contractDigestPayload(facts));
}

// ─── 解析 ─────────────────────────────────────────────────

function parseInteraction(value: unknown): PublicAgentInteraction {
  const interaction = requireObject(value, "interaction");
  assertAllowedKeys(interaction, INTERACTION_KEYS, "interaction");
  const flags = new Map<string, boolean>();
  for (const flag of INTERACTION_FLAGS) {
    const v = interaction[flag];
    if (typeof v !== "boolean") {
      throw new PublicAgentContractError(
        `interaction.${flag} 必须显式提供 boolean（false 合法，遗漏/null/非布尔非法）`,
      );
    }
    flags.set(flag, v);
  }
  const flagOf = (flag: string): boolean => {
    const v = flags.get(flag);
    if (v === undefined) {
      throw new PublicAgentContractError(`interaction.${flag} 必须显式提供 boolean`);
    }
    return v;
  };
  const locales = optionalStringArray(
    interaction.supported_locales,
    "interaction.supported_locales",
    { unique: true },
  );
  if (locales.length === 0) {
    throw new PublicAgentContractError("interaction.supported_locales 不能为空");
  }
  for (const locale of locales) assertLocale(locale, "interaction.supported_locales");
  // 语义校验：incremental_content 依赖流式传输；非流式合同不得声明内容增量。
  if (flagOf("incremental_content") && !flagOf("streaming_transport")) {
    throw new PublicAgentContractError(
      "interaction.incremental_content=true 要求 streaming_transport=true",
    );
  }
  // 05 专项（P2-2）：input-required 产品模型只能 Resume 原 Invocation（无"新 Task 继续"
  // 的第二模式），因此 input_required=true 必须依赖 resume=true —— 在合同登记阶段拒绝。
  if (flagOf("input_required") && !flagOf("resume")) {
    throw new PublicAgentContractError(
      "interaction.input_required=true 要求 interaction.resume=true",
    );
  }
  return {
    streamingTransport: flagOf("streaming_transport"),
    incrementalContent: flagOf("incremental_content"),
    inputRequired: flagOf("input_required"),
    resume: flagOf("resume"),
    cancel: flagOf("cancel"),
    durableTaskRecovery: flagOf("durable_task_recovery"),
    supportedLocales: locales,
  };
}

function parseCapabilities(value: unknown): PublicAgentCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PublicAgentContractError("capabilities 必须是非空数组");
  }
  const seen = new Set<string>();
  const capabilities: PublicAgentCapability[] = value.map((raw, i) => {
    const c = requireObject(raw, `capabilities[${i}]`);
    assertAllowedKeys(c, CAPABILITY_KEYS, `capabilities[${i}]`);
    const key = requiredString(c.key, `capabilities[${i}].key`);
    if (seen.has(key)) {
      throw new PublicAgentContractError(`capability key 重复：${key}`);
    }
    seen.add(key);
    const name = localizedObject(c.name, `capabilities[${i}].name`);
    const description = optionalLocalizedObject(c.description, `capabilities[${i}].description`);
    return {
      key,
      nameZhCn: name.zhCn,
      nameEn: name.en,
      descriptionZhCn: description.zhCn,
      descriptionEn: description.en,
      tags: optionalStringArray(c.tags, `capabilities[${i}].tags`),
      examples: optionalStringArray(c.examples, `capabilities[${i}].examples`),
      inputModes: optionalStringArray(c.input_modes, `capabilities[${i}].input_modes`),
      outputModes: optionalStringArray(c.output_modes, `capabilities[${i}].output_modes`),
    };
  });
  return capabilities;
}

function parseInvocationContexts(value: unknown): PublicAgentInvocationContext[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PublicAgentContractError("invocation_context 必须是非空数组");
  }
  const seen = new Set<string>();
  const contexts: PublicAgentInvocationContext[] = value.map((raw, i) => {
    const c = requireObject(raw, `invocation_context[${i}]`);
    assertAllowedKeys(c, CONTEXT_KEYS, `invocation_context[${i}]`);
    const key = requiredString(c.key, `invocation_context[${i}].key`);
    if (seen.has(key)) {
      throw new PublicAgentContractError(`invocation_context key 重复：${key}`);
    }
    seen.add(key);
    const name = localizedObject(c.name, `invocation_context[${i}].name`);
    const description = optionalLocalizedObject(
      c.description,
      `invocation_context[${i}].description`,
    );
    const necessity = assertNecessity(c.necessity, `invocation_context[${i}]`);
    const appliesTo = optionalStringArray(c.applies_to, `invocation_context[${i}].applies_to`);
    const trustRequirement =
      c.trust_requirement === undefined || c.trust_requirement === null
        ? null
        : requiredString(c.trust_requirement, `invocation_context[${i}].trust_requirement`);
    const declarationSource =
      c.declaration_source === undefined || c.declaration_source === null
        ? null
        : assertDeclarationSource(c.declaration_source, `invocation_context[${i}]`);
    return {
      key,
      nameZhCn: name.zhCn,
      nameEn: name.en,
      descriptionZhCn: description.zhCn,
      descriptionEn: description.en,
      necessity,
      appliesTo: appliesTo.length > 0 ? appliesTo : null,
      trustRequirement,
      declarationSource,
    };
  });
  return contexts;
}

function parseResultContract(value: unknown): {
  resultFields: string[];
  errorCodes: string[];
  resultNotesZhCn: string | null;
  resultNotesEn: string | null;
} {
  const rc = requireObject(value, "result_contract");
  assertAllowedKeys(rc, RESULT_CONTRACT_KEYS, "result_contract");
  const resultFields = optionalStringArray(rc.fields, "result_contract.fields", { unique: true });
  if (resultFields.length === 0) {
    throw new PublicAgentContractError("result_contract.fields 不能为空");
  }
  const errorCodes = optionalStringArray(rc.error_codes, "result_contract.error_codes", {
    unique: true,
  });
  if (errorCodes.length === 0) {
    throw new PublicAgentContractError("result_contract.error_codes 不能为空");
  }
  const notes = optionalLocalizedObject(rc.notes, "result_contract.notes");
  return {
    resultFields,
    errorCodes,
    resultNotesZhCn: notes.zhCn,
    resultNotesEn: notes.en,
  };
}

/**
 * parsePublicAgentContract：严格解析 agent-contract.json 为结构化事实并计算稳定 digest。
 * 不保留原始合同对象；任何未知键/缺失必填事实/非法值均 fail-closed 拒绝。
 */
export function parsePublicAgentContract(input: unknown): PublicAgentContractFacts {
  const root = requireObject(input, "合同根对象");
  assertAllowedKeys(root, TOP_LEVEL_KEYS, "合同根对象");

  const contractVersion = requiredString(root.contract_version, "contract_version");

  const agentRaw = requireObject(root.agent, "agent");
  assertAllowedKeys(agentRaw, AGENT_KEYS, "agent");
  const agentName = localizedObject(agentRaw.name, "agent.name");
  const agent: PublicAgentIdentity = {
    id: requiredString(agentRaw.id, "agent.id"),
    version: requiredString(agentRaw.version, "agent.version"),
    nameZhCn: agentName.zhCn,
    nameEn: agentName.en,
  };

  const capabilities = parseCapabilities(root.capabilities);
  const invocationContexts = parseInvocationContexts(root.invocation_context);
  // applies_to 引用的必须是已声明 capability
  const capabilityKeys = new Set(capabilities.map((c) => c.key));
  for (const ctx of invocationContexts) {
    for (const ref of ctx.appliesTo ?? []) {
      if (!capabilityKeys.has(ref)) {
        throw new PublicAgentContractError(
          `invocation_context ${ctx.key} applies_to 引用未声明 capability：${ref}`,
        );
      }
    }
  }
  const interaction = parseInteraction(root.interaction);
  const result = parseResultContract(root.result_contract);

  const base = {
    contractVersion,
    agent,
    capabilities,
    invocationContexts,
    interaction,
    ...result,
  };
  return {
    ...base,
    contractDigest: digestOf(contractDigestPayload(base)),
    capabilityDigest: digestOf(capabilities),
    contextDigest: digestOf(invocationContexts),
  };
}
