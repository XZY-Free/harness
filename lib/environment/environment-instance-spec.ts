/**
 * R07：把不可变 EnvironmentDefinitionRevision 的 5 份策略 JSON + executionTarget
 * 规范化为**可直接施加并可回读核验**的实例规格。
 *
 * 设计约束（repairs/06-environment.md）：
 * - 只读 Revision（Binding 冻结的那一份），Definition 的 current/default 不进入本模块。
 * - 规范化是严格的：声明无法被解释成可核验事实 → `EnvironmentComplianceFailed`，
 *   绝不"降级为宽松默认然后自报通过"。
 * - 不允许出现"latest/tag-only 目标"：`imageDigest` 必须是 `sha256:<64hex>`。
 *
 * 规范形状（Revision 5 份 JSON 的 canonical 契约）：
 *
 * executionTarget（container）:
 *   { kind: "container", image: "repo@sha256:…"|"repo:tag", imageDigest: "sha256:…",
 *     entrypoint: ["/usr/bin/agent", "--serve"], args?: ["--port","8080"], workdir?: "/workspace" }
 * executionTarget（host_agent）:
 *   { kind: "host_agent", artifactRef: "snowharness-agent@1.2.0",
 *     artifactDigest: "sha256:…", agentCommand: ["/opt/snow/agent","--serve"], workdir?: "…" }
 * filesystemPolicy:
 *   { readOnlyRootfs?: boolean, workspaceMountPath?: "/workspace"|null,
 *     workspaceMountReadOnly?: boolean, isolatedFromHost?: boolean,
 *     extraMounts?: [{ source, target, readOnly? }] }
 * networkPolicy: { mode: "disabled" | "open" }
 * resourceLimits: { memoryBytes?: number, cpus?: number|string, pidsLimit?: number,
 *                   openFilesLimit?: number, diskQuotaBytes?: number }
 * secretPolicy: { injection?: "env_file" | "none", envNames?: string[] }
 *
 * 显式拒绝（fail closed，不静默降级）：
 * - `{ egress: "deny_all" }` 之类未实现的网络语义 → 必须改写为 `{ mode: "disabled" }`。
 * - `{ networkPolicy: { mode: "allowlist" } }` → allowlist 未实现（见 network-policy.ts）。
 */
import { createHash } from "node:crypto";
import { EnvironmentComplianceError } from "@/lib/environment/environment-errors";
import type { EnvironmentType } from "@/lib/persistence/schema/environment";

export type EnvironmentBackendKind = "container" | "host_agent";

export interface NormalizedExecutionTarget {
  image: string;
  /** 固定镜像身份（`sha256:<64hex>`），必须与真实镜像 ID/RepoDigest 一致。 */
  imageDigest: string;
  entrypoint: string[];
  args: string[];
  workdir: string | null;
}

export interface NormalizedHostAgentTarget {
  artifactRef: string;
  artifactDigest: string;
  agentCommand: string[];
  workdir: string | null;
}

export interface NormalizedResourceLimits {
  /** 内存上限（字节）。0 = 未声明上限（不视为已满足 resourceLimits 能力）。 */
  memoryBytes: number;
  /** CPU 配额（纳核；1e9 = 1 CPU）。0 = 未声明。 */
  nanoCpus: number;
  pidsLimit: number;
  openFilesLimit: number;
  diskQuotaBytes: number;
}

export interface NormalizedFilesystemPolicy {
  readOnlyRootfs: boolean;
  workspaceMount: { target: string; readOnly: boolean } | null;
  extraMounts: Array<{ source: string; target: string; readOnly: boolean }>;
  isolatedFromHost: boolean;
}

export interface NormalizedNetworkPolicy {
  mode: "disabled" | "open";
}

export interface NormalizedSecretPolicy {
  injection: "env_file" | "none";
  envNames: string[];
}

