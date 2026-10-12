/**
 * A11：执行代际（Generation）契约与权威基线。
 *
 * 事实源：repairs/A11-stream-generation.md、contracts/shared-contracts.md §7、复审报告 §9。
 *
 * ## 定义
 *
 * `Generation = {invocation_id, attempt_id, ownership_id, lease_epoch}`——一次**具体执行**的
 * 完整所有权身份。transient（`response.delta` 等）不持久化，但"不持久化"不等于"没有身份"：
 * 同一个 Thread/Turn 会被后续代际继续使用，只有完整 tuple 才能回答"这段正文是不是当前这一代
 * 写出来的"。
 *
 * ## 三条硬约束
 *
 * 1. `lease_epoch` 在线上是**十进制字符串**，比较必须按 BigInt。Number 在 `2^53` 以上会静默
 *    丢精度，而 epoch 是内核排他锁的世代号，一旦"比较相等"就再也分不出两代。
 * 2. epoch **只在同一 Invocation 内可比**。同 Turn 的 Replacement/Regenerate 会产生不同
 *    Invocation（epoch 各自从自己的计数开始），"数字更大就更新"是错的。因此跨 Invocation
 *    的情况只能由服务端活动执行事实判定 —— 基线里每个 Turn 只给"当前活动代际"，消费侧
 *    不自行比较两个 Invocation 的 epoch。
 * 3. 代际不是账本。它只把"展示中的临时正文"绑定到当前执行，绝不写入 Event 表，也不承诺
 *    断线后完整重放。
 *
 * ## 基线（`stream.generation` 控制消息）
 *
 * 连接初始化时先发代际快照，再对一次性 buffer 按 exact tuple 过滤，最后进入实时投递；
 * 运行时用**活动执行事实**（`Turn.activeInvocationId` → 当前 active Ownership）刷新。
 * "无活动执行" 明确为 `null`，而不是"这个 Turn 没说"。
 *
 * ## 为什么本模块零依赖
 *
 * 这份定义被**服务端与浏览器共用**（shared-contracts §7：服务端发送、ClientTransientDelta、
 * SSE 解析、store/reducer、快照合并、Web/Desktop 共用客户端全部使用同一份定义）。因此本模块
 * 只包含纯类型与纯函数，不得 import 任何服务端模块（db/drizzle/node:crypto/事件总线）——
 * 否则浏览器 bundle 会被拉进服务端适配层。服务端专属的读取与发号见
 * `lib/runtime/thread-generation-queries.ts`。
 */

/** 一次具体执行的完整代际身份（内部 camelCase；线上为 snake_case 见 serialize）。 */
export interface ThreadTransientGeneration {
  readonly invocationId: string;
  readonly attemptId: string;
  readonly ownershipId: string;
  /** 十进制字符串；禁止经 Number 转换。 */
  readonly leaseEpoch: string;
}

/** 单个 Turn 的权威代际；`null` 表示该 Turn 当前**没有**活动执行。 */
export interface ThreadTurnGeneration {
  readonly turnId: string;
  readonly generation: ThreadTransientGeneration | null;
}

/**
 * 服务端权威代际基线。
 *
 * - `baselineSequence`：发号时的持久游标（Thread 已投递的最大 event sequence）。
 * - `issuedRevision`：**进程内**单调发号。用于丢弃"同一条连接上迟到的旧基线"——
 *   接管不一定新增持久事件，只靠 `baselineSequence` 无法排序。
 *   跨进程不做全局序假设（总线本身也是"限定当前应用进程"），客户端在每次新连接时重置
 *   该标记，因此不会因为换进程而误丢合法基线。
 */
export interface ThreadGenerationBaseline {
  readonly threadId: string;
  readonly baselineSequence: number;
  readonly issuedRevision: number;
  readonly generations: readonly ThreadTurnGeneration[];
}

const DECIMAL_DIGITS = /^\d+$/;

/** 线上 epoch 必须是十进制字符串（不接受 `1e3`、`0x10`、带符号或空白）。 */
export function isDecimalLeaseEpoch(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_DIGITS.test(value);
}

/** 按 BigInt 比较两个 epoch：`a < b` → -1，`a === b` → 0，`a > b` → 1。 */
export function compareLeaseEpoch(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** 两个代际是否逐项相同（四项全比，不做"只比 epoch"的宽松等价）。 */
export function sameThreadGeneration(
  a: ThreadTransientGeneration | null,
  b: ThreadTransientGeneration | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.invocationId === b.invocationId &&
    a.attemptId === b.attemptId &&
    a.ownershipId === b.ownershipId &&
    a.leaseEpoch === b.leaseEpoch
  );
}

