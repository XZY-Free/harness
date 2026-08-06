/**
 * SkillRuntimeContext —— 运行期 Skill 上下文（02 文档 §六.2）。
 *
 * 02 文档后运行时只保留本地分支：Resolver 选中的 Skill 一定是本地 DB 行（本地自建或同步镜像）,
 * 从 DB `Skill` / `SkillVersion` 行装载完整字段（commitSha / promptTemplate /
 * completionCriteria / defaultModelProfile / runtimeType / requiredCapabilities）。
 * `readSkillFile` 只读本地 git 快照,不再有 enterprise 远程读取分支。
 *
 * `source` 字段保留用于 Studio 权限拦截（同步 Skill 只读）,运行时读取路径与 local 一致。
 */
export interface SkillRuntimeContext {
 /** 来源：local（本地自建）/ capability-market（同步镜像）。运行时读取无差异。 */
 source: "local" | "capability-market";
 skillId: string;
 skillVersionId: string;
 name: string;
 description: string;
 /**
 * 本地 git commit sha（readSkillFile 读历史快照的键）。
 * 迁移期旧版本可能为 null（仅有 promptTemplate）,此时不挂 readSkillFile,回退 promptTemplate。
 */
 commitSha: string | null;
 /** 迁移期旧版本可能只有 promptTemplate（无 commitSha）;目录形态新版本此字段为空。 */
 promptTemplate: string | null;
 /** 完成判定软约束（JSON）,注入 system prompt 尾部。 */
 completionCriteria: unknown;
 /** 默认模型 profile（最低优先级）。 */
 defaultModelProfile: string | null;
 /** 声明的运行时类型（host / container）,null → 回退全局默认。 */
 runtimeType: string | null;
 /** 能力声明（不限制工具可见性,仅审计）。 */
 requiredCapabilities: string[];
 /** 版本号（本地是 int 转 string）。 */
 version: string;
 /** 版本内容 hash（本地无独立 contentHash,沿用 commitSha）。 */
 contentHash: string | null;
}
