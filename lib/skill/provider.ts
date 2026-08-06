/**
 * SkillProvider：Skill 候选来源的统一接口（02 文档 §六.1）。
 *
 * 设计目标：
 * - 把"有哪些 Skill 可用"从 `/api/chat` 中抽出,由 Provider 统一回答。
 * - Resolver 只接收 `SkillSummary`（摘要）,**不读取完整 `SKILL.md`**（懒加载由
 * `readSkillFile` 在选中后完成,只读本地 git 快照）。
 * - `availableSkills` 是 Resolver 的**唯一候选集合**;只来自本地 DB 中 active 的 Skill。
 * - 运行时不访问 capability-market:capability-market 只在后台同步模块出现,同步后的 Skill
 * 是本地镜像（source=capability-market）,与本地自建 Skill 一样从本地 DB + 本地 commitSha 读取。
 * - 没有默认 Skill:`build-from-idea` 只是一个普通 skill,不作为兜底运行策略。
 */

import { getCurrentSkillVersion, listActiveSkillsForMatching } from "@/lib/db/queries";
import type { SkillSource } from "@/lib/db/schema";

/**
 * Skill 摘要：Resolver 候选集合的元素。
 *
 * 只承载 Resolver 决策所需的摘要字段;完整 `SKILL.md` 内容**不**进入此结构
 * （metadata budget）,由 `readSkillFile` 懒加载并记录证据。
 */
export interface SkillSummary {
 /** 本地 Skill UUID（运行时事实源主键,不使用远端 asset_id）。 */
 skillId: string;
 /** 当前可用版本 ID（本地 SkillVersion UUID）。 */
 skillVersionId: string;
 /** 来源命名空间（local / capability-market）。 */
 namespace: string;
 /** 唯一短名,用于展示和日志。 */
 name: string;
 /** 中文展示名。 */
 displayName: string;
 /** 简短描述。 */
 description: string;
 /** 使用条件（Resolver 关键词匹配的主要来源）。 */
 whenToUse: string;
 /** 搜索和辅助匹配标签。 */
 tags: string[];
 /** 来源：local（本地自建）/ capability-market（同步镜像）。运行时两者读取路径一致。 */
 source: SkillSource;
 /** 可见性描述。 */
 visibility: string;
 /** 是否允许模型自动选择（false 时只接受 UI 显式选择）。 */
 modelInvocable: boolean;
 /** 是否展示给用户选择。 */
 uiVisible: boolean;
 /** 能力声明（不是工具白名单;工具权限归 Tools / Policy 专题）。 */
 requiredCapabilities: string[];
 /** 版本内容 hash（目录形态下即 skills/ git repo 的 commit sha）。 */
 contentHash: string | null;
 /** 当前可用版本号（本地 SkillVersion.version 是 int,转字符串保留可比较性）。 */
 version: string;
}

/**
 * Skill 候选来源接口。
 * 02 文档 §六.1：运行时候选列表只来自本地 active Skill（LocalDbSkillProvider）,
 * 不再有运行时远程 Provider。
 */
export interface SkillProvider {
 /** 列出本轮可见、可用的 Skill 摘要（本地 DB active Skill,同步 Skill 需映射 active）。 */
 listAvailableSkills(): Promise<SkillSummary[]>;
}

/**
 * 本地 DB Skill 适配器：唯一的运行时 Provider（02 文档 §六.1）。
 *
 * 把当前 DB registry（`skills` + `skill_versions.currentVersionId`）映射为 `SkillSummary`。
 * `listActiveSkillsForMatching` 已按来源过滤：同步 Skill 仅在映射 syncState=active 时返回。
 *
 * 映射规则：
 * - `namespace` / `source` = `sk.source`（local 或 capability-market）。
 * - `whenToUse` 复用 `skill.description`（DB 未单独建模 whenToUse）。
 * - `tags` 由 `skill.category` 单元素派生。
 * - `contentHash` = 版本 `commitSha`（目录形态版本快照引用）。
 * - `modelInvocable` / `uiVisible` 默认 true（DB 未建模开关）。
 * - `requiredCapabilities` 暂为空数组（不在本专题实现工具权限边界）。
 * - 没有 currentVersion 的 skill 跳过（无可用版本,无法被 Resolver 选用）。
 */
export class LocalDbSkillProvider implements SkillProvider {
 async listAvailableSkills(): Promise<SkillSummary[]> {
 const dbSkills = await listActiveSkillsForMatching();
 const out: SkillSummary[] = [];
 for (const sk of dbSkills) {
 const version = await getCurrentSkillVersion(sk.id);
 if (!version) continue;
 out.push({
 skillId: sk.id,
 skillVersionId: version.id,
 namespace: sk.source,
 name: sk.name,
 displayName: sk.name,
 description: sk.description ?? "",
 whenToUse: sk.description ?? "",
 tags: sk.category ? [sk.category] : [],
 source: sk.source,
 visibility: sk.visibility,
 modelInvocable: true,
 uiVisible: true,
 requiredCapabilities: [],
 contentHash: version.commitSha ?? null,
 version: String(version.version),
 });
 }
 return out;
 }
}

/**
 * 默认 SkillProvider 单例（02 文档 §六.1：只返回本地 Provider）。
 * 进程内复用,避免每次 run 重建。
 */
let defaultProvider: SkillProvider | null = null;

export function getSkillProvider(): SkillProvider {
 if (!defaultProvider) {
 defaultProvider = new LocalDbSkillProvider();
 }
 return defaultProvider;
}

/** 测试用：注入自定义 Provider。 */
export function __setSkillProviderForTest(provider: SkillProvider | null): void {
 defaultProvider = provider;
}
