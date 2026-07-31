import type {
  PostCutoverVerificationReport,
  PostCutoverVerificationResult,
  PostCutoverVerificationType,
} from "@/lib/v11/cutover/entry-switch-contract";
import { ALL_POST_CUTOVER_VERIFICATIONS } from "@/lib/v11/cutover/entry-switch-contract";
/**
 * S13-W05 切换后立即验证器：9 项验证确保 V11 入口可用。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W05
 *         （切换后立即验证创建 Thread、连续 Turn、Tool/Effect、Desktop、本地授权、Child、Job、管理发布和 Trace）。
 *
 * 设计：
 * - 9 项验证由独立 Verifier 接口提供（生产由各模块实现）。
 * - 每项验证返回 passed/failed + 资源 ID + 耗时。
 * - 失败项不阻断后续验证（收集全部结果后汇总）。
 * - 验证报告支持机器可读与人可审阅。
 */
import type { CutoverSession } from "@/lib/v11/cutover/session-store";

// ─── 单项验证器接口 ──────────────────────────────────────────

/** 单项切换后验证器接口。 */
export interface PostCutoverVerifier {
  readonly type: PostCutoverVerificationType;
  /** 执行验证。 */
  verify(session: CutoverSession): Promise<PostCutoverVerificationResult>;
}

// ─── 标准验证器实现 ──────────────────────────────────────────

/** 创建 Thread 验证器。 */
export class CreateThreadVerifier implements PostCutoverVerifier {
  readonly type: PostCutoverVerificationType = "create_thread";

  constructor(private readonly threadCreator: ThreadCreator) {}

  async verify(session: CutoverSession): Promise<PostCutoverVerificationResult> {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const result = await this.threadCreator.createTestThread(session.id);
      return {
        type: this.type,
        passed: true,
        details: `Thread 创建成功：${result.threadId}`,
        resourceId: result.threadId,
        timestamp,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        type: this.type,
        passed: false,
        details: `Thread 创建失败：${err instanceof Error ? err.message : String(err)}`,
        resourceId: null,
        timestamp,
        durationMs: Date.now() - start,
      };
    }
  }
}

/** 连续 Turn 验证器。 */
export class ConsecutiveTurnsVerifier implements PostCutoverVerifier {
  readonly type: PostCutoverVerificationType = "consecutive_turns";

  constructor(
    private readonly turnRunner: TurnRunner,
    private readonly threadCreator: ThreadCreator,
  ) {}

  async verify(session: CutoverSession): Promise<PostCutoverVerificationResult> {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const thread = await this.threadCreator.createTestThread(session.id);
      const turn1 = await this.turnRunner.runTurn(thread.threadId, "第一条消息");
      const turn2 = await this.turnRunner.runTurn(thread.threadId, "第二条消息");
      return {
        type: this.type,
        passed: true,
        details: `连续 Turn 验证通过：Thread ${thread.threadId}，Turn ${turn1.turnId} → ${turn2.turnId}`,
        resourceId: thread.threadId,
        timestamp,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        type: this.type,
        passed: false,
        details: `连续 Turn 验证失败：${err instanceof Error ? err.message : String(err)}`,
        resourceId: null,
        timestamp,
        durationMs: Date.now() - start,
      };
    }
  }
}

/** Tool/Effect 验证器。 */
export class ToolEffectVerifier implements PostCutoverVerifier {
  readonly type: PostCutoverVerificationType = "tool_effect";

  constructor(
    private readonly toolExecutor: ToolExecutor,
    private readonly threadCreator: ThreadCreator,
  ) {}

  async verify(session: CutoverSession): Promise<PostCutoverVerificationResult> {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const thread = await this.threadCreator.createTestThread(session.id);
      const toolCall = await this.toolExecutor.executeTool(thread.threadId, "test_tool");
      return {
        type: this.type,
        passed: true,
        details: `Tool/Effect 验证通过：ToolCall ${toolCall.toolCallId}`,
        resourceId: toolCall.toolCallId,
        timestamp,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        type: this.type,
        passed: false,
        details: `Tool/Effect 验证失败：${err instanceof Error ? err.message : String(err)}`,
        resourceId: null,
        timestamp,
        durationMs: Date.now() - start,
      };
    }
  }
}

