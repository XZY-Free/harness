/**
 * 生产接线 contract 用例。
 *
 * 断言本体不在这里：规则唯一实现是 `scripts/production-wiring-rules.ts`，
 * 与验收计划 `production-wiring` 阶段的入口 `scripts/production-wiring.ts` 共用同一套
 * 检查。本文件只负责在 contract 组里对**真实生产文档**逐条取证，并证明规则不是空转。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_WIRING_CHECKS,
  type SourceDocument,
  loadProductionWiringDocuments,
} from "./production-wiring-rules";

const documents = loadProductionWiringDocuments(process.cwd());

function runWiringCheck(id: string): string[] {
  const entry = PRODUCTION_WIRING_CHECKS.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`未知的生产接线检查：${id}`);
  return entry.run(documents);
}

describe("Topic 01 production wiring", () => {
  it("Web 与 Worker 标准镜像均在目标平台构建并复制 workspace-lock provider", () => {
    for (const dockerfile of ["Dockerfile", "docker/worker/Dockerfile"]) {
      const source = readFileSync(dockerfile, "utf8");
      expect(source, `${dockerfile} 必须在镜像构建阶段编译原生 provider`).toContain(
        "pnpm build:workspace-lock",
      );
      expect(source, `${dockerfile} 必须把目标平台产物带入运行镜像`).toMatch(
        /COPY\s+--from=\S+\s+\/app\/native\s+\.\/native/,
      );
    }
  });

  it("检查清单固定为 10 条，编号唯一且标题不重复", () => {
    const ids = PRODUCTION_WIRING_CHECKS.map((entry) => entry.id);
    expect(ids).toEqual([
      "PW-01",
      "PW-02",
      "PW-03",
      "PW-04",
      "PW-05",
      "PW-06",
      "PW-07",
      "PW-08",
      "PW-09",
      "PW-10",
    ]);
    expect(new Set(PRODUCTION_WIRING_CHECKS.map((entry) => entry.title)).size).toBe(ids.length);
    // 真实仓库必须读得到生产文档，否则下面的「零违规」都不可能成立。
    expect(documents.length).toBeGreaterThan(0);
    for (const required of [
      "lib/workers/production-worker-role.ts",
      "deploy/production/compose.yaml",
      "package.json",
    ]) {
      expect(
        documents.some((document) => document.path === required),
        `生产文档集合缺少 ${required}`,
      ).toBe(true);
    }
  });

  it("shared production executor registers tool.call through the ToolCall application service", () => {
    expect(runWiringCheck("PW-01")).toEqual([]);
  });

  it("Tool worker 真实拥有 Provider、Effect 与 durable continuation", () => {
    expect(runWiringCheck("PW-02")).toEqual([]);
  });

  it("Hosted and External paths use the same catalog-aware production factory", () => {
    expect(runWiringCheck("PW-03")).toEqual([]);
  });

  it("Harness validates every action against the frozen catalog before executor dispatch", () => {
    expect(runWiringCheck("PW-04")).toEqual([]);
  });

  it("identity wiring freezes once and recovers the trusted subject through ExecutionBinding without gateway fallback", () => {
    expect(runWiringCheck("PW-05")).toEqual([]);
  });

  it("AgentCall ingress、取消与用户恢复共用唯一状态转换入口", () => {
    expect(runWiringCheck("PW-06")).toEqual([]);
  });

  it("Continuation worker 进入正式启动入口并调用唯一 Harness resume 能力", () => {
    expect(runWiringCheck("PW-07")).toEqual([]);
  });

  it("External Runtime 默认生产入口创建绑定 HTTP transport 且不回退 Hosted", () => {
    expect(runWiringCheck("PW-08")).toEqual([]);
  });

  it("Runtime retry 默认 lane 调用持久化 Attempt 服务而不是伪造失败", () => {
    expect(runWiringCheck("PW-09")).toEqual([]);
  });

  it("四类 durable Worker 都由统一生产 role factory 与镜像入口启动", () => {
    expect(runWiringCheck("PW-10")).toEqual([]);
  });

  it("规则不是空转：文档集合为空时每一条检查都必须报错", () => {
    // 空集合 = 所有目标文件都读不到。每条规则都必须报出「接线目标文件缺失」，
    // 否则说明该规则在空输入上恒真，上面的「零违规」就不能作证据。
    for (const entry of PRODUCTION_WIRING_CHECKS) {
      expect(
        entry.run([] as readonly SourceDocument[]).length,
        `${entry.id} 在空文档集合下没有报错`,
      ).toBeGreaterThan(0);
    }
  });
});
