import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const AUTHORITY = "lib/agents/calls/persistence/apply-agent-call-transition.ts";

/** 递归列出目录下全部 .ts 文件（相对 ROOT 的 posix 路径），不依赖外部 rg 二进制。 */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listTsFiles(relative));
    else if (entry.name.endsWith(".ts")) out.push(relative);
  }
  return out;
}

describe("AgentCall 状态写 Authority", () => {
  it("生产代码只有统一转换持久化入口可直接更新 AgentCall", () => {
    const files = [...listTsFiles("lib"), ...listTsFiles("app"), ...listTsFiles("scripts")].filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        file !== AUTHORITY &&
        file !== "lib/persistence/schema/agent-calls.ts",
    );
    const offenders = files.filter((file) => {
      const text = readFileSync(resolve(ROOT, file), "utf8");
      return /update\(agentCallTable\)[\s\S]{0,500}\.set\(\{[\s\S]{0,300}\bstate\s*:/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("Ingress、取消与用户恢复都接入统一转换服务", () => {
    const ingress = readFileSync(
      resolve(ROOT, "lib/agents/calls/application/ingest-agent-call-events.ts"),
      "utf8",
    );
    const cancel = readFileSync(
      resolve(ROOT, "lib/agents/calls/application/cancel-agent-call.ts"),
      "utf8",
    );
    const resume = readFileSync(
      resolve(ROOT, "lib/agents/calls/application/resume-agent-call.ts"),
      "utf8",
    );
    expect(ingress).toContain("applyAgentCallEvent");
    expect(cancel).toContain("transitionAgentCall");
    expect(resume).toContain("transitionAgentCall");
    expect(ingress).not.toContain("coordinateAgentInputRequired");
  });
});