/** Desktop 验证器。 */
export class DesktopVerifier implements PostCutoverVerifier {
  readonly type: PostCutoverVerificationType = "desktop";

  constructor(private readonly desktopChecker: DesktopChecker) {}

  async verify(session: CutoverSession): Promise<PostCutoverVerificationResult> {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const result = await this.desktopChecker.verifyDesktop(session.id);
      return {
        type: this.type,
        passed: result.passed,
        details: result.details,
        resourceId: result.deviceId,
        timestamp,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        type: this.type,
        passed: false,
        details: `Desktop 验证失败：${err instanceof Error ? err.message : String(err)}`,
        resourceId: null,
        timestamp,
        durationMs: Date.now() - start,
      };
    }
  }
}

/** 本地授权验证器。 */
export class LocalAuthorizationVerifier implements PostCutoverVerifier {
  readonly type: PostCutoverVerificationType = "local_authorization";

  constructor(private readonly authChecker: LocalAuthChecker) {}

  async verify(session: CutoverSession): Promise<PostCutoverVerificationResult> {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const result = await this.authChecker.verifyLocalAuth(session.id);
      return {
        type: this.type,
        passed: result.passed,
        details: result.details,
        resourceId: null,
        timestamp,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        type: this.type,
        passed: false,
        details: `本地授权验证失败：${err instanceof Error ? err.message : String(err)}`,
        resourceId: null,
        timestamp,
        durationMs: Date.now() - start,
      };
    }
  }
}

/** Child Thread 验证器。 */
export class ChildThreadVerifier implements PostCutoverVerifier {
  readonly type: PostCutoverVerificationType = "child_thread";

  constructor(
    private readonly childCreator: ChildThreadCreator,
    private readonly threadCreator: ThreadCreator,
  ) {}

  async verify(session: CutoverSession): Promise<PostCutoverVerificationResult> {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const parent = await this.threadCreator.createTestThread(session.id);
      const child = await this.childCreator.createChildThread(parent.threadId);
      return {
        type: this.type,
        passed: true,
        details: `Child Thread 验证通过：Parent ${parent.threadId} → Child ${child.threadId}`,
        resourceId: child.threadId,
        timestamp,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        type: this.type,
        passed: false,
        details: `Child Thread 验证失败：${err instanceof Error ? err.message : String(err)}`,
        resourceId: null,
        timestamp,
        durationMs: Date.now() - start,
      };
    }
  }
}

/** Job 验证器。 */
export class JobVerifier implements PostCutoverVerifier {
  readonly type: PostCutoverVerificationType = "job";

  constructor(private readonly jobRunner: JobRunner) {}

  async verify(session: CutoverSession): Promise<PostCutoverVerificationResult> {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const job = await this.jobRunner.runTestJob(session.id);
      return {
        type: this.type,
        passed: true,
        details: `Job 验证通过：Job ${job.jobId}`,
        resourceId: job.jobId,
        timestamp,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        type: this.type,
        passed: false,
        details: `Job 验证失败：${err instanceof Error ? err.message : String(err)}`,
        resourceId: null,
        timestamp,
        durationMs: Date.now() - start,
      };
    }
  }
}

/** 管理发布验证器。 */
export class AdminPublishVerifier implements PostCutoverVerifier {
  readonly type: PostCutoverVerificationType = "admin_publish";

  constructor(private readonly publishChecker: AdminPublishChecker) {}

  async verify(session: CutoverSession): Promise<PostCutoverVerificationResult> {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const result = await this.publishChecker.verifyPublish(session.id);
      return {
        type: this.type,
        passed: result.passed,
        details: result.details,
        resourceId: result.publishedResourceId,
        timestamp,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        type: this.type,
        passed: false,
        details: `管理发布验证失败：${err instanceof Error ? err.message : String(err)}`,
        resourceId: null,
        timestamp,
        durationMs: Date.now() - start,
      };
    }
  }
}

/** Trace 验证器。 */
export class TraceVerifier implements PostCutoverVerifier {
  readonly type: PostCutoverVerificationType = "trace";

  constructor(private readonly traceChecker: TraceChecker) {}

