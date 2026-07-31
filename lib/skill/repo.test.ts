import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SkillRepoError,
  SkillValidationError,
  assertValidSkillName,
  commitSkillVersion,
  createSkillDir,
  diffSkill,
  listSkillFiles,
  readSkillFile,
  readSkillFileAtSha,
  skillDirExists,
  validateSkill,
  writeSkillFile,
} from "./repo";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skill-repo-"));
  process.env.SNOW_SKILLS_DIR = dir;
});
afterEach(async () => {
  Reflect.deleteProperty(process.env, "SNOW_SKILLS_DIR");
  await rm(dir, { recursive: true, force: true });
});

describe("assertValidSkillName", () => {
  it("接受标准 name", () => {
    expect(() => assertValidSkillName("build-from-idea")).not.toThrow();
    expect(() => assertValidSkillName("a")).not.toThrow();
  });
  it("拒绝非法 name", () => {
    expect(() => assertValidSkillName("Bad Name")).toThrow(SkillRepoError);
    expect(() => assertValidSkillName("UPPER")).toThrow(SkillRepoError);
    expect(() => assertValidSkillName("../x")).toThrow(SkillRepoError);
    expect(() => assertValidSkillName("")).toThrow(SkillRepoError);
  });
});

describe("skill 目录仓库", () => {
  it("写文件 → 发布版本 → 按 sha 读到内容", async () => {
    await writeSkillFile(
      "my-skill",
      "SKILL.md",
      "---\nname: my-skill\ndescription: 测试\n---\n# 正文\n",
    );
    const sha = await commitSkillVersion("my-skill", "v1");
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
    const content = await readSkillFileAtSha("my-skill", "SKILL.md", sha);
    expect(content).toContain("# 正文");
  });

  it("改工作副本不影响历史 sha 快照（§10 不回归）", async () => {
    // S1（11-P1-5）：SKILL.md 须合法 frontmatter 通过校验;body 部分用于快照对比
    const md1 = "---\nname: s2\ndescription: v1\n---\nv1 内容\n";
    const md2 = "---\nname: s2\ndescription: v2\n---\nv2 内容\n";
    await writeSkillFile("s2", "SKILL.md", md1);
    const sha1 = await commitSkillVersion("s2", "v1");
    await writeSkillFile("s2", "SKILL.md", md2);
    const sha2 = await commitSkillVersion("s2", "v2");
    expect(await readSkillFileAtSha("s2", "SKILL.md", sha1)).toBe(md1);
    expect(await readSkillFileAtSha("s2", "SKILL.md", sha2)).toBe(md2);
    expect(await readSkillFile("s2", "SKILL.md")).toBe(md2);
  });

  it("diff 两版本", async () => {
    await writeSkillFile("s3", "SKILL.md", "---\nname: s3\ndescription: aaa\n---\naaa\n");
    const sha1 = await commitSkillVersion("s3", "v1");
    await writeSkillFile("s3", "SKILL.md", "---\nname: s3\ndescription: bbb\n---\nbbb\n");
    const sha2 = await commitSkillVersion("s3", "v2");
    const d = await diffSkill("s3", sha1, sha2);
    expect(d).toContain("-aaa");
    expect(d).toContain("+bbb");
  });

  it("无改动发布抛错", async () => {
    await writeSkillFile("s4", "SKILL.md", "---\nname: s4\ndescription: x\n---\nx\n");
    await commitSkillVersion("s4", "v1");
    await expect(commitSkillVersion("s4", "v2")).rejects.toThrow(SkillRepoError);
  });

  it("路径越界拒绝", async () => {
    await expect(writeSkillFile("s5", "../escape.txt", "x")).rejects.toThrow(SkillRepoError);
    await expect(readSkillFile("s5", "../../etc/passwd")).rejects.toThrow(SkillRepoError);
  });

  it("listSkillFiles 跳过 .git", async () => {
    await writeSkillFile("s6", "SKILL.md", "---\nname: s6\ndescription: x\n---\nx\n");
    await writeSkillFile("s6", "refs/a.md", "y");
    await commitSkillVersion("s6", "v1");
    const files = await listSkillFiles("s6");
    expect(files.sort()).toEqual(["SKILL.md", "refs/a.md"]);
  });

  it("skillDirExists", async () => {
    expect(await skillDirExists("s7")).toBe(false);
    await createSkillDir("s7");
    expect(await skillDirExists("s7")).toBe(true);
  });
});

// S1（11-P1-5）：发布校验阻断
describe("validateSkill - 发布校验", () => {
  it("合规 SKILL.md → 通过(不抛)", () => {
    expect(() => validateSkill("---\nname: my-skill\ndescription: 测试\n---\nbody")).not.toThrow();
  });

  it("缺 name → 抛 SkillValidationError", () => {
    expect(() => validateSkill("---\ndescription: x\n---\nbody")).toThrow(SkillValidationError);
  });

  it("缺 description → 抛 SkillValidationError", () => {
    expect(() => validateSkill("---\nname: s\n---\nbody")).toThrow(SkillValidationError);
  });

  it("缺 frontmatter → 抛 SkillValidationError(包装 parseSkillMd 错误)", () => {
    expect(() => validateSkill("无 frontmatter")).toThrow(SkillValidationError);
  });

  it("非法 YAML → 抛 SkillValidationError", () => {
    expect(() => validateSkill("---\nname: 'unclosed\n---\nbody")).toThrow(SkillValidationError);
  });

  it("未知 tools → 抛 SkillValidationError", () => {
    const known = new Set(["readFile", "writeFile"]);
    expect(() =>
      validateSkill("---\nname: s\ndescription: d\ntools: [readFile, badTool]\n---\nbody", known),
    ).toThrow(SkillValidationError);
  });

  it("已知 tools → 通过", () => {
    const known = new Set(["readFile", "writeFile"]);
    expect(() =>
      validateSkill("---\nname: s\ndescription: d\ntools: [readFile, writeFile]\n---\nbody", known),
    ).not.toThrow();
  });
});

describe("commitSkillVersion - 校验阻断发布", () => {
  it("工作副本 SKILL.md 缺 description → 阻断 commit(抛 SkillValidationError)", async () => {
    // 写一个缺 description 的 SKILL.md
    await writeSkillFile("bad-skill", "SKILL.md", "---\nname: bad-skill\n---\nbody");
    await expect(commitSkillVersion("bad-skill", "v1")).rejects.toThrow(SkillValidationError);
  });

  it("工作副本 SKILL.md 缺 frontmatter → 阻断 commit", async () => {
    await writeSkillFile("bad-skill-2", "SKILL.md", "无 frontmatter 内容");
    await expect(commitSkillVersion("bad-skill-2", "v1")).rejects.toThrow(SkillValidationError);
  });

  it("合规 SKILL.md → 正常 commit", async () => {
    await writeSkillFile(
      "good-skill",
      "SKILL.md",
      "---\nname: good-skill\ndescription: 测试\n---\nbody",
    );
    const sha = await commitSkillVersion("good-skill", "v1");
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
  });
});
