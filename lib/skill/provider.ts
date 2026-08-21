/**
 * SkillProvider：Skill 候选来源的统一接口（02 文档 §六.1，关口02 02-4 Tenant 化）。
 *
 * 设计目标：
 * - 把"有哪些 Skill 可用"从 `/api/chat` 中抽出,由 Provider 统一回答。
 * - Resolver 只接收 `SkillSummary`（摘要）,**不读取完整 `SKILL.md`**（懒加载由
 * `readSkillFile` 在选中后完成,只读本地 git 快照）。
 * - `availableSkills` 是 Resolver 的**唯一候选集合**;只来自本地 DB 中 enabled 的 Skill。
 * - 运行时不访问 capability-market:capability-market 只在后台同步模块出现,同步后的 Skill
 * 是本地镜像（source=capability_market）,与本地自建 Skill 一样从本地 DB + 本地 contentRef 读取。
 * - 没有默认 Skill:`build-from-idea` 只是一个普通 skill,不作为兜底运行策略。
 *
 * Tenant 化（02-4 契约）：Provider 事实源是正式 skill 仓储（tenant-scoped）。
 * `listAvailableSkills(tenantId)` 由调用方（/api/skills 等已解析 Principal 的入口）传入 tenantId,
 * 经 listSkillsForMatching 按 tenantId 隔离；禁止全局扫描。
 */

import { getCurrentSkillVersion, listSkillsForMatching } from "@/lib/capability/skill-queries";
import type { SkillSourceType } from "@/lib/persistence/schema/skill";

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
  /** 来源命名空间（local / capability_market）。 */
  namespace: string;
  /** 唯一短名（skillKey）,用于展示和日志。 */
  name: string;
  /** 中文展示名。 */
  displayName: string;
  /** 简短描述。 */
  description: string;
  /** 使用条件（Resolver 关键词匹配的主要来源）。 */
  whenToUse: string;
  /** 搜索和辅助匹配标签。 */
  tags: string[];
  /** 来源：local（本地自建）/ capability_market（同步镜像）。运行时两者读取路径一致。 */
  source: SkillSourceType;
  /** 可见性描述。 */
  visibility: string;
  /** 是否允许模型自动选择（false 时只接受 UI 显式选择）。 */
  modelInvocable: boolean;
  /** 是否展示给用户选择。 */
  uiVisible: boolean;
  /** 能力声明（不是工具白名单;工具权限归 Tools / Policy 专题）。 */
  requiredCapabilities: string[];
  /** 版本内容 hash（目录形态下即 skills/ git repo 的 commit 派生 hash）。 */
  contentHash: string | null;
  /** 当前可用版本号（正式 versionNo 是 int,转字符串保留可比较性）。 */
  version: string;
}

/**
 * Skill 候选来源接口。
 * 02 文档 §六.1：运行时候选列表只来自本地 active Skill（LocalDbSkillProvider）,
 * 不再有运行时远程 Provider。tenantId 由调用方传入。
 */
export interface SkillProvider {
  /** 列出指定租户内可见、可用的 Skill 摘要（本地 enabled Skill,同步 Skill 需绑定 active）。 */
  listAvailableSkills(tenantId: string): Promise<SkillSummary[]>;
}

/**
 * 本地 DB Skill 适配器：唯一的运行时 Provider（02 文档 §六.1）。
 *
 * 把当前 DB registry（正式 Skill + SkillVersion.currentVersionId）映射为 `SkillSummary`。
 * `listSkillsForMatching` 已按来源过滤：同步 Skill 仅在绑定 syncState=active 时返回。
 *
 * 映射规则：
 * - `namespace` / `source` = `sk.sourceType`（local 或 capability_market）。
 * - `whenToUse` 复用 `skill.description`（正式 Skill 未单独建模 whenToUse）。
 * - `tags` 暂为空（正式模型未建模 category）。
 * - `contentHash` = 版本 `contentHash`。
 * - `modelInvocable` / `uiVisible` 默认 true（DB 未建模开关）。
 * - `requiredCapabilities` 暂为空数组（不在本专题实现工具权限边界）。
 * - 没有 currentVersion 的 skill 跳过（无可用版本,无法被 Resolver 选用）。
 */
export class LocalDbSkillProvider implements SkillProvider {
  async listAvailableSkills(tenantId: string): Promise<SkillSummary[]> {
    const dbSkills = await listSkillsForMatching(tenantId);
    const out: SkillSummary[] = [];
    for (const sk of dbSkills) {
      const version = await getCurrentSkillVersion({ tenantId, skillId: sk.id });
      if (!version) continue;
      out.push({
        skillId: sk.id,
        skillVersionId: version.id,
        namespace: sk.sourceType,
        name: sk.skillKey,
        displayName: sk.displayName,
        description: sk.description ?? "",
        whenToUse: sk.description ?? "",
        tags: [],
        source: sk.sourceType as SkillSourceType,
        visibility: sk.visibilityScope,
        modelInvocable: true,
        uiVisible: true,
        requiredCapabilities: [],
        contentHash: version.contentHash,
        version: String(version.versionNo),
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