export interface EnvironmentInstanceSpec {
  environmentType: EnvironmentType;
  backendKind: EnvironmentBackendKind;
  revisionId: string;
  semanticDigest: string;
  container: NormalizedExecutionTarget | null;
  hostAgent: NormalizedHostAgentTarget | null;
  filesystemPolicy: NormalizedFilesystemPolicy;
  networkPolicy: NormalizedNetworkPolicy;
  resourceLimits: NormalizedResourceLimits;
  secretPolicy: NormalizedSecretPolicy;
  requiredCapabilities: Record<string, unknown>;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EnvironmentComplianceError(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  return asRecord(value, label);
}

function requiredString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EnvironmentComplianceError(`${label}.${key} 必填且必须是非空字符串`);
  }
  return value.trim();
}

function optionalBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new EnvironmentComplianceError(`${key} 必须是布尔值（收到 ${typeof value}）`);
  }
  return value;
}

function requiredDigest(source: Record<string, unknown>, key: string, label: string): string {
  const value = requiredString(source, key, label);
  if (!DIGEST_PATTERN.test(value)) {
    throw new EnvironmentComplianceError(
      `${label}.${key} 必须是固定摘要（sha256:<64 lowercase hex>）；不接受 latest/tag-only 目标`,
    );
  }
  return value;
}

function stringArray(value: unknown, label: string, options?: { required?: boolean }): string[] {
  if (value === undefined || value === null) {
    if (options?.required) throw new EnvironmentComplianceError(`${label} 必填`);
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new EnvironmentComplianceError(`${label} 必须是字符串数组`);
  }
  const entries = (value as string[]).map((entry) => entry.trim()).filter(Boolean);
  if (options?.required && entries.length === 0) {
    throw new EnvironmentComplianceError(`${label} 不能为空数组`);
  }
  return entries;
}

/** 解析内存上限：接受字节数或 `512m` / `1g` / `256k` 形式的字符串。 */
function parseBytes(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0)
      throw new EnvironmentComplianceError(`${label} 非法数值`);
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (!text) return 0;
    // 纯数字字符串按字节解释（与 docker --memory 语义一致）。
    if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
    const match = /^(\d+(?:\.\d+)?)(k|kb|kib|m|mb|mib|g|gb|gib)?$/.exec(text);
    if (!match) throw new EnvironmentComplianceError(`${label} 无法解析：${value}`);
    const amount = Number.parseFloat(match[1] ?? "");
    const unit = match[2] ?? "";
    const factor = unit.startsWith("k")
      ? 1024
      : unit.startsWith("m")
        ? 1024 ** 2
        : unit.startsWith("g")
          ? 1024 ** 3
          : 1;
    return Math.floor(amount * factor);
  }
  throw new EnvironmentComplianceError(`${label} 必须是字节数或如 "512m" 的字符串`);
}

/** 解析 CPU 配额：接受核数（number/string，可为小数）→ 纳核。 */
function parseNanoCpus(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new EnvironmentComplianceError(`${label} 非法：${String(value)}`);
  }
  return Math.floor(parsed * 1e9);
}

function parseNonNegativeInt(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new EnvironmentComplianceError(`${label} 必须是非负整数`);
  }
  return Math.floor(parsed);
}

function parseExecutionTarget(
  raw: unknown,
  environmentType: EnvironmentType,
): Pick<EnvironmentInstanceSpec, "backendKind" | "container" | "hostAgent"> {
  const target = asRecord(raw, "executionTarget");
  const kind = target.kind;
  if (kind === "container") {
    const image = requiredString(target, "image", "executionTarget");
    if (image.endsWith(":latest")) {
      throw new EnvironmentComplianceError("executionTarget.image 不接受 latest 标签");
    }
    return {
      backendKind: "container",
      container: {
        image,
        imageDigest: requiredDigest(target, "imageDigest", "executionTarget"),
        entrypoint: stringArray(target.entrypoint, "executionTarget.entrypoint", {
          required: true,
        }),
        args: stringArray(target.args, "executionTarget.args"),
        workdir: typeof target.workdir === "string" ? target.workdir : null,
      },
      hostAgent: null,
    };
  }
  if (kind === "host_agent") {
    return {
      backendKind: "host_agent",
      container: null,
      hostAgent: {
        artifactRef: requiredString(target, "artifactRef", "executionTarget"),
        artifactDigest: requiredDigest(target, "artifactDigest", "executionTarget"),
        agentCommand: stringArray(target.agentCommand, "executionTarget.agentCommand", {
          required: true,
        }),
        workdir: typeof target.workdir === "string" ? target.workdir : null,
      },
    };
  }
  throw new EnvironmentComplianceError(
    `executionTarget.kind 不支持：${String(kind)}（EnvironmentType=${environmentType} 仅支持 container | host_agent）`,
  );
}

