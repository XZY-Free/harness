/**
 * R04 §2「固定锁图」的可执行门禁。
 *
 * `repairs/03-transactions.md` §2 定义唯一加锁顺序：
 *
 * ```
 * Invocation → Attempt → Ownership → Session → EnvironmentLease → 必需子执行事实 → Thread/Turn/Item 映射
 * ```
 *
 * 本契约把「**执行根先于产品根**」这一条变成机器可验的断言。它存在的原因是一次真实缺陷：
 * `requireCurrentExecutionAuthority` 曾以 `O → I` 取得锁，而 `renew`/`acquire`/`close` 是 `I → O`；
 * 另有 Interrupt/Steer/Pause-Resume/子线程取消/UAR 解析等产品侧入口先锁 Turn/Thread 再建
 * InvocationCommand（内部锁 Ownership）。这些反向序与 Runtime 路径「锁 I/O → 写 Thread 事件流」
 * 互等即构成真实死锁环——`applyToolCall` 的重试只处理 `ToolCallSequenceConflictError`，兜不住死锁。
 *
 * 锁序只能靠**顺序本身**保证，不能靠注释声明；因此这里直接读源码断言顺序。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 执行根与必需子执行事实：必须先于产品根取得。 */
const EXECUTION_ROOT_TABLES = new Set([
  "invocationTable",
  "invocationAttemptTable",
  "executionOwnershipTable",
  "runtimeSessionBindingTable",
  "executionBindingTable",
  "environmentLeaseTable",
]);

/** 产品根：按固定锁图必须排在执行根之后。 */
const PRODUCT_ROOT_TABLES = new Set(["threadTable", "turnTable", "threadItemTable"]);

interface LockSite {
  /** 行号（函数体起始为 1）。 */
  line: number;
  table: string;
}

/**
 * 定位函数**参数表**结束所在行。
 *
 * 受审函数普遍把参数写成多行内联对象类型（`params: { … }`），其收尾的 `}` 恰好落在行首，
 * 因此「从定义行直接找行首 `}`」会把参数表误当成函数体，得到被截断的假函数体——
 * 本门禁的第一版就是这个错误，它让 `rootCall` 永远找不到（假绿/假红都在所难免）。
 * 这里改用括号配平定位参数表，再在其后找函数体收尾。
 */
function findParameterListEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  let opened = false;
  for (let i = startIndex; i < lines.length; i += 1) {
    for (const ch of lines[i] ?? "") {
      if (ch === "(") {
        depth += 1;
        opened = true;
      } else if (ch === ")") {
        depth -= 1;
        if (opened && depth === 0) return i;
      }
    }
  }
  throw new Error("未找到参数表结束位置");
}

/**
 * 从函数定义处取到顶层 `}` 为止的函数体。
 *
 * 这些受审函数都是顶层导出函数，因此「参数表之后、首个行首 `}` 即函数结束」在本题材下是可靠的，
 * 且不需要处理字符串/注释里的花括号。
 */