  async verify(session: CutoverSession): Promise<PostCutoverVerificationResult> {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const result = await this.traceChecker.verifyTrace(session.id);
      return {
        type: this.type,
        passed: result.passed,
        details: result.details,
        resourceId: result.traceId,
        timestamp,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        type: this.type,
        passed: false,
        details: `Trace 验证失败：${err instanceof Error ? err.message : String(err)}`,
        resourceId: null,
        timestamp,
        durationMs: Date.now() - start,
      };
    }
  }
}

// ─── Provider 接口（生产由各模块实现） ──────────────────

/** Thread 创建 Provider。 */
export interface ThreadCreator {
  createTestThread(sessionId: string): Promise<{ threadId: string }>;
}

/** Turn 执行 Provider。 */
export interface TurnRunner {
  runTurn(threadId: string, message: string): Promise<{ turnId: string }>;
}

/** Tool 执行 Provider。 */
export interface ToolExecutor {
  executeTool(threadId: string, toolName: string): Promise<{ toolCallId: string }>;
}

/** Desktop 检查 Provider。 */
export interface DesktopChecker {
  verifyDesktop(sessionId: string): Promise<{ passed: boolean; details: string; deviceId: string }>;
}

/** 本地授权检查 Provider。 */
export interface LocalAuthChecker {
  verifyLocalAuth(sessionId: string): Promise<{ passed: boolean; details: string }>;
}

/** Child Thread 创建 Provider。 */
export interface ChildThreadCreator {
  createChildThread(parentThreadId: string): Promise<{ threadId: string }>;
}

/** Job 执行 Provider。 */
export interface JobRunner {
  runTestJob(sessionId: string): Promise<{ jobId: string }>;
}

/** 管理发布检查 Provider。 */
export interface AdminPublishChecker {
  verifyPublish(sessionId: string): Promise<{
    passed: boolean;
    details: string;
    publishedResourceId: string | null;
  }>;
}

/** Trace 检查 Provider。 */
export interface TraceChecker {
  verifyTrace(
    sessionId: string,
  ): Promise<{ passed: boolean; details: string; traceId: string | null }>;
}

// ─── 验证执行器 ──────────────────────────────────────────────

/**
 * 执行全部切换后验证并生成报告。
 * 失败项不阻断后续验证（收集全部结果后汇总）。
 */
export async function runPostCutoverVerifications(
  session: CutoverSession,
  verifiers: readonly PostCutoverVerifier[],
): Promise<PostCutoverVerificationReport> {
  const results: PostCutoverVerificationResult[] = [];

  // 顺序执行（避免并发产生的资源竞争）
  for (const verifier of verifiers) {
    try {
      results.push(await verifier.verify(session));
    } catch (err) {
      results.push({
        type: verifier.type,
        passed: false,
        details: `验证执行异常：${err instanceof Error ? err.message : String(err)}`,
        resourceId: null,
        timestamp: new Date().toISOString(),
        durationMs: 0,
      });
    }
  }

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;
  const failedVerifications = results
    .filter((r) => !r.passed)
    .map((r) => `${r.type}: ${r.details}`);

  return {
    sessionId: session.id,
    results,
    passedCount,
    failedCount,
    passed: failedCount === 0,
    failedVerifications,
    generatedAt: new Date().toISOString(),
  };
}

/** 将切换后验证报告格式化为可读字符串。 */
export function formatPostCutoverReport(report: PostCutoverVerificationReport): string {
  const lines: string[] = [
    "V11 切换后验证报告",
    `会话 ID: ${report.sessionId}`,
    `生成时间: ${report.generatedAt}`,
    "",
    "总计:",
    `  通过: ${report.passedCount}/${report.results.length}`,
    `  失败: ${report.failedCount}`,
    `  总体: ${report.passed ? "通过" : "未通过"}`,
    "",
  ];

  if (report.failedVerifications.length > 0) {
    lines.push("失败项:");
    for (const failed of report.failedVerifications) {
      lines.push(`  ! ${failed}`);
    }
    lines.push("");
  }

  lines.push("验证详情:");
  for (const result of report.results) {
    const status = result.passed ? "✓" : "×";
    lines.push(`  ${status} ${result.type}: ${result.details} (${result.durationMs}ms)`);
  }

  return lines.join("\n");
}

/** 获取全部验证项类型。 */
export function getAllVerificationTypes(): readonly PostCutoverVerificationType[] {
  return ALL_POST_CUTOVER_VERIFICATIONS;
}
