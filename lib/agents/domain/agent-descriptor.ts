/**
 * Agent Descriptor 领域模型：Agent 外部合同（Descriptor / Agent Card）的规范化与证据。
 *
 * 事实源：docs/V12/01/agent补充/00 §6.2/§7/§8/§11/§13、01 §2/§4/§7/§8/§13。
 *
 * SnowHarness 对 Agent 一律按源码不可见处理。三层外部合同：
 * - Identity Contract：这个 Agent 是谁；
 * - Capability Manifest：它声明擅长处理什么任务（task-oriented，不是 Tool operation）；
 * - Invocation Context Contract：调用整个 Agent 时平台应尽量提供什么上下文（Agent 级，
 *   不是 per-Capability 函数参数）。
 * 另有 Protocol Facts：protocolType / protocolContractRevision。
 *
 * 关键不变量：
 * - CapabilityManifest 描述"会什么任务"，禁止 per-capability 函数签名 / operation / RPC /
 *   business required|optional arguments。
 * - InvocationContextContract 是 Agent 级合同，necessity ∈ required|preferred|accepted。
 * - CapabilityManifest ≠ Runtime/Interface Requirements：Capability 是业务任务声明；
 *   Agent 对 Runtime 的执行接口要求属于另一类正式事实（agentInterfaceRequirements），
 *   不得混入 capability digest。
 * - 每个 context 声明显式标记来源 provider_declared | operator_declared，禁止伪装。
 * - digest 为 sha256: 前缀的稳定 canonical digest（sortKeys 规范化）。
 */
import { createHash } from "node:crypto";

// ─── 语义枚举 ─────────────────────────────────────────────

/** context 必要性。 */
export const CONTEXT_NECESSITIES = ["required", "preferred", "accepted"] as const;
export type ContextNecessity = (typeof CONTEXT_NECESSITIES)[number];

/** 合同声明来源。 */
export const PROVENANCE_SOURCES = ["provider_declared", "operator_declared"] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

// ─── Provider Agent Card（wire 输入，provider 公开合同）──────

/**
 * Provider 正式公开的 Agent Card 输入。
 * 这是 SnowHarness 从外部 Agent 可公开读取的最小合同；SnowHarness 不读 Agent 源码。
 */
export interface ProviderAgentCard {
  protocol: {
    type: string;
    contractRevision: string;
  };
  identity?: {
    name?: string;
    description?: string;
    /** provider 声明的原始修订标识（仅参考，不作 Authority）。 */
    providerRevisionRef?: string;
  };
  capabilities: ProviderCapability[];
  invocationContext?: ProviderInvocationContextDeclaration[];
}

/** Provider 声明的单项业务能力。 */
export interface ProviderCapability {
  capabilityKey: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/** Provider 声明的调用上下文声明。 */
export interface ProviderInvocationContextDeclaration {
  contextKind: string;
  necessity: ContextNecessity;
  purpose?: string;
}

/** 管理员基于第三方正式接入合同登记的 supplemental context（operator_declared）。 */
export interface OperatorContextSupplement {
  contexts: Array<{
    contextKind: string;
    necessity: ContextNecessity;
    purpose?: string;
  }>;
}

// ─── 规范化模型 ───────────────────────────────────────────

/** 单项能力：仅描述"会什么任务"。 */
export interface AgentCapability {
  capabilityKey: string;
  name: string;
  description?: string;
  tags: string[];
  examples: string[];
  inputModes: string[];
  outputModes: string[];
}

/** CapabilityManifest：结构化、可查询的任务清单。 */
export interface CapabilityManifest {
  capabilities: AgentCapability[];
}

/** 单个上下文声明（含来源标记）。 */
export interface InvocationContextDeclaration {
  contextKind: string;
  necessity: ContextNecessity;
  purpose?: string;
  /** 来源：provider_declared | operator_declared。 */
  provenance: ProvenanceSource;
}

/** InvocationContextContract：Agent 级上下文合同。 */
export interface InvocationContextContract {
  contexts: InvocationContextDeclaration[];
}

/** 各合同节来源聚合（用于管理端展示与审计）。 */
export interface ContractSectionProvenance {
  capability: ProvenanceSource;
  context: ProvenanceSource;
}

/** canonicalizeProviderDescriptor 的完整结果。 */
export interface CanonicalizedAgentDescriptor {
  canonicalProviderDescriptor: Record<string, unknown>;
  providerDescriptorDigest: string;
  normalizedCapabilityManifest: CapabilityManifest;
  capabilityManifestDigest: string;
  invocationContextContract: InvocationContextContract;
  invocationContextContractDigest: string;
  contractSectionProvenance: ContractSectionProvenance;
}

/** Capability 白名单字段（防 Tool/operation 化）。 */
const CAPABILITY_ALLOWED_KEYS = new Set([
  "capabilityKey",
  "name",
  "description",
  "tags",
  "examples",
  "inputModes",
  "outputModes",
]);

// ─── 错误 ─────────────────────────────────────────────────

export class AgentDescriptorError extends Error {
  constructor(message: string) {
    super(`Agent Descriptor 无效：${message}`);
    this.name = "AgentDescriptorError";
  }
}

export class AgentCapabilityToolizationError extends AgentDescriptorError {
  constructor(capabilityKey: string, extraKeys: string[]) {
    super(
      `Capability "${capabilityKey}" 不得携带 per-capability 函数/operation 字段：${extraKeys.join(
        ", ",
      )}（Agent 是 task-oriented，不是 Tool operation）`,
    );
    this.name = "AgentCapabilityToolizationError";
  }
}

// ─── 工具 ─────────────────────────────────────────────────

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return result;
}