function extractFunctionBody(source: string, functionName: string): string {
  const lines = source.split("\n");
  const startIndex = lines.findIndex((line) =>
    new RegExp(`^(export\\s+)?(async\\s+)?function\\s+${functionName}\\b`).test(line),
  );
  if (startIndex === -1) throw new Error(`未找到函数 ${functionName}`);
  const bodyStart = findParameterListEnd(lines, startIndex);
  const body: string[] = [];
  for (let i = bodyStart; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (i > bodyStart && /^\}/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/** 按出现顺序提取函数体里的 `SELECT … FOR UPDATE` 目标表。 */
function lockSequence(body: string): LockSite[] {
  const lines = body.split("\n");
  const sites: LockSite[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.includes('.for("update")')) continue;
    // 锁点跟在 `.select().from(<表>)` 之后，最多回看 20 行。
    let table = "(unknown)";
    for (let j = i; j >= Math.max(0, i - 20); j -= 1) {
      const candidate = lines[j] ?? "";
      const match = /\.from\((\w+)\)/.exec(candidate) ?? /\.from\((\w+)/.exec(candidate);
      const name = match?.[1];
      if (name) {
        table = name;
        break;
      }
    }
    sites.push({ line: i + 1, table });
  }
  return sites;
}

/** 返回首个「产品根先于执行根」的违规描述；顺序正确时返回 null。 */
function findInversion(sites: LockSite[]): string | null {
  const firstExecution = sites.findIndex((site) => EXECUTION_ROOT_TABLES.has(site.table));
  const firstProduct = sites.findIndex((site) => PRODUCT_ROOT_TABLES.has(site.table));
  if (firstExecution === -1 || firstProduct === -1) return null;
  if (firstProduct < firstExecution) {
    const productSite = sites[firstProduct];
    const executionSite = sites[firstExecution];
    if (!productSite || !executionSite) return null;
    return `产品根 ${productSite.table}(line ${productSite.line}) 先于执行根 ${executionSite.table}(line ${executionSite.line})`;
  }
  return null;
}

/** 受审函数清单：覆盖守卫、Owner 生命周期、以及所有会创建 InvocationCommand 的产品侧入口。 */
const AUDITED_FUNCTIONS: Array<{ file: string; fn: string }> = [
  {
    file: "lib/executions/application/require-current-execution-authority.ts",
    fn: "requireCurrentExecutionAuthority",
  },
  {
    file: "lib/executions/persistence/execution-ownership-store.ts",
    fn: "requireCurrentExecutionOwnership",
  },
  {
    file: "lib/executions/persistence/execution-ownership-store.ts",
    fn: "acquireExecutionOwnershipInTransaction",
  },
  {
    file: "lib/executions/persistence/execution-ownership-store.ts",
    fn: "renewExecutionOwnershipInTransaction",
  },
  {
    file: "lib/executions/persistence/execution-ownership-store.ts",
    fn: "closeExecutionOwnership",
  },
  { file: "lib/conversations/interrupt-queries.ts", fn: "requestInterrupt" },
  { file: "lib/conversations/steer-queries.ts", fn: "queueSteer" },
  { file: "lib/conversations/pause-resume-queries.ts", fn: "requestPausedTurnResume" },
  { file: "lib/conversations/child-thread-queries.ts", fn: "requestChildThreadCancellation" },
  { file: "lib/conversations/user-action-resolve-queries.ts", fn: "resolveGenericUserAction" },
  { file: "lib/permission/user-action-expiry-queries.ts", fn: "expireLockedUserActionRequest" },
];

describe("执行根锁序契约（R04 §2 固定锁图）", () => {
  it("受审函数一律先锁执行根、再锁产品根", () => {
    const violations: string[] = [];
    for (const { file, fn } of AUDITED_FUNCTIONS) {
      const sites = lockSequence(extractFunctionBody(readFileSync(file, "utf8"), fn));
      const inversion = findInversion(sites);
      if (inversion) violations.push(`${file}#${fn}: ${inversion}`);
    }
    expect(violations).toEqual([]);
  });

  it("守卫必须先锁 Invocation 根，再锁 Ownership", () => {
    const source = readFileSync("lib/executions/persistence/execution-ownership-store.ts", "utf8");
    // 间接锚定：根锁经由 `lockInvocationRootIfExists` 完成，因此先断言它真的锁 Invocation。
    const rootHelper = extractFunctionBody(source, "lockInvocationRootIfExists");
    expect(lockSequence(rootHelper).map((site) => site.table)).toEqual(["invocationTable"]);

    const body = extractFunctionBody(source, "requireCurrentExecutionOwnership");
    const rootCallLine = body
      .split("\n")
      .findIndex((line) => /lockInvocation(RootIfExists)?\(/.test(line));
    const ownershipLock = lockSequence(body).find(
      (site) => site.table === "executionOwnershipTable",
    );
    expect(rootCallLine, "守卫必须先取 Invocation 根锁").toBeGreaterThanOrEqual(0);
    expect(ownershipLock, "守卫必须锁 Ownership 行").toBeDefined();
    expect(rootCallLine + 1).toBeLessThan((ownershipLock as LockSite).line);
  });

  it("产品侧入口在触碰 Turn/Thread 之前先取执行根", () => {
    const entryPoints: Array<{ file: string; fn: string }> = [
      { file: "lib/conversations/interrupt-queries.ts", fn: "requestInterrupt" },
      { file: "lib/conversations/steer-queries.ts", fn: "queueSteer" },
      { file: "lib/conversations/pause-resume-queries.ts", fn: "requestPausedTurnResume" },
      { file: "lib/conversations/child-thread-queries.ts", fn: "requestChildThreadCancellation" },
      { file: "lib/conversations/user-action-resolve-queries.ts", fn: "resolveGenericUserAction" },
      { file: "lib/permission/user-action-expiry-queries.ts", fn: "expireLockedUserActionRequest" },
    ];
    for (const { file, fn } of entryPoints) {
      const body = extractFunctionBody(readFileSync(file, "utf8"), fn);
      const lines = body.split("\n");
      let firstProductLock = Number.POSITIVE_INFINITY;
      let firstDirectRootLock = Number.POSITIVE_INFINITY;
      for (const site of lockSequence(body)) {
        if (PRODUCT_ROOT_TABLES.has(site.table)) {
          firstProductLock = Math.min(firstProductLock, site.line);
        }
        if (EXECUTION_ROOT_TABLES.has(site.table)) {
          firstDirectRootLock = Math.min(firstDirectRootLock, site.line);
        }
      }
      // 执行根可以在函数内直接锁，也可以经预锁原语取得；两者取更早者与首个产品根锁比较。
      const primerLine = lines.findIndex((line) =>
        line.includes("lockExecutionRootForProductWrite("),
      );
      const rootLine = Math.min(
        firstDirectRootLock,
        primerLine >= 0 ? primerLine + 1 : Number.POSITIVE_INFINITY,
      );
      expect(rootLine, `${file}#${fn} 未在触碰产品根前取得执行根`).toBeLessThan(
        Number.POSITIVE_INFINITY,
      );
      expect(rootLine, `${file}#${fn} 先锁产品根 (line ${firstProductLock})`).toBeLessThan(
        firstProductLock,
      );
    }
  });

  it("Runtime Ingress 的文件级首锁落在执行根上", () => {
    const source = readFileSync("lib/runtime/application/ingress-runtime-events.ts", "utf8");
    const all = lockSequence(source);
    const firstExecution = all.findIndex((site) => EXECUTION_ROOT_TABLES.has(site.table));
    const firstProduct = all.findIndex((site) => PRODUCT_ROOT_TABLES.has(site.table));
    expect(firstExecution).toBeGreaterThanOrEqual(0);
    if (firstProduct >= 0) {
      expect(firstProduct, "Ingress 不得在产品根之后才拿执行根").toBeGreaterThan(firstExecution);
    }
  });

  it("检测器对反向序具备敏感性（负向控制）", () => {
    const inverted = [
      "async function bad(db) {",
      "  const [thread] = await tx",
      "    .select()",
      "    .from(threadTable)",
      '    .for("update")',
      "    .limit(1);",
      "  const [invocation] = await tx",
      "    .select()",
      "    .from(invocationTable)",
      '    .for("update")',
      "    .limit(1);",
      "}",
    ].join("\n");
    const sites = lockSequence(extractFunctionBody(inverted, "bad"));
    expect(findInversion(sites)).not.toBeNull();

    const ordered = [
      "async function good(db) {",
      "  const [invocation] = await tx",
      "    .select()",
      "    .from(invocationTable)",
      '    .for("update")',
      "    .limit(1);",
      "  const [thread] = await tx",
      "    .select()",
      "    .from(threadTable)",
      '    .for("update")',
      "    .limit(1);",
      "}",
    ].join("\n");
    expect(findInversion(lockSequence(extractFunctionBody(ordered, "good")))).toBeNull();
  });
});
