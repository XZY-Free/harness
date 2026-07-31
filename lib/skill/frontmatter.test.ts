import { describe, expect, it } from "vitest";
import { buildSkillMd, parseSkillMd } from "./frontmatter";
import { SkillRepoError } from "./repo";

describe("buildSkillMd / parseSkillMd - 基本往返", () => {
  it("往返一致(含 tools/model/runtime)", () => {
    const md = buildSkillMd(
      {
        name: "my-skill",
        description: "测试 skill",
        tools: ["readFile", "writeFile"],
        model: "kimi",
        runtime: "host",
      },
      "正文内容",
    );
    const fm = parseSkillMd(md);
    expect(fm.name).toBe("my-skill");
    expect(fm.description).toBe("测试 skill");
    expect(fm.tools).toEqual(["readFile", "writeFile"]);
    expect(fm.model).toBe("kimi");
    expect(fm.runtime).toBe("host");
  });

  it("description 含冒号被正确序列化与解析(js-yaml 自动处理)", () => {
    const md = buildSkillMd({ name: "s", description: "做:一件事", tools: [] }, "x");
    const fm = parseSkillMd(md);
    expect(fm.description).toBe("做:一件事");
  });

  it("description 含特殊字符(引号/换行/井号)", () => {
    const md = buildSkillMd({ name: "s", description: '含"引号"和#井号', tools: [] }, "x");
    const fm = parseSkillMd(md);
    expect(fm.description).toBe('含"引号"和#井号');
  });

  it("无 tools → tools 为空数组", () => {
    const md = buildSkillMd({ name: "s", description: "d", tools: [] }, "x");
    const fm = parseSkillMd(md);
    expect(fm.tools).toEqual([]);
  });
});

describe("parseSkillMd - js-yaml 解析能力", () => {
  it("多行 description(YAML 块标量)", () => {
    const md = "---\nname: s\ndescription: |\n  第一行描述\n  第二行描述\n---\nbody";
    const fm = parseSkillMd(md);
    expect(fm.description).toContain("第一行描述");
    expect(fm.description).toContain("第二行描述");
  });

  it("tools 列表(YAML 内联数组)", () => {
    const md = "---\nname: s\ndescription: d\ntools: [readFile, writeFile, runCommand]\n---\nbody";
    const fm = parseSkillMd(md);
    expect(fm.tools).toEqual(["readFile", "writeFile", "runCommand"]);
  });

  it("tools 列表(YAML 块数组)", () => {
    const md = "---\nname: s\ndescription: d\ntools:\n  - readFile\n  - writeFile\n---\nbody";
    const fm = parseSkillMd(md);
    expect(fm.tools).toEqual(["readFile", "writeFile"]);
  });

  it("tools 逗号分隔字符串(兼容旧格式)", () => {
    const md = "---\nname: s\ndescription: d\ntools: readFile,writeFile\n---\nbody";
    const fm = parseSkillMd(md);
    expect(fm.tools).toEqual(["readFile", "writeFile"]);
  });

  it("嵌套对象:额外字段被忽略,已知字段正确提取", () => {
    const md =
      "---\nname: s\ndescription: d\nextra:\n  nested: value\n  foo: bar\nmodel: kimi\n---\nbody";
    const fm = parseSkillMd(md);
    expect(fm.name).toBe("s");
    expect(fm.description).toBe("d");
    expect(fm.model).toBe("kimi");
  });

  it("description 缺失 → 退回 name", () => {
    const md = "---\nname: my-skill\n---\nbody";
    const fm = parseSkillMd(md);
    expect(fm.name).toBe("my-skill");
    expect(fm.description).toBe("my-skill");
  });

  it("空 frontmatter(---\\n---)→ 抛错", () => {
    expect(() => parseSkillMd("---\n---\nbody")).toThrow(SkillRepoError);
  });

  it("无 frontmatter → 抛错", () => {
    expect(() => parseSkillMd("无 frontmatter")).toThrow(SkillRepoError);
  });

  it("缺 name → 抛错", () => {
    expect(() => parseSkillMd("---\ndescription: x\n---\nbody")).toThrow(SkillRepoError);
  });

  it("name 为空字符串 → 抛错", () => {
    expect(() => parseSkillMd("---\nname: ''\n---\nbody")).toThrow(SkillRepoError);
  });

  it("非法 name(含空格/大写)→ 抛错", () => {
    expect(() => parseSkillMd("---\nname: 'Bad Name'\n---\nbody")).toThrow(SkillRepoError);
    expect(() => parseSkillMd("---\nname: UPPER\n---\nbody")).toThrow(SkillRepoError);
  });

  it("非法 YAML → 抛 SkillRepoError(不抛 js-yaml 原生错误)", () => {
    // 未闭合引号是非法 YAML
    const md = "---\nname: 'unclosed\n---\nbody";
    expect(() => parseSkillMd(md)).toThrow(SkillRepoError);
    try {
      parseSkillMd(md);
    } catch (e) {
      expect((e as Error).message).toContain("YAML 解析失败");
    }
  });

  it("frontmatter 为 YAML 数组(非对象)→ 抛错", () => {
    const md = "---\n- a\n- b\n---\nbody";
    expect(() => parseSkillMd(md)).toThrow(SkillRepoError);
  });
});