function canonicalString(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sha256Digest(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

/** 稳定 canonical digest（sortKeys 规范化后 sha256）。 */
export function computeStableDigest(value: unknown): string {
  return sha256Digest(canonicalString(value));
}

/** CapabilityManifest digest：仅由业务能力构成，不混 Runtime interface requirements。 */
export function computeCapabilityManifestDigest(manifest: CapabilityManifest): string {
  return computeStableDigest(manifest);
}

/** InvocationContextContract digest：含每个声明的 provenance 来源标记。 */
export function computeInvocationContextContractDigest(
  contract: InvocationContextContract,
): string {
  return computeStableDigest(contract);
}

// ─── 校验 ─────────────────────────────────────────────────

function assertCapabilityKey(keys: Set<string>, capabilityKey: string): void {
  if (!capabilityKey || !capabilityKey.trim()) {
    throw new AgentDescriptorError("capabilityKey 不能为空");
  }
  if (keys.has(capabilityKey)) {
    throw new AgentDescriptorError(`capabilityKey 重复: ${capabilityKey}`);
  }
  keys.add(capabilityKey);
}

function assertNecessity(necessity: string, where: string): asserts necessity is ContextNecessity {
  if (!(CONTEXT_NECESSITIES as readonly string[]).includes(necessity)) {
    throw new AgentDescriptorError(
      `${where} necessity 非法: ${necessity}（必须 required|preferred|accepted）`,
    );
  }
}

function assertNoToolization(capabilityKey: string, capability: ProviderCapability): void {
  const extra = Object.keys(capability).filter((k) => !CAPABILITY_ALLOWED_KEYS.has(k));
  if (extra.length > 0) {
    throw new AgentCapabilityToolizationError(capabilityKey, extra);
  }
}

// ─── 规范化 ───────────────────────────────────────────────

function normalizeCapability(capability: ProviderCapability): AgentCapability {
  assertNoToolization(capability.capabilityKey, capability);
  return {
    capabilityKey: capability.capabilityKey,
    name: capability.name,
    description: capability.description,
    tags: capability.tags ?? [],
    examples: capability.examples ?? [],
    inputModes: capability.inputModes ?? [],
    outputModes: capability.outputModes ?? [],
  };
}

function normalizeInvocationContextContract(
  declared: ProviderInvocationContextDeclaration[],
  supplement: OperatorContextSupplement | undefined,
): { contract: InvocationContextContract; hasOperatorContext: boolean } {
  const contexts: InvocationContextDeclaration[] = [];
  for (const d of declared ?? []) {
    assertNecessity(d.necessity, `context ${d.contextKind}`);
    contexts.push({
      contextKind: d.contextKind,
      necessity: d.necessity,
      purpose: d.purpose,
      provenance: "provider_declared",
    });
  }
  let hasOperatorContext = false;
  for (const s of supplement?.contexts ?? []) {
    assertNecessity(s.necessity, `operator context ${s.contextKind}`);
    contexts.push({
      contextKind: s.contextKind,
      necessity: s.necessity,
      purpose: s.purpose,
      provenance: "operator_declared",
    });
    hasOperatorContext = true;
  }
  return {
    contract: { contexts },
    hasOperatorContext,
  };
}

/**
 * canonicalizeProviderDescriptor：把 Provider Agent Card + 可选 operator supplement 规范化为
 * 不可变 Snapshot 所需的全部字段与 digest。这是登记 Agent 的唯一规范化入口。
 */
export function canonicalizeAgentDescriptor(params: {
  tenantId: string;
  agentId: string;
  descriptorKind: string;
  card: ProviderAgentCard;
  operatorContextSupplement?: OperatorContextSupplement | undefined;
}): CanonicalizedAgentDescriptor {
  if (!params.descriptorKind || !params.descriptorKind.trim()) {
    throw new AgentDescriptorError("descriptorKind 不能为空");
  }
  if (!params.card.protocol?.type || !params.card.protocol?.contractRevision) {
    throw new AgentDescriptorError("protocol.type / protocol.contractRevision 必须提供");
  }

  // 1. 校验并规范化 CapabilityManifest
  const seenKeys = new Set<string>();
  for (const c of params.card.capabilities ?? []) {
    assertCapabilityKey(seenKeys, c.capabilityKey);
  }
  const normalizedCapabilityManifest: CapabilityManifest = {
    capabilities: (params.card.capabilities ?? []).map(normalizeCapability),
  };
  const capabilityManifestDigest = computeCapabilityManifestDigest(normalizedCapabilityManifest);

  // 2. 合并 provider/operator InvocationContextContract
  const { contract: invocationContextContract, hasOperatorContext } =
    normalizeInvocationContextContract(
      params.card.invocationContext ?? [],
      params.operatorContextSupplement,
    );
  const invocationContextContractDigest =
    computeInvocationContextContractDigest(invocationContextContract);

  // 3. canonical provider descriptor（保留 provider 原始声明，不含 operator）
  const canonicalProviderDescriptor: Record<string, unknown> = {
    descriptorKind: params.descriptorKind,
    protocol: params.card.protocol,
    identity: params.card.identity ?? {},
    capabilities: (params.card.capabilities ?? []).map(normalizeCapability),
    invocationContext: (params.card.invocationContext ?? []).map((d) => ({
      contextKind: d.contextKind,
      necessity: d.necessity,
      purpose: d.purpose,
    })),
  };
  const providerDescriptorDigest = computeStableDigest(canonicalProviderDescriptor);

  const contractSectionProvenance: ContractSectionProvenance = {
    capability: "provider_declared",
    context: hasOperatorContext ? "operator_declared" : "provider_declared",
  };

  return {
    canonicalProviderDescriptor,
    providerDescriptorDigest,
    normalizedCapabilityManifest,
    capabilityManifestDigest,
    invocationContextContract,
    invocationContextContractDigest,
    contractSectionProvenance,
  };
}
