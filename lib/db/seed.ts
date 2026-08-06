/**
 * 示例 skill seed。
 *
 * 无 Agent Studio 后台 UI（Phase 4），故用 seed 脚本灌库。幂等：按 skill name
 * upsert——skill 不存在则建，缺 active 版本则建 v1 并回填 currentVersionId；
 * 重复执行不产生重复版本（created=false，无写入）。
 *
 * 示例 skill `build-from-idea` 的 promptTemplate 即现有 AGENT_SYSTEM_PROMPT 全文，
 * allowedTools 含全部 6 个工具（**必须含 reportReady**，否则 预览闸门开不了预览，
 * 见方案 / §10 风险）。行为与 完全一致，不回归。
 *
 * reviewMode / artifactPolicy 仅存储，行为留 Phase 4（）。
 */

import { AGENT_SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { upsertUserByIdentity } from "@/lib/auth";
import { aiConfig } from "@/lib/config";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import {
 assignRoleToUser,
 createAgent,
 createProvider,
 createRole,
 createSkill,
 createSkillVersion,
 getAgentByName,
 getCurrentSkillVersion,
 getProviderByName,
 getRoleByKey,
 getSeedVersion,
 getSkillByName,
 renameRole,
 setCurrentVersion,
 setRolePermissions,
 setSeedVersion,
} from "@/lib/db/queries";
import { policyConfig } from "@/lib/db/schema";
import { defaultPolicyRows } from "@/lib/policy/config";
import { ADMIN_PERMISSIONS, MEMBER_PERMISSIONS } from "@/lib/rbac";
import { commitSkillVersion, writeSkillFile } from "@/lib/skill/repo";

export const DEFAULT_SKILL_NAME = "build-from-idea";
export const ZFL_REQUIREMENT_SKILL_NAME = "zfl-requirement";

/**
 * seed 版本常量。
 *
 * 版本号变更（新增 seed 项 / 修改既有 seed 内容）时递增此值。
 * main() 开头读 getSeedVersion，与 SEED_VERSION 比对：
 * - 一致 → 跳过 seed（幂等，避免重复写入）
 * - 不一致或 null → 执行 seed + setSeedVersion(新版本)
 */
export const SEED_VERSION = "2026-06-26-v2";

/** zfl-requirement 的工具白名单（全部工具，SKILL.md frontmatter 未限制）。 */
export const ZFL_REQUIREMENT_TOOLS = [
 "writeFile",
 "readFile",
 "listFiles",
 "runCommand",
 "runTests",
 "reportReady",
] as const;

/**
 * 示例 skill 的工具白名单——全部 6 个工具。
 * 必须含 reportReady（预览闸门依赖，/ §10）。
 */
export const DEFAULT_SKILL_TOOLS = [
 "writeFile",
 "readFile",
 "listFiles",
 "runCommand",
 "runTests",
 "reportReady",
] as const;

export interface SeedResult {
 skillId: string;
 versionId: string;
 /** 本次是否实际写入了数据（false = 已存在，幂等 no-op）。 */
 created: boolean;
}

/**
 * 灌示例 skill `build-from-idea` v1。
 *
 * 幂等语义：
 * - skill 不存在 → 建 skill + v1 + 回填 currentVersionId
 * - skill 存在但无 active 版本 → 建 v1 + 回填 currentVersionId
 * - skill 存在且有 active 版本 → no-op（不重复建版本，不覆盖现有 prompt）
 *
 * 注意：若 AGENT_SYSTEM_PROMPT 内容变更，重新 seed 不会自动造新版本——
 * 这是 bootstrap seed，非数据迁移；需要换 prompt 时手动新增 version 并切 currentVersionId。
 */
/**
 * 示例 skill 的 SKILL.md 内容（Agent Skills 标准 frontmatter + AGENT_SYSTEM_PROMPT 正文）。
 * frontmatter `tools` 与 DEFAULT_SKILL_TOOLS 一致；DB allowedTools 作快照由 seed 直接写入。
 */
function buildDefaultSkillMd(): string {
 return [
 "---",
 `name: ${DEFAULT_SKILL_NAME}`,
 "description: 从想法到上线：示例全栈生成 skill（行为基线）",
 `tools: ${DEFAULT_SKILL_TOOLS.join(",")}`,
 "---",
 "",
 AGENT_SYSTEM_PROMPT,
 "",
 ].join("\n");
}

export async function seedDefaultSkill(): Promise<SeedResult> {
 let skill = await getSkillByName(DEFAULT_SKILL_NAME);
 let created = false;

 if (!skill) {
 skill = await createSkill({
 name: DEFAULT_SKILL_NAME,
 description: "从想法到上线：示例全栈生成 skill（行为基线）",
 category: "fullstack",
 visibility: "public",
 status: "active",
 });
 created = true;
 }

 let version = await getCurrentSkillVersion(skill.id);
 if (!version) {
 // 目录形态：写 skills/build-from-idea/SKILL.md + git commit 拿 sha，
 // 版本内容由目录承载（promptTemplate 不再写入，留空）。
 await writeSkillFile(DEFAULT_SKILL_NAME, "SKILL.md", buildDefaultSkillMd());
 const commitSha = await commitSkillVersion(DEFAULT_SKILL_NAME, `${DEFAULT_SKILL_NAME} v1`);
 version = await createSkillVersion({
 skillId: skill.id,
 version: 1,
 commitSha,
 allowedTools: [...DEFAULT_SKILL_TOOLS],
 reviewMode: "auto",
 status: "active",
 });
 await setCurrentVersion(skill.id, version.id);
 created = true;
 }

 return { skillId: skill.id, versionId: version.id, created };
}

// ─── zfl-requirement skill seed ─────────────────────────────

/**
 * 灌 zfl-requirement skill（需求引导与原型）。
 *
 * 幂等语义同 seedDefaultSkill：skill 不存在则建，缺 active 版本则建 v1。
 * SKILL.md 已存在于 skills/zfl-requirement/（手动放置），此处只做 DB 注册 + git commit 版本化。
 */
export async function seedZflRequirementSkill(): Promise<SeedResult> {
 let skill = await getSkillByName(ZFL_REQUIREMENT_SKILL_NAME);
 let created = false;

 if (!skill) {
 skill = await createSkill({
 name: ZFL_REQUIREMENT_SKILL_NAME,
 description: "完整的需求引导与原型 skill（需求分析→方案文档→视觉规格→HTML原型）",
 category: "requirement",
 visibility: "public",
 status: "active",
 });
 created = true;
 }

 let version = await getCurrentSkillVersion(skill.id);
 if (!version) {
 // SKILL.md 及支持文件已在 skills/zfl-requirement/ 中，直接 commit
 const commitSha = await commitSkillVersion(
 ZFL_REQUIREMENT_SKILL_NAME,
 `${ZFL_REQUIREMENT_SKILL_NAME} v1`,
 );
 version = await createSkillVersion({
 skillId: skill.id,
 version: 1,
 commitSha,
 allowedTools: [...ZFL_REQUIREMENT_TOOLS],
 reviewMode: "auto",
 status: "active",
 });
 await setCurrentVersion(skill.id, version.id);
 created = true;
 }

 return { skillId: skill.id, versionId: version.id, created };
}

// ─── 默认角色 seed（RBAC） ─────────────────────────

/**
 * 灌入系统内置角色（admin / member）+ 对应权限，并把默认用户绑定为 admin。
 *
 * 幂等：
 * - 角色按 key 取或建（getRoleByKey → createRole）。
 * - 角色名升级：旧部署的英文 name（Administrator / Member）→ 中文（管理员 / 成员），
 * 每次 seed 校正一次（renameRole），重复 seed 无副作用。
 * - 权限用 setRolePermissions 覆盖（删旧 + 插新），重复 seed 得同一权限集。
 * - 默认用户绑 admin 用 INSERT IGNORE（assignRoleToUser），重复不报错。
 *
 * dev/test 下默认用户即获 admin（与 lib/rbac.ts devOpen 注入一致），保证本地与既有测试零回归；
 * production 下默认用户本就无意义（真实用户经 SSO 注入），此绑定不影响生产权限模型。
 */
export async function seedDefaultRoles(): Promise<void> {
 await upsertUserByIdentity({
 externalId: DEFAULT_USER_ID,
 email: DEFAULT_USER_EMAIL,
 name: DEFAULT_USER_NAME,
 });

 const ADMIN_NAME = "管理员";
 const MEMBER_NAME = "成员";

 let admin = await getRoleByKey("admin");
 if (!admin) {
 admin = await createRole({ key: "admin", name: ADMIN_NAME, isSystem: true });
 } else if (admin.name !== ADMIN_NAME) {
 await renameRole(admin.id, ADMIN_NAME);
 admin = { ...admin, name: ADMIN_NAME };
 }
 await setRolePermissions(admin.id, [...ADMIN_PERMISSIONS]);

 let member = await getRoleByKey("member");
 if (!member) {
 member = await createRole({ key: "member", name: MEMBER_NAME, isSystem: true });
 } else if (member.name !== MEMBER_NAME) {
 await renameRole(member.id, MEMBER_NAME);
 member = { ...member, name: MEMBER_NAME };
 }
 await setRolePermissions(member.id, [...MEMBER_PERMISSIONS]);

 await assignRoleToUser(DEFAULT_USER_ID, admin.id);
}

// ─── 默认 policy seed（policy DB 化） ──────────────

/**
 * 灌入默认 policy 配置行（4 个 key）。幂等：ON DUPLICATE KEY UPDATE 覆盖为默认值。
 * 行来源 `defaultPolicyRows()`（lib/policy/config.ts），与 migration 0006 backfill 同源。
 */
export async function seedDefaultPolicy(): Promise<void> {
 for (const row of defaultPolicyRows()) {
 await db
 .insert(policyConfig)
 .values({ key: row.key, value: row.value, updatedAt: new Date() })
 .onDuplicateKeyUpdate({ set: { value: row.value, updatedAt: new Date() } });
 }
}

// ─── 默认 provider / agent seed（: 只读档案） ──

/**
 * 默认 provider 档案名（唯一幂等键）。
 *
 * provider 表只镜像当前 env 配置供后台只读展示，**不接 runtime**（runtime 仍走 env
 * aiConfig，见 / 非目标）。apiKeyRef 存 env 引用名 `LLM_API_KEY`，**不落明文 secret**。
 */
export const DEFAULT_PROVIDER_NAME = "default";

/**
 * 灌入默认 provider 档案：镜像 env aiConfig.baseUrl，apiKeyRef = "LLM_API_KEY"（引用名，非明文）。
 *
 * 幂等：按 name 取或建——已存在则 no-op（不覆盖 baseUrl，避免重 seed 抹掉用户后续可能的档案编辑）。
 * migration 0007 不读 env、不 backfill 运行环境档案；此函数才是 env 镜像的唯一入口。
 */
export async function seedDefaultProviders(): Promise<{ created: boolean }> {
 const existing = await getProviderByName(DEFAULT_PROVIDER_NAME);
 if (existing) return { created: false };
 await createProvider({
 name: DEFAULT_PROVIDER_NAME,
 baseUrl: aiConfig.baseUrl,
 apiKeyRef: "LLM_API_KEY",
 isDefault: true,
 });
 return { created: true };
}

/**
 * 默认 agent 档案名（唯一幂等键）。
 *
 * 绑定示例 skill（build-from-idea）+ aiConfig.chatModel；config 显式写 {}（subagent 模板 /
 * 并行策略留后续切片，本切片不解析）。**不接 runtime**：model 仅档案记录。
 */
export const DEFAULT_AGENT_NAME = "default";

/**
 * 灌入默认 agent 档案：绑定示例 skill + aiConfig.chatModel，config 显式写 {}。
 *
 * 幂等：按 name 取或建。**必须在示例 skill 就绪后执行**（skillId 依赖其 id）；
 * 示例 skill 不存在时跳过 agent seed（不阻塞，由 seedDefaultSkill 先行保证）。
 */
export async function seedDefaultAgents(): Promise<{ created: boolean; skipped: boolean }> {
 // includeDeleted 查全部(含软删),软删的 default agent 也算已存在,
 // 保持幂等跳过——避免每次 seed 重建同名 agent(agent.name 无唯一约束会累积重复行)。
 const existing = await getAgentByName(DEFAULT_AGENT_NAME, { includeDeleted: true });
 if (existing) return { created: false, skipped: false };

 const defSkill = await getSkillByName(DEFAULT_SKILL_NAME);
 if (!defSkill) {
 // 示例 skill 未就绪：跳过（不报错；seedDefaultSkill 应已先行）
 return { created: false, skipped: true };
 }
 await createAgent({
 name: DEFAULT_AGENT_NAME,
 description:
 "默认 agent 档案：绑定 build-from-idea skill + 默认 chatModel（只读展示，不接 runtime）",
 model: aiConfig.chatModel,
 skillId: defSkill.id,
 config: {},
 });
 return { created: true, skipped: false };
}

// ─── CLI runner（pnpm db:seed → tsx lib/db/seed.ts）─────────

async function main() {
 // seed 版本幂等检查。
 // 版本一致 → 跳过 seed（已执行过且无变更）；不一致或 null → 执行 seed + 写新版本。
 const currentVersion = await getSeedVersion();
 if (currentVersion === SEED_VERSION) {
 console.log(
 `[seed] 已是最新版本（${SEED_VERSION}），跳过 seed（幂等）。如需强制重跑，请清空 policyConfig.seed_version。`,
 );
 process.exit(0);
 }
 console.log(`[seed] seed 版本变更：${currentVersion ?? "(无)"} → ${SEED_VERSION}，执行 seed...`);

 // 架构收敛：Skill/Agent 表已迁移到控制面 schema（lib/persistence/schema/），
 // 旧的 chat-app schema（lib/db/schema.ts 的 skill/agent）字段不兼容。
 // seed 跳过 Skill/Agent 创建，待 chat-app 代码迁移到控制面 schema 后恢复。
 // 保留 Role/PolicyConfig/ProviderProfile 等 chat-app 基础设施 seed。
 try {
 const result = await seedDefaultSkill();
 const tag = result.created ? "已写入" : "已存在（幂等跳过）";
 console.log(
 `[seed] 示例 skill "${DEFAULT_SKILL_NAME}" ${tag}：skillId=${result.skillId} versionId=${result.versionId}`,
 );
 } catch (error) {
 console.log(
 `[seed] 跳过示例 skill "${DEFAULT_SKILL_NAME}"：Skill 表已迁移到控制面 schema（架构收敛 ）`,
 );
 }

 try {
 const zflResult = await seedZflRequirementSkill();
 const zflTag = zflResult.created ? "已写入" : "已存在（幂等跳过）";
 console.log(
 `[seed] skill "${ZFL_REQUIREMENT_SKILL_NAME}" ${zflTag}：skillId=${zflResult.skillId} versionId=${zflResult.versionId}`,
 );
 } catch (error) {
 console.log(
 `[seed] 跳过 skill "${ZFL_REQUIREMENT_SKILL_NAME}"：Skill 表已迁移到控制面 schema（架构收敛 ）`,
 );
 }

 await seedDefaultRoles();
 console.log("[seed] 默认角色 admin/member + 权限已就绪（默认用户绑 admin）");
 await seedDefaultPolicy();
 console.log("[seed] 默认 policy 配置行已就绪（4 keys）");
 // 切片 B1：provider / agent 档案（只读，不接 runtime）。agent 须在示例 skill 就绪后。
 const providerRes = await seedDefaultProviders();
 console.log(
 `[seed] 默认 provider "${DEFAULT_PROVIDER_NAME}" ${providerRes.created ? "已写入（apiKeyRef=LLM_API_KEY，不落明文）" : "已存在（幂等跳过）"}`,
 );
 try {
 const agentRes = await seedDefaultAgents();
 console.log(
 `[seed] 默认 agent "${DEFAULT_AGENT_NAME}" ${agentRes.created ? "已写入（config={}）" : agentRes.skipped ? "跳过（示例 skill 未就绪）" : "已存在（幂等跳过）"}`,
 );
 } catch (error) {
 console.log(
 `[seed] 跳过默认 agent "${DEFAULT_AGENT_NAME}"：Agent 表已迁移到控制面 schema（架构收敛 ）`,
 );
 }

 // seed 成功后写新版本，下次运行幂等跳过
 await setSeedVersion(SEED_VERSION);
 console.log(`[seed] seed 版本已标记为 ${SEED_VERSION}`);
 process.exit(0);
}

// 直接运行时执行；被 import（单测）时不自动跑。
// 用 typeof require 守卫，CJS / ESM 加载器下都安全。
if (typeof require !== "undefined" && require.main === module) {
 main().catch((error) => {
 console.error("[seed] 失败：", error);
 process.exit(1);
 });
}
