/**
 * Topic02 收尾 GATE-01..GATE-05 关闭门禁。
 *
 * 权威定义：`docs/topic02/nexharness-topic02-closure/acceptance/gate.md`
 * 机器清单：`docs/topic02/nexharness-topic02-closure/manifests/tests.json`（GATE-01..GATE-05）
 *
 * 本文件只做**闭合判定**：所有断言都必须真实读到生产事实（默认入口矩阵、真实 Durable
 * Worker 角色、真实 MySQL schema、真实静态规则函数、真实验收合同），不得用「文件存在」
 * 或「标题里写了 case id」冒充通过。
 *
 * 分层说明：本文件按机器清单（docs/topic-01/evidence/test-collection.json）落入
 * **db** project（needsDB=true、serial=true）——该 project 由 globalSetup 起真实 MySQL
 * 容器并跑最终 Migration，singleFork 串行执行；file-setup 只在文件结束时释放连接池，
 * 不做统一重置（重置由各测试文件自行 beforeEach 调用 resetDatabase）。本文件因此只读
 * schema 事实（information_schema）、只做幂等的角色就绪检查，不写业务事实、不依赖干净数据。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { db } from "@/lib/db/client";
import {
  PUBLICATION_CONFORMANCE_SUITE_REVISION,
  PUBLICATION_DECLARATION_CASE_IDS,
} from "@/lib/runtime/domain/runtime-conformance-contract";
import { validateRuntimePublicationConformanceEvidence } from "@/lib/runtime/domain/runtime-conformance-eligibility";
import {
  PUBLICATION_CONFORMANCE_CASES,
  PUBLICATION_CONFORMANCE_RECEIPT_KEYS,
  type RuntimeConformanceReport,
  RuntimeConformanceTrustError,
  computeCaseEvidenceDigest,
  computeEvidenceManifestDigest,
  validateRuntimeConformanceReport,
} from "@/lib/runtime/domain/runtime-conformance-run";
import { RUNTIME_PROTOCOL_CONFORMANCE_CASES } from "@/lib/runtime/protocol-conformance";
import {
  type WorkerHealthState,
  checkWorkerDatabase,
  isWorkerLive,
  isWorkerReady,
} from "@/lib/workers/production-worker-process";
import {
  CANONICAL_PRODUCTION_ROLES,
  DURABLE_WORKER_ROLES,
  WORKER_REQUIRED_TABLES,
  createProductionWorkerRole,
  parseDurableWorkerRole,
} from "@/lib/workers/production-worker-role";
import {
  REQUIRED_STAGE_IDS,
  loadCanonicalContracts,
  validateAcceptanceResult,
  validateVerificationPlan,
} from "@/scripts/acceptance-contract.mjs";
import {
  type SourceDocument,
  checkFinalClosureBoundaryGate,
  checkWorkerProductionTopologyGate,
  collectDeprecatedArchitectureViolations,
  collectImplementationHistoryViolations,
  collectRetiredAgentExecutionViolations,
  collectRetiredModuleDependencyViolations,
} from "@/scripts/architecture-gate-rules";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

// ─── 通用：真实生产文档读取（与 scripts/architecture-gate.ts 同口径） ─────

const PRODUCTION_ROOTS = ["app", "components", "desktop", "hooks", "lib", "scripts"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".json", ".md", ".py"]);

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => {
    if ([".git", ".next", "build", "dist", "node_modules", "__pycache__"].includes(entry)) {
      return [];
    }
    return filesUnder(resolve(path, entry));
  });
}

function productionDocuments(): SourceDocument[] {
  return PRODUCTION_ROOTS.flatMap((root) => filesUnder(resolve(ROOT, root)))
    .filter((file) => SOURCE_EXTENSIONS.has(file.slice(file.lastIndexOf("."))))
    .map((file) => ({ path: relative(ROOT, file), source: readFileSync(file, "utf8") }));
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as T;
}

/** 真实 MySQL 只读查询：所有 schema 事实都必须来自 information_schema。 */
async function queryRows<T>(query: SQL): Promise<T[]> {
  const [rows] = await db.execute(query);
  return rows as unknown as T[];
}

async function loadPlan(): Promise<{
  stages: Array<{ id: string; commands: string[][] }>;
  profiles: Record<string, string[]>;
  baselineSha: string;
  resultPath: string;
}> {
  const { plan } = loadCanonicalContracts(ROOT) as {
    plan: {
      stages: Array<{ id: string; commands: string[][] }>;
      profiles: Record<string, string[]>;
      baselineSha: string;
      resultPath: string;
    };
  };
  return plan;
}

// ═══════════════════════════════════════════════════════════════════════════
// GATE-01 — 默认入口端到端矩阵与所有真实 Worker 角色
// ═══════════════════════════════════════════════════════════════════════════