function parseFilesystemPolicy(raw: unknown): NormalizedFilesystemPolicy {
  const policy = optionalRecord(raw, "filesystemPolicy");
  const workspaceMountPath =
    policy.workspaceMountPath === null
      ? null
      : typeof policy.workspaceMountPath === "string" && policy.workspaceMountPath.trim()
        ? policy.workspaceMountPath.trim()
        : null;
  const extraMountsRaw = policy.extraMounts;
  const extraMounts: NormalizedFilesystemPolicy["extraMounts"] = [];
  if (extraMountsRaw !== undefined && extraMountsRaw !== null) {
    if (!Array.isArray(extraMountsRaw)) {
      throw new EnvironmentComplianceError("filesystemPolicy.extraMounts 必须是数组");
    }
    for (const entry of extraMountsRaw) {
      const mount = asRecord(entry, "filesystemPolicy.extraMounts[]");
      extraMounts.push({
        source: requiredString(mount, "source", "filesystemPolicy.extraMounts[]"),
        target: requiredString(mount, "target", "filesystemPolicy.extraMounts[]"),
        readOnly: optionalBoolean(mount, "readOnly", true),
      });
    }
  }
  return {
    readOnlyRootfs: optionalBoolean(policy, "readOnlyRootfs", false),
    workspaceMount: workspaceMountPath
      ? {
          target: workspaceMountPath,
          readOnly: optionalBoolean(policy, "workspaceMountReadOnly", false),
        }
      : null,
    extraMounts,
    isolatedFromHost: optionalBoolean(policy, "isolatedFromHost", false),
  };
}

function parseNetworkPolicy(raw: unknown): NormalizedNetworkPolicy {
  const policy = optionalRecord(raw, "networkPolicy");
  const mode = policy.mode;
  if (mode === undefined || mode === null) {
    // 未声明网络策略 → 最严（断网），而不是"默认放开"。
    return { mode: "disabled" };
  }
  if (mode === "disabled" || mode === "open") return { mode };
  throw new EnvironmentComplianceError(
    `networkPolicy.mode 未实现或非法：${JSON.stringify(mode)}（仅支持 disabled | open；allowlist / egress 等语义尚未实现，不得静默降级）`,
  );
}

function parseResourceLimits(raw: unknown): NormalizedResourceLimits {
  const limits = optionalRecord(raw, "resourceLimits");
  return {
    memoryBytes: parseBytes(limits.memoryBytes ?? limits.memory, "resourceLimits.memoryBytes"),
    nanoCpus: parseNanoCpus(limits.cpus ?? limits.cpu, "resourceLimits.cpus"),
    pidsLimit: parseNonNegativeInt(limits.pidsLimit, "resourceLimits.pidsLimit"),
    openFilesLimit: parseNonNegativeInt(limits.openFilesLimit, "resourceLimits.openFilesLimit"),
    diskQuotaBytes: parseBytes(limits.diskQuotaBytes, "resourceLimits.diskQuotaBytes"),
  };
}

function parseSecretPolicy(raw: unknown): NormalizedSecretPolicy {
  const policy = optionalRecord(raw, "secretPolicy");
  const injection = policy.injection ?? "none";
  if (injection !== "none" && injection !== "env_file") {
    throw new EnvironmentComplianceError(
      `secretPolicy.injection 不支持：${JSON.stringify(injection)}（仅支持 none | env_file）`,
    );
  }
  const envNames = stringArray(policy.envNames, "secretPolicy.envNames");
  if (injection === "env_file" && envNames.length === 0) {
    throw new EnvironmentComplianceError("secretPolicy.envNames 在使用 env_file 注入时不能为空");
  }
  return { injection, envNames };
}

