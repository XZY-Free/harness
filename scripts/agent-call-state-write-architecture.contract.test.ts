import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const AUTHORITY = "lib/agents/calls/persistence/apply-agent-call-transition.ts";

describe("AgentCall 状态写 Authority", () => {
  it("生产代码只有统一转换持久化入口可直接更新 AgentCall", () => {
    const files = execFileSync("rg", ["--files", "lib", "app", "scripts", "-g", "*.ts"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
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
