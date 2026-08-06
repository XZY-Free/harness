import type { SubagentDefinition, SubagentRole } from "@/lib/db/schema";
import { createDefinition, listDefinitions } from "@/lib/subagent/registry";

/**
 * Stage D：四个默认 lane 定义。
 *
 * lane = 预置的 SubagentDefinition 模板（explore/researcher/reviewer/verifier），覆盖探索/研究/
 * 审查/验证四类有界工作单元。**全部只读**（无 writeScope），allowedTools 严格白名单，不含写工具。
 *
 * 退化策略（计划 §1）：
 * - researcher：无 时退化为 workspace+文档只读；已落地 → 含 web 工具（webFetch/webSearch/searchDocs）。
 * - verifier：无 时退化为测试结果核查（无浏览器截图）；未落地 → 不含截图工具。
 *
 * executor 角色在 enum 内,起预置默认 lane（写能力,含写工具 + runBuild/runTests 验证）。
 * defaultWriteScope=null（fail-closed,spawn 时须显式指定 writeScope）。
 */

/** lane 模板：SubagentDefinition 的可定义字段（显式类型，避免 json 列 unknown）。 */
export type SubagentLaneSpec = {
 name: string;
 role: SubagentRole;
 modelProfileId: string | null;
 allowedTools: string[];
 contextPolicy: Record<string, unknown>;
 outputSchema: Record<string, unknown> | null;
 defaultWriteScope: string[] | null;
};

const exploreSchema = {
 type: "object",
 required: ["modules"],
 properties: {
 modules: {
 type: "array",
 items: {
 type: "object",
 required: ["path"],
 properties: { path: { type: "string" }, purpose: { type: "string" } },
 },
 },
 },
} as const;

const researcherSchema = {
 type: "object",
 required: ["findings"],
 properties: {
 findings: {
 type: "array",
 items: {
 type: "object",
 required: ["topic", "summary"],
 properties: {
 topic: { type: "string" },
 summary: { type: "string" },
 sources: { type: "array", items: { type: "string" } },
 },
 },
 },
 },
} as const;

const reviewerSchema = {
 type: "object",
 required: ["findings", "risks"],
 properties: {
 findings: {
 type: "array",
 items: {
 type: "object",
 required: ["issue"],
 properties: {
 issue: { type: "string" },
 severity: { type: "string", enum: ["low", "medium", "high"] },
 location: { type: "string" },
 },
 },
 },
 risks: { type: "array", items: { type: "string" } },
 },
} as const;

const verifierSchema = {
 type: "object",
 required: ["conclusion", "evidence"],
 properties: {
 conclusion: { type: "string", enum: ["passed", "failed", "inconclusive"] },
 evidence: {
 type: "array",
 items: {
 type: "object",
 required: ["claim"],
 properties: { claim: { type: "string" }, ref: { type: "string" } },
 },
 },
 },
} as const;

/**
 * executor lane outputSchema。
 * executor 是写能力 lane（实现/修改代码），输出变更摘要 + 受影响文件 + 验证结果。
 */
const executorSchema = {
 type: "object",
 required: ["summary", "filesChanged"],
 properties: {
 summary: { type: "string", minLength: 1, maxLength: 1000 },
 filesChanged: {
 type: "array",
 items: { type: "string" },
 maxItems: 100,
 },
 verified: { type: "boolean" },
 notes: { type: "string" },
 },
} as const;

/**
 * 四个默认 lane（全部只读，无 writeScope）。
 * researcher 含 web 工具；verifier 不含 截图工具（未落地）。
 */
export const DEFAULT_LANES: Record<SubagentRole, SubagentLaneSpec | null> = {
 explore: {
 name: "explore",
 role: "explore",
 modelProfileId: null,
 allowedTools: ["readFile", "readFileRange", "listFiles", "glob", "grep", "statFile"],
 contextPolicy: { includeToolEvidence: true, maxSnippets: 5 },
 outputSchema: exploreSchema as unknown as Record<string, unknown>,
 defaultWriteScope: null,
 },
 researcher: {
 name: "researcher",
 role: "researcher",
 modelProfileId: null,
 allowedTools: ["readFile", "glob", "grep", "webFetch", "webSearch", "searchDocs"],
 contextPolicy: { includeToolEvidence: true, maxSnippets: 3 },
 outputSchema: researcherSchema as unknown as Record<string, unknown>,
 defaultWriteScope: null,
 },
 reviewer: {
 name: "reviewer",
 role: "reviewer",
 modelProfileId: null,
 allowedTools: ["readFile", "readFileRange", "glob", "grep", "statFile"],
 contextPolicy: { includeToolEvidence: true, maxSnippets: 5 },
 outputSchema: reviewerSchema as unknown as Record<string, unknown>,
 defaultWriteScope: null,
 },
 verifier: {
 name: "verifier",
 role: "verifier",
 modelProfileId: null,
 allowedTools: ["readFile", "runTests", "listBackgroundTasks"],
 contextPolicy: { includeToolEvidence: true, maxSnippets: 3 },
 outputSchema: verifierSchema as unknown as Record<string, unknown>,
 defaultWriteScope: null,
 },
 // executor 默认 lane——写能力（实现/修改代码），含写工具 + runBuild/runTests 验证。
 // defaultWriteScope=null（fail-closed：调用方 spawn 时必须显式指定 writeScope，否则只读）。
 executor: {
 name: "executor",
 role: "executor",
 modelProfileId: null,
 allowedTools: [
 "readFile",
 "readFileRange",
 "listFiles",
 "glob",
 "grep",
 "statFile",
 "writeFile",
 "editFile",
 "multiEditFile",
 "applyPatch",
 "runBuild",
 "runTests",
 ],
 contextPolicy: { includeToolEvidence: true, maxSnippets: 5 },
 outputSchema: executorSchema as unknown as Record<string, unknown>,
 defaultWriteScope: null,
 },
};

/** 取某角色的默认 lane spec；未预置（executor）→ null。 */
export function getLaneSpec(role: SubagentRole): SubagentLaneSpec | null {
 return DEFAULT_LANES[role];
}

/** 写工具名集合（用于断言 lane 不含写工具）。 */
const WRITE_TOOLS = new Set(["writeFile", "editFile", "multiEditFile", "applyPatch", "deleteFile"]);

/**
 * 确保某角色的默认 lane 已作为 SubagentDefinition 落库（按 name 幂等），返回 definitionId。
 * 供 spawnSubagent 的 role 入参解析用（起 spawn 支持 definitionId | role）。
 */
export async function ensureLaneDefinition(role: SubagentRole): Promise<SubagentDefinition | null> {
 const spec = getLaneSpec(role);
 if (!spec) return null;
 const existing = (await listDefinitions()).find((d) => d.name === spec.name);
 if (existing) return existing;
 return createDefinition({
 name: spec.name,
 role: spec.role,
 modelProfileId: spec.modelProfileId,
 allowedTools: spec.allowedTools,
 contextPolicy: spec.contextPolicy,
 outputSchema: spec.outputSchema,
 defaultWriteScope: spec.defaultWriteScope,
 });
}

/** 判定一个 lane spec 是否只读（allowedTools 不含写工具 + 无 writeScope）。 */
export function isLaneReadOnly(spec: SubagentLaneSpec): boolean {
 if (spec.defaultWriteScope && spec.defaultWriteScope.length > 0) return false;
 return !spec.allowedTools.some((t) => WRITE_TOOLS.has(t));
}
