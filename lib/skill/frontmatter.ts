import { dump as yamlDump, load as yamlLoad } from "js-yaml";
import { SkillRepoError, assertValidSkillName } from "./repo";

/** SKILL.md frontmatter 解析结果（Agent Skills 标准 name/description + 扩展 tools/model/runtime）。 */
export interface SkillFrontmatter {
 name: string;
 description: string;
 tools: string[];
 model?: string | null;
 runtime?: string | null;
}

/**
 * 生成 SKILL.md 内容（YAML frontmatter + 正文）。
 *
 * 用 js-yaml.dump 序列化 frontmatter,替代手写 escape。
 * 保持 buildSkillMd 输出与 parseSkillMd 严格往返一致。
 */
export function buildSkillMd(meta: SkillFrontmatter, body: string): string {
 // frontmatter 字段顺序固定(name → description → tools → model → runtime),与历史格式一致
 const fm: Record<string, unknown> = {
 name: meta.name,
 description: meta.description || meta.name,
 };
 if (meta.tools.length) fm.tools = meta.tools;
 if (meta.model) fm.model = meta.model;
 if (meta.runtime) fm.runtime = meta.runtime;
 // lineWidth:-1 避免长描述被折行(lineWidth 默认 80 会截断中文描述)
 // quoteStyle:'double' 含冒号/特殊字符的字段用双引号包裹(js-yaml 5.x 用 quoteStyle 替代 4.x quotingType)
 const yamlStr = yamlDump(fm, { lineWidth: -1, quoteStyle: "double" });
 return `---\n${yamlStr}---\n\n${body}`;
}

/**
 * 解析 SKILL.md frontmatter。
 *
 * 改用 js-yaml.load 解析,替代原正则 + startsWith 按行取值。
 * 修复原方案无法处理多行描述、列表、嵌套对象、引号转义等问题。
 *
 * @throws SkillRepoError 缺 frontmatter / 缺 name / 非法 YAML / name 不合法
 */
export function parseSkillMd(content: string): SkillFrontmatter {
 const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
 if (!m) throw new SkillRepoError("SKILL.md 缺少 frontmatter（--- ... ---）");
 const yamlText = m[1] ?? "";
 const bodyText = m[2] ?? "";

 let parsed: unknown;
 try {
 parsed = yamlLoad(yamlText);
 } catch (e) {
 throw new SkillRepoError(
 `SKILL.md frontmatter YAML 解析失败: ${e instanceof Error ? e.message : String(e)}`,
 );
 }
 // 空 frontmatter(---\n---)→ parsed 为 undefined
 if (parsed === null || parsed === undefined) {
 throw new SkillRepoError("SKILL.md frontmatter 为空");
 }
 if (typeof parsed !== "object" || Array.isArray(parsed)) {
 throw new SkillRepoError("SKILL.md frontmatter 须为 YAML 对象");
 }
 const obj = parsed as Record<string, unknown>;

 const nameRaw = obj.name;
 if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
 throw new SkillRepoError("SKILL.md frontmatter 缺少 name");
 }
 const name = nameRaw.trim();
 assertValidSkillName(name);

 const descriptionRaw = obj.description;
 const description = typeof descriptionRaw === "string" ? descriptionRaw : name;

 // tools 支持两种形式:YAML 内联数组 [a,b] 或逗号分隔字符串 "a,b"
 const toolsRaw = obj.tools;
 let tools: string[] = [];
 if (Array.isArray(toolsRaw)) {
 tools = toolsRaw
 .map((t) => (typeof t === "string" ? t.trim() : String(t).trim()))
 .filter(Boolean);
 } else if (typeof toolsRaw === "string") {
 tools = toolsRaw
 .split(",")
 .map((s) => s.trim())
 .filter(Boolean);
 }

 const modelRaw = obj.model;
 const runtimeRaw = obj.runtime;

 return {
 name,
 description,
 tools,
 model: typeof modelRaw === "string" ? modelRaw : null,
 runtime: typeof runtimeRaw === "string" ? runtimeRaw : null,
 };
}