describe("GATE-01 默认入口端到端矩阵与所有真实 Worker 角色", () => {
  it("默认 profile 选择完整端到端矩阵，且每个阶段都由真实可执行命令组成", async () => {
    const plan = await loadPlan();
    validateVerificationPlan(plan);

    // 默认入口就是 acceptance profile；它必须与 verify 共用完整阶段全集，否则
    // 「默认入口」会出现两条不同口径的路径。
    expect(plan.profiles.acceptance).toEqual(plan.profiles.verify);
    for (const required of REQUIRED_STAGE_IDS) {
      expect(plan.profiles.acceptance, `默认入口缺少阶段 ${required}`).toContain(required);
    }

    // 端到端矩阵必须真实驱动 Web / Desktop / 跨客户端三条 lane，且不得拿测试文件冒充。
    for (const stageId of ["e2e-web", "e2e-desktop", "e2e-cross-client"]) {
      const stage = plan.stages.find((candidate) => candidate.id === stageId);
      expect(stage, `验证计划缺少 ${stageId}`).toBeDefined();
      const commands = stage?.commands ?? [];
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.some((command) => command.includes("scripts/playwright-stage.mjs"))).toBe(
        true,
      );
      for (const command of commands) {
        for (const token of command) {
          expect(token, `${stageId} 用测试文件替代了真实端到端消费`).not.toMatch(
            /\.test\.|\.spec\./,
          );
        }
      }
    }

    // 每条命令都必须真实可解析：`pnpm <script>` 的脚本要存在、`node <file>` 的文件要存在。
    // 引用不存在的脚本 = 阶段永远无法运行，而「无法运行的阶段」不得被当作 PASS。
    const pnpmScripts = readJson<{ scripts: Record<string, string> }>("package.json").scripts;
    for (const stage of plan.stages) {
      expect(stage.commands.length, `${stage.id} 是空阶段`).toBeGreaterThan(0);
      for (const [executable, ...args] of stage.commands) {
        expect(executable, `${stage.id} 命令缺少可执行文件名`).toBeTruthy();
        const target = args[0];
        if (!target) throw new Error(`${stage.id} 命令缺少目标参数`);
        if (executable === "pnpm") {
          expect(
            Object.hasOwn(pnpmScripts, target),
            `${stage.id} 引用了不存在的 pnpm 脚本：${target}`,
          ).toBe(true);
        } else if (executable === "node") {
          expect(
            existsSync(resolve(ROOT, target)),
            `${stage.id} 引用了不存在的脚本：${target}`,
          ).toBe(true);
        }
      }
    }
  });

  it("没有手工调用下一步替代消费：生产 Worker 轮询只能由真实 Worker 进程驱动", () => {
    const documents = productionDocuments();
    const sourceOf = (path: string) =>
      documents.find((document) => document.path === path)?.source ?? "";

    // 生产模块里 `createProductionWorkerRole` 的构造点必须唯一且就在 Worker 进程内：
    // 任何生产模块绕过轮询循环自己构造角色并逐次手工调用，都是「手工调用下一步替代消费」。
    // （测试文件构造角色驱动真实 tick 属合法消费，不在本断言范围。）
    const constructionSites = documents
      .filter(
        (document) =>
          !document.path.includes(".test.") &&
          document.path !== "lib/workers/production-worker-role.ts" &&
          document.path !== "scripts/architecture-gate-rules.ts" &&
          document.source.includes("createProductionWorkerRole("),
      )
      .map((document) => document.path);
    expect(constructionSites).toEqual(["lib/workers/production-worker-process.ts"]);

    // 真实消费只允许发生在 Worker 进程的轮询循环里。
    const workerProcess = sourceOf("lib/workers/production-worker-process.ts");
    expect(workerProcess).toMatch(/while\s*\(!stopping\)/);
    expect(workerProcess).toContain("worker.pollOnce()");
    expect(workerProcess).toContain("runProductionWorkerProcess");

    // 默认入口必须走真实进程，且不得把 test-support 拉进默认入口链路。
    expect(sourceOf("scripts/workers/worker-entrypoint.ts")).toContain(
      "runProductionWorkerProcess",
    );
    for (const document of documents) {
      if (!document.path.startsWith("scripts/workers/")) continue;
      expect(
        document.source.includes("test-support"),
        `${document.path} 在默认入口链路上引用了测试替身`,
      ).toBe(false);
    }
  });

  it("每个真实 Durable Worker 角色都能启动并在真实 MySQL 上就绪", async () => {
    // 角色集合必须与生产拓扑一致：web-api 不是 Durable 角色。
    expect([...DURABLE_WORKER_ROLES].sort()).toEqual(
      [...CANONICAL_PRODUCTION_ROLES].filter((role) => role !== "web-api").sort(),
    );

    const inventory = readJson<{ tables: Array<{ physicalTableName: string }> }>(
      "docs/topic-01/evidence/schema-inventory.json",
    );
    const canonicalTables = new Set(inventory.tables.map((entry) => entry.physicalTableName));

    for (const role of DURABLE_WORKER_ROLES) {
      // 角色名必须被正式解析器接受；非法名必须 fail closed。
      expect(parseDurableWorkerRole(role)).toBe(role);
      expect(() => parseDurableWorkerRole("not-a-role")).toThrow();

      // 启动就绪检查必须覆盖它真实读写的全部对象，且这些对象必须是 canonical 表：
      // 缺表环境不允许「启动成功」却在首次 tick 才失败。
      for (const table of WORKER_REQUIRED_TABLES[role]) {
        expect(canonicalTables.has(table), `${role} 声明了非 canonical 表：${table}`).toBe(true);
      }
      await checkWorkerDatabase(role);

      // 启动：真实构造生产消费者，并能重复停止而不抛错。
      const constructed = createProductionWorkerRole(role);
      expect(constructed.role).toBe(role);
      expect(typeof constructed.pollOnce).toBe("function");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(() => constructed.stop()).not.toThrow();
      }
    }
  });

  it("每角色可恢复：健康判定要求真实轮询成功，崩溃或静默超期即不就绪", () => {
    const now = new Date("2026-09-18T00:00:00.000Z");
    const fresh: WorkerHealthState = {
      role: "job-worker",
      startedAt: now,
      lastLoopPulseAt: now,
      lastSuccessfulPollAt: null,
      loopCrashed: false,
    };
    // 还没有一次成功轮询 → 不可就绪（恢复必须由真实消费驱动，不能靠自报健康）。
    expect(isWorkerReady(fresh, true, now)).toBe(false);
    expect(isWorkerLive(fresh, now)).toBe(true);

    const polled: WorkerHealthState = { ...fresh, lastSuccessfulPollAt: now };
    expect(isWorkerReady(polled, true, now)).toBe(true);
    // 数据库不可读写 → 不可就绪。
    expect(isWorkerReady(polled, false, now)).toBe(false);
    // 成功轮询超过窗口 → 不可就绪（掉线）。
    expect(isWorkerReady(polled, true, new Date(now.getTime() + 31_000))).toBe(false);

    // 循环崩溃 → 既不 live 也不 ready（必须真实重启，不能自愈式假活）。
    const crashed: WorkerHealthState = { ...polled, loopCrashed: true };
    expect(isWorkerLive(crashed, now)).toBe(false);
    expect(isWorkerReady(crashed, true, now)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GATE-02 — 仅旧 case 或全 true 声明的 Conformance 报告
// ═══════════════════════════════════════════════════════════════════════════

/** 按合同逐 case 生成**真实回执**（非 boolean 占位），用于构造合规报告。 */
function receiptFor(caseId: string): Record<string, unknown> {
  const keys =
    PUBLICATION_CONFORMANCE_RECEIPT_KEYS[
      caseId as keyof typeof PUBLICATION_CONFORMANCE_RECEIPT_KEYS
    ];
  const receipt: Record<string, unknown> = {};
  for (const key of keys) {
    receipt[key] = key === "call" ? "probeCapabilities" : `conformance-receipt:${caseId}:${key}`;
  }
  return receipt;
}

/** 构造一份 digest 自洽的报告；case 证据由调用方给出。 */
function buildReport(
  cases: Array<{ caseId: string; passed: boolean; evidence: Record<string, unknown> }>,
): RuntimeConformanceReport {
  const runnerArtifactDigest = `sha256:${"c".repeat(64)}`;
  // 报告内所有 sha256 摘要都必须是真实 64-hex —— 否则会先因「非法 sha256 digest」被拒，
  // 让「缺真实调用回执」这条断言为错误的理由通过。
  const runtimeTargetDigest = `sha256:${"1".repeat(64)}`;
  const runtimeConfigDigest = `sha256:${"2".repeat(64)}`;
  const caseResults = cases.map((entry) => ({
    caseId: entry.caseId as RuntimeConformanceReport["caseResults"][number]["caseId"],
    passed: entry.passed,
    reason: null,
    evidenceDigest: computeCaseEvidenceDigest(entry.evidence),
    evidence: entry.evidence,
  }));
  // evidenceManifestDigest 必须 canonical 绑定报告内容，否则报告会先因摘要不一致被拒，
  // 让回执校验形同虚设（测试会为错误的理由通过）。
  const evidenceManifestDigest = computeEvidenceManifestDigest({
    suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
    testEnvironmentRevision: "isolated-mysql8@1",
    runtimeRevisionId: "revision-1",
    runtimeTargetDigest,
    runtimeConfigDigest,
    protocolContractDigest: "agent-runtime-protocol@1",
    runnerArtifactDigest,
    cases: caseResults.map((result) => ({
      caseId: result.caseId,
      passed: result.passed,
      evidenceDigest: result.evidenceDigest,
    })),
  });
  return {
    runId: "run-1",
    runtimeRevisionId: "revision-1",
    runtimeTargetDigest,
    runtimeConfigDigest,
    protocolContractDigest: "agent-runtime-protocol@1",
    suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
    runnerArtifactDigest,
    runnerIdentity: "gate-runner",
    testEnvironmentRevision: "isolated-mysql8@1",
    startedAt: "2026-09-18T00:00:00.000Z",
    completedAt: "2026-09-18T00:00:01.000Z",
    overallResult: "passed",
    evidenceManifestDigest,
    caseResults,
  };
}

describe("GATE-02 Conformance 准入不接受旧 case 全集或全 true 声明", () => {
  it("中央 required case 合同 = 声明式 6 条 + RuntimeProtocol 行为清单，且回执键逐条对齐", () => {
    // 合同版本是正式机器元数据，必须与代码唯一 case 全集同序。
    expect(PUBLICATION_CONFORMANCE_SUITE_REVISION).toBe("runtime-conformance@2");
    expect([...PUBLICATION_CONFORMANCE_CASES]).toEqual([
      ...PUBLICATION_DECLARATION_CASE_IDS,
      ...RUNTIME_PROTOCOL_CONFORMANCE_CASES,
    ]);

    const contract = readJson<{
      contract_version: string;
      required_cases: Array<{ id: string; receipt_keys: string[] }>;
    }>("docs/contracts/runtime-conformance.json");
    expect(contract.contract_version).toBe("1.1.0");
    expect(contract.required_cases.map((entry) => entry.id)).toEqual([
      ...PUBLICATION_CONFORMANCE_CASES,
    ]);
    // 合同声明的回执字段就是校验器实际强制的字段，不允许两套口径。
    for (const entry of contract.required_cases) {
      expect(entry.receipt_keys, `${entry.id} 回执键与实现不一致`).toEqual([
        ...PUBLICATION_CONFORMANCE_RECEIPT_KEYS[
          entry.id as keyof typeof PUBLICATION_CONFORMANCE_RECEIPT_KEYS
        ],
      ]);
    }
  });

  it("全 boolean 声明的报告被拒绝：只有 header 里的 passed，没有真实调用回执", () => {
    const report = buildReport(
      PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({
        caseId,
        passed: true,
        // 只有 boolean 声明：没有 call，也没有任何真实调用事实。
        evidence: { caseId, passed: true },
      })),
    );
    // digest 自洽（buildReport 已绑定），因此拒绝的理由只能是「缺真实调用回执」。
    expect(() => validateRuntimeConformanceReport(report)).toThrow(/缺少真实调用回执字段/);
    expect(() => validateRuntimeConformanceReport(report)).toThrow(RuntimeConformanceTrustError);
  });

  it("正面控制：同一构造下补齐真实回执即通过（证明上面的拒绝不是规则空转）", () => {
    const report = buildReport(
      PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({
        caseId,
        passed: true,
        evidence: { caseId, passed: true, ...receiptFor(caseId) },
      })),
    );
    expect(() => validateRuntimeConformanceReport(report)).not.toThrow();
  });

  it("只带旧声明式 case 的报告被拒绝：旧全集与新协议 required behavior 清单脱节", () => {
    const report = buildReport(
      PUBLICATION_DECLARATION_CASE_IDS.map((caseId) => ({
        caseId,
        passed: true,
        evidence: { caseId, passed: true, ...receiptFor(caseId) },
      })),
    );
    expect(() => validateRuntimeConformanceReport(report)).toThrow(/必须包含全部且唯一的/);
  });

  it("eligibility 侧同样拒绝：缺行为 case / 套件漂移 / 目标被篡改都不准入", () => {
    const expected = {
      tenantId: "tenant-1",
      runtimeRevisionId: "revision-1",
      runtimeTargetDigest: "sha256:target",
      runtimeConfigDigest: "sha256:config",
      protocolContractDigest: "agent-runtime-protocol@1",
      allowedFormats: ["standard_dsse" as const],
    };
    const run = {
      runId: "run-1",
      tenantId: "tenant-1",
      runtimeRevisionId: "revision-1",
      overallResult: "passed" as const,
      runtimeTargetDigest: "sha256:target",
      runtimeConfigDigest: "sha256:config",
      protocolContractDigest: "agent-runtime-protocol@1",
      suiteRevision: PUBLICATION_CONFORMANCE_SUITE_REVISION,
      conformanceFormat: "standard_dsse" as const,
    };
    const fullCaseSet = PUBLICATION_CONFORMANCE_CASES.map((caseId) => ({ caseId, passed: true }));

    // 只声明旧 6 条 case 且全部 passed —— 仍必须失败。
    const legacy = validateRuntimePublicationConformanceEvidence({
      run,
      caseResults: PUBLICATION_DECLARATION_CASE_IDS.map((caseId) => ({ caseId, passed: true })),
      expected,
    });
    expect(legacy.valid).toBe(false);
    expect(legacy.errors.map((error) => error.code)).toContain("conformance_cases_incomplete");

    // 全集齐备但套件版本漂移 —— 依然必须失败（版本是机器元数据，不是免责开关）。
    const drifted = validateRuntimePublicationConformanceEvidence({
      run: { ...run, suiteRevision: `${PUBLICATION_CONFORMANCE_SUITE_REVISION}-drift` },
      caseResults: fullCaseSet,
      expected,
    });
    expect(drifted.valid).toBe(false);
    expect(drifted.errors.map((error) => error.code)).toContain(
      "conformance_suite_revision_mismatch",
    );

    // 被测目标摘要被换掉 —— 依然必须失败（保留真实目标校验）。
    const retargeted = validateRuntimePublicationConformanceEvidence({
      run: { ...run, runtimeTargetDigest: "sha256:other-target" },
      caseResults: fullCaseSet,
      expected,
    });
    expect(retargeted.valid).toBe(false);
    expect(retargeted.errors.map((error) => error.code)).toContain(
      "conformance_target_digest_mismatch",
    );

    // 正面控制：三条不变式都成立时必须通过。
    const valid = validateRuntimePublicationConformanceEvidence({
      run,
      caseResults: fullCaseSet,
      expected,
    });
    expect(valid.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GATE-03 — 全新 MySQL 按最终 Migration 初始化 + Seed
// ═══════════════════════════════════════════════════════════════════════════

describe("GATE-03 Fresh DB 表 / FK / 单活约束 / 列类型 / 索引 / Smoke", () => {
  it("表集合与 canonical schema manifest 一致，且 fresh-db smoke 由验收矩阵真实执行", async () => {
    const manifest = readJson<{ tables: string[] }>("docs/topic-01/evidence/schema-manifest.json");
    const tables = await queryRows<{ name: string }>(
      sql`SELECT TABLE_NAME AS name FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`,
    );
    const actual = tables
      .map((row) => row.name)
      .filter((name) => !name.startsWith("__"))
      .sort();
    expect(actual).toEqual([...manifest.tables].sort());

    // 「全新 MySQL 按最终 Migration 初始化 + Seed + 启动 Smoke」必须由验收矩阵真实执行。
    const plan = await loadPlan();
    const freshDb = plan.stages.find((stage) => stage.id === "fresh-db");
    expect(freshDb, "验收计划缺少 fresh-db 阶段").toBeDefined();
    expect(freshDb?.commands).toContainEqual(["pnpm", "db:verify-fresh"]);

    const verifier = readFileSync(resolve(ROOT, "scripts/verify-fresh-db.mts"), "utf8");
    // 该阶段必须真的起全新容器、跑最终迁移、跑 seed、并启动应用 smoke。
    expect(verifier).toContain("MySqlContainer");
    expect(verifier).toContain('run("migrate", ["db:migrate"]');
    expect(verifier).toContain('run("seed", ["db:seed"]');
    expect(verifier).toMatch(/next", "dev"/);
  });

  it("闭合关键外键真实存在于最终 Migration（含复合 FK）", async () => {
    const constraints = await queryRows<{ constraintName: string; tableName: string }>(
      sql`SELECT CONSTRAINT_NAME AS constraintName, TABLE_NAME AS tableName
          FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    );
    const present = new Set(constraints.map((row) => `${row.tableName}.${row.constraintName}`));
    for (const required of [
      // Environment 租约必须挂在真实 InvocationAttempt 上（不允许伪造 uuid）。
      "EnvironmentLease.EnvironmentLease_tenant_invocation_attempt_fk",
      "EnvironmentLease.EnvironmentLease_invocationId_Invocation_id_fk",
      // 执行权归属必须挂在真实 Invocation / Attempt 上。
      "ExecutionOwnership.ExecutionOwnership_tenant_invocation_attempt_fk",
      "ExecutionOwnership.ExecutionOwnership_invocationId_Invocation_id_fk",
      // Runtime Session 必须绑定到精确执行权代际（复合 FK：tenant+invocation+attempt+ownership+epoch）。
      "RuntimeSessionBinding.RuntimeSessionBinding_tenant_owner_fk",
    ]) {
      expect(present.has(required), `缺少外键：${required}`).toBe(true);
    }
  });

  it("单活约束成立：activeSlot 生成列 + 唯一索引 + CHECK 全部落地", async () => {
    const [column] = await queryRows<{
      columnType: string;
      extra: string;
      generationExpression: string | null;
    }>(
      sql`SELECT COLUMN_TYPE AS columnType, EXTRA AS extra,
                 GENERATION_EXPRESSION AS generationExpression
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'ExecutionOwnership' AND COLUMN_NAME = 'activeSlot'`,
    );
    expect(column, "ExecutionOwnership.activeSlot 缺失").toBeDefined();
    expect(column?.columnType).toBe("tinyint");
    expect(column?.extra).toContain("STORED GENERATED");
    // 生成表达式必须只在 ownershipState = 'active' 时取 1，其余为 NULL —— 唯一索引
    // 依赖这个 NULL 语义才能保证「同一 Invocation 最多一个 active 代际」。
    // MySQL 会把字面量改写成 `_utf8mb4\'active\'`（信息架构里引号是反斜杠转义的），
    // 因此字符集引导前缀与转义反斜杠都必须可选。
    expect(column?.generationExpression ?? "").toMatch(
      /case\s+`?ownershipState`?\s+when\s+_?\w*\\?'active\\?'\s+then\s+1\s+else\s+null\s+end/i,
    );

    const indexes = await queryRows<{
      keyName: string;
      nonUnique: number;
      columnName: string;
    }>(
      sql`SELECT INDEX_NAME AS keyName, NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName
          FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ExecutionOwnership'`,
    );
    const activeIndex = indexes
      .filter((row) => row.keyName === "ExecutionOwnership_tenant_invocation_active_slot_uq")
      .sort((left, right) => String(left.columnName).localeCompare(String(right.columnName)));
    expect(activeIndex.map((row) => row.columnName)).toEqual([
      "activeSlot",
      "invocationId",
      "tenantId",
    ]);
    expect(activeIndex.every((row) => Number(row.nonUnique) === 0)).toBe(true);

    const checks = await queryRows<{ constraintName: string }>(
      sql`SELECT CONSTRAINT_NAME AS constraintName
          FROM information_schema.CHECK_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE()
            AND CONSTRAINT_NAME IN ('ExecutionOwnership_epoch_positive',
                                    'ExecutionOwnership_active_shape',
                                    'ExecutionOwnership_executing_activation_shape')`,
    );
    const presentChecks = new Set(checks.map((row) => row.constraintName));
    for (const name of [
      "ExecutionOwnership_epoch_positive",
      "ExecutionOwnership_active_shape",
      "ExecutionOwnership_executing_activation_shape",
    ]) {
      expect(presentChecks.has(name), `缺少 CHECK：${name}`).toBe(true);
    }
  });

  it("列类型与唯一索引真实落地（列宽 / 非空形状 / 幂等唯一键）", async () => {
    const columns = await queryRows<{
      tableName: string;
      columnName: string;
      columnType: string;
      charMax: number | null;
      isNullable: string;
    }>(
      sql`SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType,
                 CHARACTER_MAXIMUM_LENGTH AS charMax, IS_NULLABLE AS isNullable
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME IN ('EnvironmentLease','WorkspaceBinding','ExecutionOwnership',
                               'RuntimeSessionBinding')`,
    );
    const column = (tableName: string, columnName: string) =>
      columns.find((row) => row.tableName === tableName && row.columnName === columnName);

    // EnvironmentLease.storageIdentity 是 71 字符定宽 —— 恰好容得下 `sha256:<64hex>`，
    // 任何前缀都会溢出（真实踩过的列宽陷阱，必须由 schema 固定住）。
    expect(column("EnvironmentLease", "storageIdentity")?.charMax).toBe(71);
    expect(column("ExecutionOwnership", "activationDigest")?.charMax).toBe(71);
    expect(column("ExecutionOwnership", "leaseEpoch")?.columnType).toContain("bigint");
    expect(column("WorkspaceBinding", "continuityMode")?.isNullable).toBe("NO");
    expect(column("RuntimeSessionBinding", "leaseEpoch")?.isNullable).toBe("NO");

    const indexes = await queryRows<{ tableName: string; keyName: string; nonUnique: number }>(
      sql`SELECT TABLE_NAME AS tableName, INDEX_NAME AS keyName, NON_UNIQUE AS nonUnique
          FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND INDEX_NAME IN ('ExecutionOwnership_tenant_invocation_epoch_uq',
                               'EnvironmentLease_invocation_attempt_uq',
                               'RuntimeSessionBinding_tenant_start_intent_uq',
                               'RuntimeSessionBinding_tenant_ownership_uq')`,
    );
    const uniqueIndexes = new Set(
      indexes
        .filter((row) => Number(row.nonUnique) === 0)
        .map((row) => `${row.tableName}.${row.keyName}`),
    );
    for (const required of [
      // 同一 Invocation 的代际号唯一 —— 换代不可复用代际。
      "ExecutionOwnership.ExecutionOwnership_tenant_invocation_epoch_uq",
      // 一个 InvocationAttempt 只允许一份 Environment 租约。
      "EnvironmentLease.EnvironmentLease_invocation_attempt_uq",
      // 同一 Start 意图键只允许一份 Session（稳定 Start 去重的 schema 依据）。
      "RuntimeSessionBinding.RuntimeSessionBinding_tenant_start_intent_uq",
      // 一个执行权代际只允许一份 Session。
      "RuntimeSessionBinding.RuntimeSessionBinding_tenant_ownership_uq",
    ]) {
      expect(uniqueIndexes.has(required), `缺少唯一索引：${required}`).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GATE-04 — 静态残留零，且不误伤正常 Next.js / Insert 类型 / 版本元数据
// ═══════════════════════════════════════════════════════════════════════════

describe("GATE-04 旧 Route / 别名 / 默认 db 写事务 / NO 降级 / 生产免校验残留归零", () => {
  const documents = productionDocuments();
  const inventory = readJson<{ tables: Array<{ schemaDeclaration: string }> }>(
    "docs/topic-01/evidence/schema-inventory.json",
  );
  const canonicalSchemaFiles = new Set(
    inventory.tables.map((table) => table.schemaDeclaration.split("#", 1)[0] as string),
  );
  const testCollection = readJson<{ tests: Array<{ file: string; group: string }> }>(
    "docs/topic-01/evidence/test-collection.json",
  ).tests;

  it("真实生产文档上，所有静态规则零违规", () => {
    const closure = checkFinalClosureBoundaryGate(documents, canonicalSchemaFiles, testCollection);
    expect(closure.failures).toEqual([]);
    expect(closure.passed).toBe(true);

    // 必须与 scripts/architecture-gate.ts 的 DEPRECATED_ARCHITECTURE_ALLOWLIST 同口径：
    // 唯一例外是外部标准规范原文（其文本不可改写）。
    const externalStandardAllowlist = new Set([
      "lib/external/docs.ts",
      "lib/artifacts/verification/schemas/cyclonedx-1.6.schema.json",
    ]);
    expect(collectImplementationHistoryViolations(documents, externalStandardAllowlist)).toEqual(
      [],
    );
    expect(collectDeprecatedArchitectureViolations(documents, externalStandardAllowlist)).toEqual(
      [],
    );
    // 不给 allowlist 时，每一项命中都必须是那份已登记例外 —— 任何新增的施工历史命名
    // 都不可能躲在 allowlist 后面。
    for (const path of collectImplementationHistoryViolations(documents)) {
      expect(externalStandardAllowlist.has(path), `未登记的施工历史命名：${path}`).toBe(true);
    }
    for (const path of collectDeprecatedArchitectureViolations(documents)) {
      expect(externalStandardAllowlist.has(path), `未登记的已废弃架构表述：${path}`).toBe(true);
    }

    expect(collectRetiredModuleDependencyViolations(documents)).toEqual([]);
    expect(collectRetiredAgentExecutionViolations(documents)).toEqual([]);

    const topologyPaths = [
      "package.json",
      "Dockerfile",
      "docker/worker/Dockerfile",
      "deploy/production/compose.yaml",
      "scripts/workers/worker-entrypoint.ts",
      "lib/runtime/retry/runtime-dispatch-retry-worker.ts",
      "lib/job/job-worker.ts",
    ];
    const topology = checkWorkerProductionTopologyGate(
      topologyPaths.map((path) => ({
        path,
        source: existsSync(resolve(ROOT, path)) ? readFileSync(resolve(ROOT, path), "utf8") : "",
      })),
    );
    expect(topology.failures).toEqual([]);
    expect(topology.passed).toBe(true);
  });

  it("规则不是空转：合成违规必须被同一条规则抓到", () => {
    // 第二 Schema Root：未登记的 mysqlTable( 声明必须被拦下。
    const rogueSchema: SourceDocument = {
      path: "lib/runtime/rogue-schema.ts",
      source: 'export const rogue = mysqlTable("Rogue", {});',
    };
    const rogueFailures = checkFinalClosureBoundaryGate(
      [rogueSchema],
      canonicalSchemaFiles,
      testCollection,
    ).failures;
    expect(rogueFailures.some((failure) => failure.includes("第二 Schema Root"))).toBe(true);

    // 已退役模块依赖（含别名 export-from）必须被拦下。
    //
    // 说明符按段拼接，避免本文件自身成为被审的退役模块导入。
    const retiredSpecifier = ["@/lib", "runtime", "transport", "a2a-transport"].join("/");
    const aliasedLegacy: SourceDocument = {
      path: "lib/runtime/legacy-consumer.ts",
      source: `export { run } from "${retiredSpecifier}";`,
    };
    expect(collectRetiredModuleDependencyViolations([aliasedLegacy])).toContain(
      "lib/runtime/legacy-consumer.ts",
    );

    // 施工历史命名（阶段/批次/专项编号）必须被拦下。
    const historyDoc: SourceDocument = {
      path: "lib/runtime/history-consumer.ts",
      source: "// Phase B 收尾临时路径",
    };
    expect(collectImplementationHistoryViolations([historyDoc])).toContain(
      "lib/runtime/history-consumer.ts",
    );

    // 已废弃架构表述（旧/兼容/cutover 路径）必须被拦下。
    const deprecatedDoc: SourceDocument = {
      path: "lib/runtime/deprecated-consumer.ts",
      source: "// legacy fallback kept for cutover",
    };
    expect(collectDeprecatedArchitectureViolations([deprecatedDoc])).toContain(
      "lib/runtime/deprecated-consumer.ts",
    );
  });

  it("不误伤：Next.js Route、Insert 类型、版本元数据与已登记 Schema Root", () => {
    // 正常 Next.js Route Handler + 合法 Insert 类型 + 正式协议版本元数据。
    const legitimate: SourceDocument = {
      path: "app/api/threads/route.ts",
      source: [
        'import { NextResponse } from "next/server";',
        "export async function POST(request: Request) {",
        "  const body = await request.json();",
        '  return NextResponse.json({ ok: true, protocolVersion: 3, contractVersion: "1.1.0" });',
        "}",
        "export type NewThread = typeof threadTable.$inferInsert;",
        "export type NewRuntimeRevisionTable = typeof runtimeRevisionTable.$inferInsert;",
      ].join("\n"),
    };
    expect(collectRetiredModuleDependencyViolations([legitimate])).toEqual([]);
    expect(collectRetiredAgentExecutionViolations([legitimate])).toEqual([]);
    expect(collectImplementationHistoryViolations([legitimate])).toEqual([]);
    expect(collectDeprecatedArchitectureViolations([legitimate])).toEqual([]);

    // 已登记 canonical Schema Root 的 mysqlTable 声明不得被判为第二 Schema Root。
    const canonicalPath = "lib/persistence/schema/executions.ts";
    const canonicalDoc: SourceDocument = {
      path: canonicalPath,
      source: 'export const invocationTable = mysqlTable("Invocation", {});',
    };
    const failures = checkFinalClosureBoundaryGate(
      [canonicalDoc],
      new Set([canonicalPath]),
      testCollection,
    ).failures.filter((failure) => failure.includes("第二 Schema Root"));
    expect(failures).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GATE-05 — 全量验收：实际 SHA / 命令 / 退出码 / 跳过必须完整记录
// ═══════════════════════════════════════════════════════════════════════════

describe("GATE-05 全量验收证据完整性（未运行不得 PASS）", () => {
  it("验收结果合同接受完整记录，且拒绝缺 SHA / 缺运行标识 / 缺跳过记录 / 缺退出码 / 未运行冒充运行", async () => {
    const plan = await loadPlan();
    const complete = {
      schemaVersion: 2,
      baselineSha: plan.baselineSha,
      diffRange: `${plan.baselineSha}..HEAD`,
      localAcceptanceSha: "0".repeat(40),
      runId: `${"0".repeat(12)}-1789719655480-99006`,
      remoteHeadSha: null,
      githubCi: "pending",
      profile: "acceptance",
      planPath: "docs/topic-01/evidence/verification-plan.json",
      matrixPath: "docs/topic-01/evidence/acceptance-matrix.json",
      startedAt: "2026-09-18T00:00:00.000Z",
      finishedAt: "2026-09-18T00:10:00.000Z",
      durationMs: 600_000,
      status: "local-passed",
      fullLocalAcceptance: "passed",
      worktreeCleanBeforeRun: true,
      environment: { node: "v22.22.2", pnpm: "10.32.1", platform: "darwin", arch: "arm64" },
      informationalCounts: { testFiles: 1, testFilesByGroup: {}, schemaTables: 1 },
      artifactDigests: {
        verificationPlanSha256: "a".repeat(64),
        acceptanceMatrixSha256: "b".repeat(64),
        schemaManifestSha256: "c".repeat(64),
        testCollectionSha256: "d".repeat(64),
      },
      skippedTests: [],
      acceptanceIdResults: [],
      stages: plan.stages.map((stage) => ({
        id: stage.id,
        name: stage.id,
        startedAt: "2026-09-18T00:00:00.000Z",
        finishedAt: "2026-09-18T00:00:01.000Z",
        durationMs: 1_000,
        status: "passed",
        commands: [
          {
            command: ["pnpm", "typecheck"],
            startedAt: "2026-09-18T00:00:00.000Z",
            finishedAt: "2026-09-18T00:00:01.000Z",
            durationMs: 1_000,
            exitCode: 0,
            signal: null,
            recordChecksum: "e".repeat(64),
          },
        ],
      })),
    };
    expect(() => validateAcceptanceResult(complete)).not.toThrow();

    // 缺 localAcceptanceSha（实际 SHA 未记录）→ 拒绝。
    const { localAcceptanceSha: _sha, ...withoutSha } = complete;
    expect(() => validateAcceptanceResult(withoutSha)).toThrow();

    // 缺 runId（无法区分是哪一次运行的记录，两次运行会互相冒充）→ 拒绝。
    const { runId: _runId, ...withoutRunId } = complete;
    expect(() => validateAcceptanceResult(withoutRunId)).toThrow();

    // 缺 skippedTests（跳过情况未记录）→ 拒绝。
    const { skippedTests: _skipped, ...withoutSkips } = complete;
    expect(() => validateAcceptanceResult(withoutSkips)).toThrow();

    // 缺 stages（实际命令与退出码未记录）→ 拒绝：schema 一直把它列为必填，
    // 缺少阶段记录的「通过」就是未运行冒充运行。
    const { stages: _stages, ...withoutStages } = complete;
    expect(() => validateAcceptanceResult(withoutStages)).toThrow("stages");

    // 声称 passed 却没有任何命令记录 → 拒绝。
    expect(() =>
      validateAcceptanceResult({
        ...complete,
        stages: complete.stages.map((stage) => ({ ...stage, commands: [] })),
      }),
    ).toThrow(/没有任何命令记录/);

    // 声称 passed 但命令退出码非 0 → 拒绝（退出码是「确实跑过且全绿」的唯一凭据）。
    expect(() =>
      validateAcceptanceResult({
        ...complete,
        stages: complete.stages.map((stage) => ({
          ...stage,
          commands: stage.commands.map((entry) => ({ ...entry, exitCode: 1 })),
        })),
      }),
    ).toThrow(/退出码是 1/);

    // 命令缺 exitCode（无法证明是否真的运行）→ 拒绝。
    expect(() =>
      validateAcceptanceResult({
        ...complete,
        stages: complete.stages.map((stage) => ({
          ...stage,
          commands: stage.commands.map(({ exitCode: _exitCode, ...rest }) => rest),
        })),
      }),
    ).toThrow(/exitCode/);

    // 宣称完整本地验收通过却一条阶段都没有 → 拒绝（未运行不得 PASS）。
    expect(() => validateAcceptanceResult({ ...complete, stages: [] })).toThrow(/没有任何阶段记录/);

    // 宣称 closed 但远端 SHA 与本地实际 SHA 不等 → 拒绝（不得用局部结果冒充全量收口）。
    expect(() =>
      validateAcceptanceResult(
        { ...complete, status: "closed", githubCi: "passed", remoteHeadSha: "f".repeat(40) },
        { requireClosed: true },
      ),
    ).toThrow();
  });

  it("命令集合必须覆盖 typecheck / lint / build / test / architecture / freshdb / conformance", async () => {
    const plan = await loadPlan();
    const flat = plan.stages.flatMap((stage) => stage.commands.map((command) => command.join(" ")));
    for (const fragment of [
      "pnpm typecheck",
      "pnpm lint",
      "pnpm architecture:gate",
      "pnpm build:prod",
      "node scripts/vitest-stage.mjs",
      "pnpm db:verify-fresh",
      "pnpm contracts:verify",
      "node scripts/acceptance-contract.mjs",
      "node scripts/evidence-integrity.mjs",
    ]) {
      expect(
        flat.some((command) => command.includes(fragment)),
        `验收计划未覆盖：${fragment}`,
      ).toBe(true);
    }
  });
});
