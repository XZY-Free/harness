import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const AUTHORITY = "lib/agents/calls/persistence/apply-agent-call-transition.ts";

/**
 * 递归收集目录下全部 .ts 文件（不含 .test.ts、不含 node_modules/.next/dist/build）。
 * 使用 node fs 而非 rg 二进制：合同测试必须在没有 ripgrep 的环境也能运行
 * （MEMORY.md 记录：本机 rg 仅 shell alias，child_process 报 ENOENT）。
 */
function collectSourceFiles(root: string): string[] {
  const absolute = resolve(ROOT, root);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (["node_modules", ".git", ".next", ".next-e2e", "dist", "build"].includes(entry)) {
        continue;
      }
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".ts")) continue;
      if (full.endsWith(".test.ts")) continue;
      out.push(relative(ROOT, full));
    }
  };
  walk(absolute);
  return out;
}

describe("AgentCall 状态写 Authority", () => {
  it("生产代码只有统一转换持久化入口可直接更新 AgentCall", () => {
    const files = ["lib", "app", "scripts"]
      .flatMap(collectSourceFiles)
      .filter(
        (file) =>
          file &&
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