/** 代际的稳定字符串键（用于展示层临时 Item key、日志与去重；不参与持久化键）。 */
export function threadGenerationKey(generation: ThreadTransientGeneration): string {
  return `${generation.invocationId}:${generation.attemptId}:${generation.ownershipId}:${generation.leaseEpoch}`;
}

/**
 * 基线中该 Turn 的权威代际。
 *
 * - 返回 `null`：基线明确说"这个 Turn 当前没有活动执行"→ 迟到的 delta 一律丢弃（不复活）。
 * - 返回 `undefined`：基线**没有覆盖**这个 Turn（例如连接建立后才创建的 Turn）→ 消费侧只能
 *   有界暂存等待下一次权威基线，绝不能自作主张拼进旧正文。
 */
export function findAuthoritativeGeneration(
  baseline: ThreadGenerationBaseline | null,
  turnId: string,
): ThreadTransientGeneration | null | undefined {
  if (!baseline) return undefined;
  const entry = baseline.generations.find((candidate) => candidate.turnId === turnId);
  return entry ? entry.generation : undefined;
}

/** 事件是否**恰好属于**基线认定的当前代际（exact tuple，不做降级匹配）。 */
export function matchesGenerationBaseline(
  event: { readonly turnId: string; readonly generation: ThreadTransientGeneration },
  baseline: ThreadGenerationBaseline | null,
): boolean {
  const authoritative = findAuthoritativeGeneration(baseline, event.turnId);
  if (!authoritative) return false;
  return sameThreadGeneration(authoritative, event.generation);
}

/**
 * 新基线是否应当被采用（同一连接内）。
 *
 * 先用持久游标排序；游标相同（接管不一定新增持久事件）时用进程内发号。
 */
export function isNewerGenerationBaseline(
  next: ThreadGenerationBaseline,
  current: ThreadGenerationBaseline | null,
): boolean {
  if (!current) return true;
  if (next.baselineSequence !== current.baselineSequence) {
    return next.baselineSequence > current.baselineSequence;
  }
  return next.issuedRevision > current.issuedRevision;
}

/**
 * 两条基线的**代际事实**是否相同（忽略持久游标与发号）。
 *
 * 用于"要不要重发控制消息"：`issuedRevision` 每次发号都变、`baselineSequence` 随普通事件
 * 前进，二者都不代表代际切换；只有 Turn 集合或其 tuple 变化才是真正的换代信号。
 */
export function sameThreadGenerationTuples(
  a: readonly ThreadTurnGeneration[],
  b: readonly ThreadTurnGeneration[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.turnId !== right.turnId) return false;
    if (!sameThreadGeneration(left.generation, right.generation)) return false;
  }
  return true;
}

/** 基线承载的代际事实（含持久游标）是否全部相同。 */
export function sameThreadGenerationFacts(
  a: Pick<ThreadGenerationBaseline, "baselineSequence" | "generations">,
  b: Pick<ThreadGenerationBaseline, "baselineSequence" | "generations">,
): boolean {
  if (a.baselineSequence !== b.baselineSequence) return false;
  return sameThreadGenerationTuples(a.generations, b.generations);
}

/** SSE `stream.generation` 的 data 负载（snake_case 线上格式）。 */
export function serializeThreadGenerationBaseline(
  baseline: ThreadGenerationBaseline,
): Record<string, unknown> {
  return {
    thread_id: baseline.threadId,
    baseline_sequence: baseline.baselineSequence,
    issued_revision: baseline.issuedRevision,
    generations: baseline.generations.map((entry) => ({
      turn_id: entry.turnId,
      generation: entry.generation
        ? {
            invocation_id: entry.generation.invocationId,
            attempt_id: entry.generation.attemptId,
            ownership_id: entry.generation.ownershipId,
            lease_epoch: entry.generation.leaseEpoch,
          }
        : null,
    })),
  };
}

/** 进程内发号键：与事件总线同策略（跨 module 实例共享同一份进程级状态）。 */
const REVISION_KEY = Symbol.for("snowharness.threadGeneration.issuedRevision");

/**
 * 取下一个发号。
 *
 * 只保证**单进程内**单调。它回答的是"同一条连接上两条基线谁后发"，不是全局版本号；
 * 换进程（重新建连）时客户端会重置比较基准，因此不需要也不应该假设全局序。
 */
export function nextThreadGenerationRevision(): number {
  const holder = globalThis as { [REVISION_KEY]?: number };
  const next = (holder[REVISION_KEY] ?? 0) + 1;
  holder[REVISION_KEY] = next;
  return next;
}