/** Revision → 可施加实例规格。任何无法核验的声明直接 fail closed。 */
export function normalizeEnvironmentInstanceSpec(revision: {
  id: string;
  semanticDigest: string;
  environmentType: string;
  executionTarget: unknown;
  filesystemPolicyJson: unknown;
  networkPolicyJson: unknown;
  resourceLimitsJson: unknown;
  secretPolicyJson: unknown;
  requiredCapabilities: unknown;
}): EnvironmentInstanceSpec {
  const requiredCapabilities = asRecord(revision.requiredCapabilities, "requiredCapabilities");
  return {
    environmentType: revision.environmentType as EnvironmentType,
    revisionId: revision.id,
    semanticDigest: revision.semanticDigest,
    ...parseExecutionTarget(revision.executionTarget, revision.environmentType as EnvironmentType),
    filesystemPolicy: parseFilesystemPolicy(revision.filesystemPolicyJson),
    networkPolicy: parseNetworkPolicy(revision.networkPolicyJson),
    resourceLimits: parseResourceLimits(revision.resourceLimitsJson),
    secretPolicy: parseSecretPolicy(revision.secretPolicyJson),
    requiredCapabilities,
  };
}

/**
 * 声明能力 → 实际可核验能力的映射。
 *
 * 关键：`actual` 只能来自**真实回读的实例事实**（inspect 结果），不能来自调用方自报。
 * 未识别的能力名一律视为"无法落实"（fail closed），防止未来新增能力名静默通过。
 */
export function derivedCapabilities(input: {
  spec: EnvironmentInstanceSpec;
  readOnly: boolean;
  networkIsolated: boolean;
  memoryLimited: boolean;
  cpuLimited: boolean;
  pidsLimited: boolean;
  openFilesLimited: boolean;
  secretInjected: boolean;
  processIsolated: boolean;
  imagePinned: boolean;
}): Record<string, unknown> {
  return {
    containerized: input.spec.backendKind === "container",
    processIsolation: input.processIsolated,
    networkIsolation: input.networkIsolated,
    readOnlyRootfs: input.readOnly,
    resourceLimits:
      input.memoryLimited || input.cpuLimited || input.pidsLimited || input.openFilesLimited,
    memoryLimit: input.memoryLimited,
    cpuLimit: input.cpuLimited,
    pidsLimit: input.pidsLimited,
    openFilesLimit: input.openFilesLimited,
    secretInjection: input.spec.secretPolicy.injection === "none" ? "none" : input.secretInjected,
    secretInjectionMethod: input.spec.secretPolicy.injection,
    pinnedImage: input.imagePinned,
    managedAgentArtifact: input.spec.backendKind === "host_agent",
    filesystemIsolation: input.spec.filesystemPolicy.isolatedFromHost,
  };
}

/**
 * `requiredCapabilities` 对实际能力的满足判定（浅层严格比较）。
 *
 * - `true`：实际值必须严格 `=== true`。
 * - 数组：实际必须是数组且包含全部要求项。
 * - 其他：严格相等。
 *
 * 未识别的能力名 → 实际值为 `undefined` → 不满足（fail closed）。
 */
export function capabilitiesMeet(required: unknown, actual: unknown): boolean {
  if (!required || typeof required !== "object" || Array.isArray(required)) return true;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(required as Record<string, unknown>).every(([key, value]) => {
    const got = (actual as Record<string, unknown>)[key];
    if (value === true) return got === true;
    if (Array.isArray(value)) return Array.isArray(got) && value.every((v) => got.includes(v));
    return got === value;
  });
}

/** 不满足的能力名列表（诊断用，写入 compliance 失败信息）。 */
export function unmetCapabilities(required: unknown, actual: unknown): string[] {
  if (!required || typeof required !== "object" || Array.isArray(required)) return [];
  const actualRecord = (actual ?? {}) as Record<string, unknown>;
  return Object.entries(required as Record<string, unknown>)
    .filter(([key, value]) => {
      const got = actualRecord[key];
      if (value === true) return got !== true;
      if (Array.isArray(value)) return !Array.isArray(got) || !value.every((v) => got.includes(v));
      return got !== value;
    })
    .map(([key]) => key);
}

/** 由真实实例事实派生"实际执行目标 digest"。 */
export function computeInstanceTargetDigest(input: Record<string, unknown>): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function computeSpecDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
