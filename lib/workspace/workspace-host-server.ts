/**
 * 受管 WorkspaceHost Broker —— 把 Workspace 声明变成真实 Writer 保证（R08）。
 *
 * 设计边界（repairs/07-workspace.md）：
 * - 本文件是**资源 Backend**，不是业务执行内核，也不新增领域表。
 * - 所有"声明受管理"的写入都必须经过本 Broker 的执行/挂载授权；Broker 拥有
 *   实际的进程句柄，能真实停止旧 Writer 并确认退出，而不是在 JSON receipt 里
 *   直接填 `oldWriterRevoked: true`。
 * - storageScopeDigest / storageIdentity / hostIdentity 一律来自**实际探测**：
 *   规范化 root（realpath）+ 实际磁盘身份（dev/inode）+ 持久身份记录。
 *   不信任调用方提交的字符串，也不把 expectedStorageIdentity 照抄成 observed。
 * - operation 回执持久化：同一 operation 重放返回同一回执，不回退 generation。
 *
 * 复用 Node 现有能力（node:fs/promises、node:child_process、process.kill 进程组）
 * 与既有受管容器链（lib/runtime/container/*），不引入新的执行内核。
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";
import {
  ScopeLockBusyError,
  ScopeLockUnavailableError,
  scopeLockFilePath,
  secureManagedFileDelete,
  secureManagedFileWrite,
  withScopeLock as withNativeScopeLock,
} from "@/lib/workspace/scope-lock";
import type {
  SnapshotRequirements,
  SnapshotStorage,
  SnapshotStorageReceipt,
  SnapshotStorageRef,
} from "@/lib/workspace/snapshot-storage";
import { FileSnapshotStorage, resolveSnapshotStorage } from "@/lib/workspace/snapshot-storage";
import type {
  ManagedFileOperation,
  ManagedFileOperationResult,
  SafePointReceipt,
  WorkspaceHost,
  WorkspacePreparation,
  WorkspaceWriterGrant,
  WorkspaceWriterIdentity,
} from "@/lib/workspace/workspace-host";
import {
  type ManagedWriterContainment,
  readManagedWriterContainment,
  startManagedWriter,
  writeJsonDurable,
} from "@/lib/workspace/writer-launcher";

// ─── 稳定字面量 ────────────────────────────────────────────

const CONTROL_DIR = ".snow";
const HOST_IDENTITY_FILE = "host-identity.json";
const WORKSPACE_IDENTITY_FILE = "workspace-identity.json";
const SCOPE_CLAIM_FILE = "workspace-scope.json";
const OPERATIONS_DIR = "operations";
const WRITERS_DIR = "writers";
const CANDIDATES_DIR = "candidates";
/**
 * A06：候选**运行目录**（Writer root 的候选）必须落在受管写根内、控制面目录之外。
 *
 * 之前它建在 `controlRoot/candidates/...`，而 `activateWriter` 明确拒绝"控制面目录作为
 * Writer root" —— 于是"恢复成功但随后无法激活"是必然结果。控制面目录只保留
 * `candidates/<sha>.json` 这份**归属登记**，真正的目录在工作区侧。
 */
const RUNS_DIR = ".snow-runs";
const GRANTS_DIR = "grants";
const SAFE_POINTS_DIR = "safe-points";
const SAFE_POINT_INTENTS_DIR = "safe-point-intents";
const SNAPSHOT_DIR = "snapshot-storage";
/** 每代际的"授权已物理撤销"墓碑目录（A07 7.4）。 */
const REVOKED_DIR = "revoked";
/** scope 物理写屏障文件（A07 7.1）。 */
const FREEZE_FILE = "freeze.json";
/**
 * scope 的 Writer 代际账本（A07 决策二）。
 *
 * `current.json` 是**当前授权指针**，撤销时会被整体摘除；代际高水位必须另有一份
 * 单调记录，否则指针为空之后下一代可以回退、甚至复用已被撤销的 generation。
 */
const LEDGER_FILE = "ledger.json";

/** 停止进程组的单次等待上限（先 SIGTERM，再 SIGKILL）。 */
const STOP_WAIT_MS = 3_000;
/** 排空采样间隔。 */
const DRAIN_SAMPLE_MS = 60;

// ─── 错误 ──────────────────────────────────────────────────

/**
 * Writer 未被真实 fence。
 *
 * message 恒为稳定串 `WorkspaceWriterNotFenced`（调用方与测试按它判定），
 * 具体原因放 `detail`，避免"错误类别"被自由文本冲淡。
 */
export class WorkspaceWriterNotFencedError extends Error {
  readonly detail: string;
  constructor(detail = "") {
    super("WorkspaceWriterNotFenced");
    this.name = "WorkspaceWriterNotFenced";
    this.detail = detail;
  }
}

/** 同一物理安全点意图已进入释放终态，迟到 freeze 不得复活屏障。 */
export class CheckpointIntentRetiredError extends Error {
  constructor() {
    super("CheckpointIntentRetired");
    this.name = "CheckpointIntentRetired";
  }
}

type SafePointIntentState = "frozen" | "releasing" | "released";

interface SafePointIntentRecord {
  state: SafePointIntentState;
  checkpointIntentId: string;
  scopeDigest: string;
  writerGeneration: number;
  anchorDigest: string;
  frozenAt: string;
  updatedAt: string;
}

/** 实际存储/Host 身份与冻结事实不一致 → 连续性未证明（fail closed）。 */
export class WorkspaceIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuityUnproven";
  }
}

/** 同一物理写范围被另一个 tenant 占用：准入拒绝，不因为 DB 键多了 tenantId 就放行。 */
export class WorkspaceTenantConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceTenantConflict";
  }
}

/** 清理目标不属于该 Candidate 的注册资源。 */
export class WorkspaceCleanupRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCleanupRejected";
  }
}

/**
 * A06：控制端口参数契约被违反 —— 在**发出网络请求之前**由客户端本地拒绝。
 *
 * 不用 `WorkspaceWriterNotFenced` 表达这件事：那不是"Writer 未被 fence"，
 * 而是"跨进程端口不能承载这个值"。两类错误必须可区分，否则调用方（和测试）
 * 只能看到"同一个稳定串"，无法判断失败发生在哪一侧。
 */
export class WorkspaceRpcContractError extends Error {
  readonly stableCode = "WorkspaceRpcContractViolation";
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRpcContractViolation";
  }
}

// ─── 持久记录形状 ──────────────────────────────────────────

interface WorkspaceIdentityRecord {
  schemaVersion: number;
  workspaceId: string;
  canonicalRoot: string;
  deviceId: string;
  inode: string;
  createdAt: string;
}

interface ScopeClaimRecord {
  scopeDigest: string;
  tenantId: string;
  claimedAt: string;
}

interface HostIdentityRecord {
  hostIdentity: string;
  createdAt: string;
}

/**
 * 受管 Writer 进程的持久归属记录（A07 7.3）。
 *
 * 定位字段来自决策三的启动屏障（`ManagedWriterContainment`）—— 这里只在其上追加
 * 停止确认事实，避免"两条各自演进的记录形状"。
 *
 * A07 决策二：`stop` 是"停止确认事实"。**缺省即未确认停止**，记录必须保留
 * （`lastFailure` 说明卡在哪里），因为那份位置信息是后续重试与可审计处置的
 * 唯一依据 —— 把它删掉等于伪造"没有写者"。
 */
interface WriterProcessRecord extends ManagedWriterContainment {
  stop?: WriterStopAttempt;
}

/** 一次（或多次累积的）停止尝试结果；只有实测清空且排空才算 `confirmed`。 */
interface WriterStopAttempt {
  confirmed: boolean;
  confirmedAt: string | null;
  lastAttemptAt: string;
  attempts: number;
  /** 未确认时的原因；`confirmed = true` 时为 null。 */
  lastFailure: string | null;
  evidence: WriterStopEvidence;
}

/** scope Writer 代际账本：高水位是单调的，不随 `current.json` 的摘除而回退。 */
interface ScopeWriterLedgerRecord {
  schemaVersion: number;
  scopeDigest: string;
  highestAllocatedGeneration: number;
  updatedAt: string;
}

/** 未确认停止的写者：必须阻塞后续激活，且不得被 GC 掉。 */
export interface UnreconciledWriter {
  writerGeneration: number;
  phase: WriterProcessRecord["phase"];
  pid: number | null;
  processGroupId: number | null;
  recordPath: string;
  reason: string;
}

/**
 * 一个 scope 的**物理写者全集视图**（A07 决策二）。
 *
 * 权威事实来自目录枚举，而不是任一指针文件：`current.json` 只是当前授权指针，
 * 撤销会把它摘掉；只看指针就无法发现"仍有更旧写者可能存活"。
 */
export interface ScopeWriterState {
  scopeDigest: string;
  highestAllocatedGeneration: number;
  current: WorkspaceWriterGrant | null;
  revokedGenerations: number[];
  writerRecords: WriterProcessRecord[];
  unreconciledWriters: UnreconciledWriter[];
}

/** 某代际的 Writer 授权已被**物理撤销**（不是"进程停了"就算撤销）。 */
interface WriterRevocationRecord {
  scopeDigest: string;
  writerGeneration: number;
  reason: string;
  revokedAt: string;
  /**
   * A07 决策五：被撤销的**精确归属**（含 tenant）。
   *
   * 墓碑上必须能看出"撤的是谁"，否则事后审计只能看到"第 N 代被撤了"，
   * 而那正是让失败补偿误杀健康 Writer 的那种说法。
   */
  identity: WorkspaceWriterIdentity;
  evidence: WriterStopEvidence;
}

/**
 * scope 物理写屏障（A07 7.1）。
 *
 * 存在即可代表"该 scope 现在不接受写入授权，也不接受启动受管 Writer"。
 * 它必须与"已登记 Writer 进程组确认停止"一起成立，才算真正冻结。
 */
interface WorkspaceFreezeRecord {
  scopeDigest: string;
  checkpointIntentId: string;
  writerGeneration: number;
  anchorDigest: string;
  frozenAt: string;
  stopEvidence: WriterStopEvidence;
}

interface CandidateClaimRecord {
  operationId: string;
  candidateAttemptId: string;
  revisionId: string;
  workspaceBindingId: string;
  candidateRoot: string;
  createdAt: string;
}

interface BackendOperationReceipt {
  operationId: string;
  receipt: unknown;
  recordedAt: string;
}

export interface WriterStopEvidence {
  previousWriterPresent: boolean;
  stopped: boolean;
  processGroupEmpty: boolean;
  drained: boolean;
  signals: string[];
  pids: number[];
}

export interface WorkspaceHostIdentityProbe {
  hostIdentity: string;
  canonicalRoot: string;
  workspaceId: string;
  deviceId: string;
  inode: string;
  storageIdentity: string;
  scopeDigest: string;
}

// ─── 文件系统小工具 ────────────────────────────────────────

/**
 * 解析真实路径：存在的部分走 realpath，不存在的尾部保留。
 * macOS 的 `/var` → `/private/var` 这类链接必须被消掉，否则"同一物理根"会被判成两个。
 */
async function resolveReal(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return path.resolve(target);
    return path.join(await resolveReal(parent), path.basename(target));
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonExclusive(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), { flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
}

async function writeJsonStable(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const staging = `${file}.${randomUUID()}.staging`;
  await writeFile(staging, JSON.stringify(value, null, 2), { flag: "wx" });
  await rename(staging, file);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeComponent(value: string): string {
  const digest = value.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new WorkspaceWriterNotFencedError("scope digest 非法");
  return digest;
}

function safeIntentComponent(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new WorkspaceWriterNotFencedError("安全点 intent id 非法");
  }
  return value;
}

function sameSafePointTuple(
  left: Pick<
    SafePointIntentRecord,
    "checkpointIntentId" | "scopeDigest" | "writerGeneration" | "anchorDigest"
  >,
  right: Pick<
    SafePointIntentRecord,
    "checkpointIntentId" | "scopeDigest" | "writerGeneration" | "anchorDigest"
  >,
): boolean {
  return (
    left.checkpointIntentId === right.checkpointIntentId &&
    left.scopeDigest === right.scopeDigest &&
    left.writerGeneration === right.writerGeneration &&
    left.anchorDigest === right.anchorDigest
  );
}

function isInside(parent: string, child: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`)
  );
}

/** 枚举 `<dir>/<n>.json` 形式的代际编号（目录不存在 → 空集，不抛）。 */
async function listGenerationFiles(dir: string): Promise<number[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => Number.parseInt(name.slice(0, -".json".length), 10))
    .filter((value) => Number.isFinite(value));
}

/** 未确认停止的具体原因：用于拒绝消息，也用于运维判断下一步该做什么。 */
function writerUnreconciledReason(record: WriterProcessRecord): string {
  if (record.phase === "spawning" || record.processGroupId === null || record.pid === null) {
    return "只有启动意图、缺少可核验的进程组定位";
  }
  return record.stop?.lastFailure ?? "进程组/排空尚未确认";
}

/** 合并多代停止证据：只有全部代际都确认为真时结论才为真。 */
function mergeStopEvidence(evidence: WriterStopEvidence[]): WriterStopEvidence {
  if (evidence.length === 0) {
    return {
      previousWriterPresent: false,
      stopped: true,
      processGroupEmpty: true,
      drained: true,
      signals: [],
      pids: [],
    };
  }
  return {
    previousWriterPresent: evidence.some((entry) => entry.previousWriterPresent),
    stopped: evidence.every((entry) => entry.stopped),
    processGroupEmpty: evidence.every((entry) => entry.processGroupEmpty),
    drained: evidence.every((entry) => entry.drained),
    signals: [...new Set(evidence.flatMap((entry) => entry.signals))],
    pids: [...new Set(evidence.flatMap((entry) => entry.pids))],
  };
}

/**
 * 请求代际之前**实际存在过**的最高代际。
 *
 * 不再只看 `current.json`：指针可能已被撤销摘除，而更旧的写者记录仍在。
 * 这个值只作为回执里的证据字段，判定仍需用 `highestAllocatedGeneration`。
 */
function previousAllocatedGeneration(
  state: ScopeWriterState,
  requestedGeneration: number,
): number | null {
  const candidates = [
    ...state.writerRecords.map((record) => record.writerGeneration),
    ...(state.current ? [state.current.writerGeneration] : []),
  ].filter((generation) => generation < requestedGeneration);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

// ─── Broker ────────────────────────────────────────────────

/**
 * 受管 WorkspaceHost 的真实实现。
 *
 * 关键不变量：
 * - 身份来自 `observeIdentity()` 的实际探测，且持久化（进程重启不换身份）。
 * - 同一物理 root 只允许一个 tenant 声明（跨 tenant 复用 → 拒绝准入）。
 * - `activateWriter` 会真实停止上一个 generation 的 Writer 进程组，确认退出后才发回执；
 *   没有实际检查就不会出现 `oldWriterRevoked/processGroupEmpty = true`。
 * - operation 回执持久化，重复 operation 返回同一 receipt 且不回退 generation。
 */
export class WorkspaceHostBroker implements WorkspaceHost {
  private readonly rootOverride: string;
  private readonly managedRootOverride: string;
  private readonly hostIdentityOverride: string | null;
  private readonly storage: SnapshotStorage;
  private readonly testHooks: {
    beforeFreezeScopeLock?: () => Promise<void>;
    afterReleaseBarrierRemoved?: () => Promise<void>;
  } | null;
  private controlRootCache: string | null = null;

  constructor(input: {
    root: string;
    /** 实际受管写根；省略时等于控制面根。 */
    managedRoot?: string;
    hostIdentity?: string;
    snapshotStorage?: SnapshotStorage;
    /** 仅供真实并发测试控制交错；生产装配不得传入。 */
    testHooks?: {
      beforeFreezeScopeLock?: () => Promise<void>;
      afterReleaseBarrierRemoved?: () => Promise<void>;
    };
  }) {
    this.rootOverride = path.resolve(input.root);
    this.managedRootOverride = path.resolve(input.managedRoot ?? input.root);
    this.hostIdentityOverride = input.hostIdentity?.trim() || null;
    this.testHooks = input.testHooks ?? null;
    this.storage =
      input.snapshotStorage ?? new FileSnapshotStorage(path.join(this.rootOverride, SNAPSHOT_DIR));
  }

  /** 控制面根：候选目录、grants、operation 回执、身份记录都放这里，绝不与写根混同。 */
  private async controlRoot(): Promise<string> {
    if (!this.controlRootCache) {
      await mkdir(this.rootOverride, { recursive: true });
      this.controlRootCache = path.join(await realpath(this.rootOverride), CONTROL_DIR);
    }
    return this.controlRootCache;
  }

  // ── 身份 ───────────────────────────────────────────────

  /** 实际探测本 Workspace 的 Host/存储身份与物理 scope。 */
  async probeIdentity(): Promise<WorkspaceHostIdentityProbe> {
    return this.observeIdentity();
  }

  private async observeIdentity(): Promise<WorkspaceHostIdentityProbe> {
    await mkdir(this.managedRootOverride, { recursive: true });
    const controlRoot = await this.controlRoot();
    // 被探测的是**实际写根**：它的真实路径与磁盘身份决定 scope。
    const canonicalRoot = await resolveReal(this.managedRootOverride);
    const identityFile = path.join(controlRoot, WORKSPACE_IDENTITY_FILE);
    const stats = await stat(canonicalRoot);
    const deviceId = String(stats.dev);
    const inode = String(stats.ino);

    let record = await readJson<WorkspaceIdentityRecord>(identityFile);
    if (!record) {
      await writeJsonExclusive(identityFile, {
        schemaVersion: 1,
        workspaceId: randomUUID(),
        canonicalRoot,
        deviceId,
        inode,
        createdAt: new Date().toISOString(),
      } satisfies WorkspaceIdentityRecord);
      record = await readJson<WorkspaceIdentityRecord>(identityFile);
    }
    if (!record) throw new WorkspaceIdentityMismatchError("Workspace 身份记录不可读");
    // 路径名相同但磁盘/Host 身份已更换 → 连续性未证明（不承认空目录）。
    if (
      record.canonicalRoot !== canonicalRoot ||
      record.deviceId !== deviceId ||
      record.inode !== inode
    ) {
      throw new WorkspaceIdentityMismatchError(
        `实际存储身份与持久记录不一致（root ${record.canonicalRoot} → ${canonicalRoot}）`,
      );
    }
    const hostIdentity = await this.readOrCreateHostIdentity(controlRoot);
    const storageIdentity = computeCanonicalDigest({
      schemaVersion: record.schemaVersion,
      workspaceId: record.workspaceId,
      canonicalRoot,
      deviceId,
      inode,
    });
    const scopeDigest = computeCanonicalDigest({ hostIdentity, canonicalRoot, storageIdentity });
    return {
      hostIdentity,
      canonicalRoot,
      workspaceId: record.workspaceId,
      deviceId,
      inode,
      storageIdentity,
      scopeDigest,
    };
  }

  private async readOrCreateHostIdentity(controlRoot: string): Promise<string> {
    const file = path.join(controlRoot, HOST_IDENTITY_FILE);
    const existing = await readJson<HostIdentityRecord>(file);
    if (this.hostIdentityOverride) {
      if (existing && existing.hostIdentity !== this.hostIdentityOverride) {
        throw new WorkspaceIdentityMismatchError("注入的 hostIdentity 与持久记录不一致");
      }
      await writeJsonExclusive(file, {
        hostIdentity: this.hostIdentityOverride,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      } satisfies HostIdentityRecord);
      return this.hostIdentityOverride;
    }
    if (existing?.hostIdentity) return existing.hostIdentity;
    // 确定性派生（不使用随机值）：同一持久 root 在重启后仍是同一 Host 身份。
    const derived = `host:${sha256Hex(await resolveReal(this.rootOverride))}`;
    await writeJsonExclusive(file, {
      hostIdentity: derived,
      createdAt: new Date().toISOString(),
    } satisfies HostIdentityRecord);
    const persisted = await readJson<HostIdentityRecord>(file);
    return persisted?.hostIdentity ?? derived;
  }

  /** 同一物理写范围只能属于一个 tenant：两个租户映射同一 root 时拒绝准入。 */
  private async claimScope(tenantId: string, scopeDigest: string): Promise<void> {
    const file = path.join(await this.controlRoot(), SCOPE_CLAIM_FILE);
    const existing = await readJson<ScopeClaimRecord>(file);
    if (existing) {
      if (existing.scopeDigest !== scopeDigest) {
        throw new WorkspaceIdentityMismatchError("物理 scope 与持久声明的 scope 不一致");
      }
      if (existing.tenantId !== tenantId) {
        throw new WorkspaceTenantConflictError("同一物理 Workspace 已被其他 tenant 占用");
      }
      return;
    }
    await writeJsonExclusive(file, {
      scopeDigest,
      tenantId,
      claimedAt: new Date().toISOString(),
    } satisfies ScopeClaimRecord);
    const after = await readJson<ScopeClaimRecord>(file);
    if (!after || after.scopeDigest !== scopeDigest || after.tenantId !== tenantId) {
      throw new WorkspaceTenantConflictError("同一物理 Workspace 已被其他 tenant 占用");
    }
  }

  // ── 路径 ───────────────────────────────────────────────

  private async grantsRootFor(scopeDigest: string): Promise<string> {
    return path.join(await this.controlRoot(), GRANTS_DIR, safeComponent(scopeDigest));
  }
  private async writerRecordPath(scopeDigest: string, generation: number): Promise<string> {
    return path.join(
      await this.controlRoot(),
      WRITERS_DIR,
      `${safeComponent(scopeDigest)}.${generation}.json`,
    );
  }
  private async operationPath(operationId: string): Promise<string> {
    return path.join(await this.controlRoot(), OPERATIONS_DIR, `${sha256Hex(operationId)}.json`);
  }
  /** 撤销墓碑：grant 是否还能被承认，靠这份持久事实而不是进程是否还在。 */
  private async revokedWriterPath(scopeDigest: string, generation: number): Promise<string> {
    return path.join(await this.grantsRootFor(scopeDigest), REVOKED_DIR, `${generation}.json`);
  }
  private async readWriterRevocation(
    scopeDigest: string,
    generation: number,
  ): Promise<WriterRevocationRecord | null> {
    return readJson<WriterRevocationRecord>(await this.revokedWriterPath(scopeDigest, generation));
  }

  /**
   * 读出某代际的**持久归属快照**（A07 决策五）。
   *
   * 事实来源必须是 Broker 自己落盘的东西：`workspace-scope.json`（这个物理 scope 属于哪个
   * tenant）+ `grants/<generation>.json`（该代际被授予给了哪一段执行权）。
   *
   * 刻意**不**用 `current.json` 当基准：它会被撤销摘掉、也会被下一代整体覆盖 —— 拿它比对
   * 等于"谁最新谁说了算"，迟到的旧补偿照样能停掉新 Writer。`grants/<generation>.json`
   * 是**每代独立**的，永不被后续代际改写，因此能回答"第 N 代当时是谁的"。
   *
   * 返回 null 表示这一代从未被授予过（没有可核对的归属）。
   */
  private async readWriterAttribution(
    scopeDigest: string,
    generation: number,
  ): Promise<WorkspaceWriterIdentity | null> {
    const claim = await readJson<ScopeClaimRecord>(
      path.join(await this.controlRoot(), SCOPE_CLAIM_FILE),
    );
    if (!claim || claim.scopeDigest !== scopeDigest) return null;
    const grant = await readJson<WorkspaceWriterGrant>(
      path.join(await this.grantsRootFor(scopeDigest), `${generation}.json`),
    );
    if (!grant) return null;
    return writerIdentityOf(grant, claim.tenantId);
  }
  private async freezePath(scopeDigest: string): Promise<string> {
    return path.join(await this.grantsRootFor(scopeDigest), FREEZE_FILE);
  }
  private async readFreeze(scopeDigest: string): Promise<WorkspaceFreezeRecord | null> {
    return readJson<WorkspaceFreezeRecord>(await this.freezePath(scopeDigest));
  }
  private async safePointIntentPath(
    scopeDigest: string,
    checkpointIntentId: string,
  ): Promise<string> {
    return path.join(
      await this.controlRoot(),
      SAFE_POINT_INTENTS_DIR,
      safeComponent(scopeDigest),
      `${safeIntentComponent(checkpointIntentId)}.json`,
    );
  }
  private async readSafePointIntent(
    scopeDigest: string,
    checkpointIntentId: string,
  ): Promise<SafePointIntentRecord | null> {
    const file = await this.safePointIntentPath(scopeDigest, checkpointIntentId);
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as SafePointIntentRecord;
      if (
        !["frozen", "releasing", "released"].includes(parsed.state) ||
        parsed.checkpointIntentId !== checkpointIntentId ||
        parsed.scopeDigest !== scopeDigest ||
        !Number.isSafeInteger(parsed.writerGeneration) ||
        typeof parsed.anchorDigest !== "string" ||
        typeof parsed.frozenAt !== "string"
      ) {
        throw new WorkspaceWriterNotFencedError("安全点 intent 记录损坏");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof WorkspaceWriterNotFencedError) throw error;
      throw new WorkspaceWriterNotFencedError("安全点 intent 记录无法解析");
    }
  }
  private async persistSafePointIntent(record: SafePointIntentRecord): Promise<void> {
    await writeJsonDurable(
      await this.safePointIntentPath(record.scopeDigest, record.checkpointIntentId),
      record,
    );
  }
  private async candidateClaimPath(operationId: string): Promise<string> {
    return path.join(await this.controlRoot(), CANDIDATES_DIR, `${sha256Hex(operationId)}.json`);
  }
  /**
   * 候选运行目录（A06）：受管写根内、控制面目录外。
   *
   * 它是**真实 Workspace 内容根**，因此必须满足 `activateWriter` 的两条约束：
   * 在受管物理根内、不在控制面目录内。归属登记仍在控制面（`candidateClaimPath`），
   * 清理/幂等/越权判定都靠那份登记，不靠目录位置。
   */
  private async candidateWorkRoot(
    candidateAttemptId: string,
    operationId: string,
  ): Promise<string> {
    const probe = await this.observeIdentity();
    return path.join(probe.canonicalRoot, RUNS_DIR, candidateAttemptId, operationId);
  }

  // ── 准备 ───────────────────────────────────────────────

  async prepare(input: {
    candidateAttemptId: string;
    revisionId: string;
    workspaceBindingId: string;
    operationId: string;
  }): Promise<WorkspacePreparation> {
    const candidateRoot = await this.candidateWorkRoot(input.candidateAttemptId, input.operationId);
    const claimFile = await this.candidateClaimPath(input.operationId);
    const existing = await readJson<CandidateClaimRecord>(claimFile);
    if (existing) {
      // 资源创建前已登记稳定 operation 归属：重复 prepare 返回同一归属，不重复创建无主资源。
      if (
        existing.candidateRoot !== candidateRoot ||
        existing.candidateAttemptId !== input.candidateAttemptId
      ) {
        throw new WorkspaceWriterNotFencedError("Candidate operation 已被其他资源占用");
      }
      await mkdir(candidateRoot, { recursive: true });
      return {
        resourceId: `candidate:${existing.candidateAttemptId}:${existing.operationId}`,
        candidateRoot,
        operationId: existing.operationId,
        candidateAttemptId: existing.candidateAttemptId,
        revisionId: existing.revisionId,
        workspaceBindingId: existing.workspaceBindingId,
      };
    }
    await mkdir(candidateRoot, { recursive: true });
    await writeJsonExclusive(claimFile, {
      operationId: input.operationId,
      candidateAttemptId: input.candidateAttemptId,
      revisionId: input.revisionId,
      workspaceBindingId: input.workspaceBindingId,
      candidateRoot,
      createdAt: new Date().toISOString(),
    } satisfies CandidateClaimRecord);
    return {
      resourceId: `candidate:${input.candidateAttemptId}:${input.operationId}`,
      candidateRoot,
      operationId: input.operationId,
      candidateAttemptId: input.candidateAttemptId,
      revisionId: input.revisionId,
      workspaceBindingId: input.workspaceBindingId,
    };
  }

  // ── Writer 激活 ────────────────────────────────────────

  async activateWriter(input: {
    tenantId: string;
    scopeDigest: string;
    writerGeneration: number;
    authority: AuthorityIdentity;
    expectedStorageIdentity: string;
    operationId: string;
    root: string;
  }): Promise<WorkspaceWriterGrant> {
    const probe = await this.observeIdentity();
    // 调用方提交的 scope 必须与实际物理身份一致，不能靠 Binding ID 绕过。
    if (probe.scopeDigest !== input.scopeDigest) {
      throw new WorkspaceWriterNotFencedError("实际存储 scope 与冻结 scope 不一致");
    }
    if (!input.expectedStorageIdentity) {
      throw new WorkspaceWriterNotFencedError("缺少冻结 storageIdentity");
    }
    // 实际探测身份与 Binding 冻结身份比对：不接受"照抄 expected"的伪回执。
    if (probe.storageIdentity !== input.expectedStorageIdentity) {
      throw new WorkspaceIdentityMismatchError("实际存储身份与冻结 storageIdentity 不一致");
    }
    await this.claimScope(input.tenantId, probe.scopeDigest);

    const writerRoot = await resolveReal(input.root);
    if (!isInside(probe.canonicalRoot, writerRoot)) {
      throw new WorkspaceWriterNotFencedError("Writer root 不在受管 Workspace 物理根内");
    }
    const controlRoot = await this.controlRoot();
    if (isInside(controlRoot, writerRoot)) {
      throw new WorkspaceWriterNotFencedError("Writer root 不能是控制面目录");
    }

    // 跨进程串行化：读 current → 停旧 Writer → 写 grant/current → 落回执 必须在同一临界区内，
    // 否则晚到的低代际会覆盖高代际，出现"两个 JSON 写者各算成功"。
    return this.withScopeLock(probe.scopeDigest, probe.hostIdentity, async () => {
      // 回执幂等：同一 operation 重放（响应丢失后的重试）返回同一 receipt，不回退 generation。
      const receiptKey = `activate:${input.operationId}`;
      const recorded = await readJson<BackendOperationReceipt>(
        await this.operationPath(receiptKey),
      );
      if (recorded) {
        const recordedGrant = recorded.receipt as WorkspaceWriterGrant;
        // A07 7.2：幂等命中**不能**无条件复用回执。operationId 里可能缺少 Ownership/Epoch，
        // 于是"同一 Attempt 的下一个正式代际"会撞上旧回执，拿到一个属于旧 Owner 的物理授权。
        // 重放合法的前提是"这是同一请求"，因此必须逐项核对本次提交的完整身份。
        const mismatch = activationRequestMismatch(recordedGrant, {
          scopeDigest: input.scopeDigest,
          writerGeneration: input.writerGeneration,
          invocationId: input.authority.invocationId,
          attemptId: input.authority.attemptId,
          ownershipId: input.authority.ownershipId,
          leaseEpoch: input.authority.leaseEpoch,
          writerRoot,
        });
        if (mismatch) {
          throw new WorkspaceWriterNotFencedError(`同一 operation 的重放身份不一致：${mismatch}`);
        }
        // A07 决策二：回执是**历史成功收据**，不是"授权现在仍然有效"的证明。
        // 已撤销的代际、或当前授权指针已不再属于该代际的旧回执，都不能因为这份 JSON
        // 还在盘上就把物理写权发回去 —— 否则"重放"就成了复活旧写者的旁路。
        if (await this.readWriterRevocation(input.scopeDigest, input.writerGeneration)) {
          throw new WorkspaceWriterNotFencedError(
            `generation ${input.writerGeneration} 的激活回执已失效：该代际已被撤销`,
          );
        }
        const liveCurrent = await this.readCurrentWriter(input.scopeDigest);
        if (
          !liveCurrent ||
          liveCurrent.writerGeneration !== input.writerGeneration ||
          JSON.stringify(grantIdentity(liveCurrent)) !==
            JSON.stringify(grantIdentity(recordedGrant))
        ) {
          throw new WorkspaceWriterNotFencedError(
            `generation ${input.writerGeneration} 的激活回执已失效：当前授权指针不属于该代际`,
          );
        }
        return recordedGrant;
      }

      // A07 决策二：激活的核对基准是**物理写者全集**，不是 `current.json`。
      // 撤销会把 current 指针整体摘掉；只看指针，就会让"已被撤销且可能仍有进程"的旧代际
      // 凭空消失，下一代照样拿到写权 —— 那正是"两个可写者"的来源。
      const state = await this.readScopeWriterState(probe.scopeDigest);
      if (state.highestAllocatedGeneration > input.writerGeneration) {
        throw new WorkspaceWriterNotFencedError(
          `Backend 已分配更高 writer generation（已分配 ${state.highestAllocatedGeneration} > 请求 ${input.writerGeneration}）`,
        );
      }
      // 指针被摘掉之后，最高代际依旧由账本/墓碑/记录维持；被撤销的代际更不能被复用。
      if (state.revokedGenerations.includes(input.writerGeneration)) {
        throw new WorkspaceWriterNotFencedError(
          `writer generation ${input.writerGeneration} 已被撤销，不得复用该代际`,
        );
      }
      const current = state.current;
      const candidateGrant = this.buildGrant({
        probe,
        input,
        writerRoot,
        previousWriterGeneration: previousAllocatedGeneration(state, input.writerGeneration),
        stop: null,
      });
      if (current && current.writerGeneration === input.writerGeneration) {
        if (
          JSON.stringify(grantIdentity(current)) !== JSON.stringify(grantIdentity(candidateGrant))
        ) {
          throw new WorkspaceWriterNotFencedError("同 generation 的 writer 身份冲突");
        }
        await this.recordAllocatedGeneration(probe.scopeDigest, input.writerGeneration);
        await this.writeCurrentWriter(probe.scopeDigest, current, input.operationId);
        await writeJsonStable(await this.operationPath(receiptKey), {
          operationId: receiptKey,
          receipt: current,
          recordedAt: new Date().toISOString(),
        } satisfies BackendOperationReceipt);
        return current;
      }

      // 真实的旧 Writer 撤销：停止**全部更旧且未确认停止**的执行组并确认退出。
      // 只停 `current` 是不够的 —— 指针丢失过的更旧代际仍可能有进程在写。
      // 任一无法确认就拒绝激活：这是可重试 / 告警，不是"继续跑"。
      const outcomes = await this.stopUnreconciledWriters(
        probe.scopeDigest,
        input.writerGeneration,
      );
      const blocked = outcomes.filter(
        (outcome) => !(outcome.evidence.stopped && outcome.evidence.processGroupEmpty),
      );
      if (blocked.length > 0) {
        throw new WorkspaceWriterNotFencedError(
          `旧 Writer 进程组未确认停止：${blocked
            .map((outcome) => `generation ${outcome.writerGeneration}（${outcome.reason}）`)
            .join("、")}；定位记录已保留，必须重试或人工处置后才能激活下一代`,
        );
      }
      const stop = mergeStopEvidence(outcomes.map((outcome) => outcome.evidence));
      const grant = this.buildGrant({
        probe,
        input,
        writerRoot,
        previousWriterGeneration: previousAllocatedGeneration(state, input.writerGeneration),
        stop,
      });
      await this.recordAllocatedGeneration(probe.scopeDigest, input.writerGeneration);
      await this.writeGrantRecord(probe.scopeDigest, grant);
      await this.writeCurrentWriter(probe.scopeDigest, grant, input.operationId);
      await writeJsonStable(await this.operationPath(receiptKey), {
        operationId: receiptKey,
        receipt: grant,
        recordedAt: new Date().toISOString(),
      } satisfies BackendOperationReceipt);
      return grant;
    });
  }

  /**
   * 物理 scope 的跨进程临界区（A07 决策一）。
   *
   * 内核排他锁落在**稳定锁文件**上（`lib/workspace/scope-lock.ts` → `native/workspace-lock`）：
   *
   * - 同 scope 的所有 Broker 进程/实例算出同一个锁文件路径，因此在同一把内核锁上排队；
   * - 持锁进程被 SIGKILL 由 OS 释放，无需（也不再允许）任何"过期持有者回收"；
   * - 锁文件**从不** rename/unlink/按 mtime 删除 —— 那正是审查报告点出的路径替换竞争；
   * - 等待是非阻塞尝试 + 有界异步等待，不会阻塞事件循环（heartbeat 保持可用）；
   * - 超时抛 `ScopeLockBusyError`（可重试占用），绝不触碰现有持有者的锁。
   */
  private async withScopeLock<T>(
    scopeDigest: string,
    hostIdentity: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const lockPath = scopeLockFilePath(await this.grantsRootFor(scopeDigest));
    try {
      return await withNativeScopeLock({ lockPath, hostIdentity, run });
    } catch (error) {
      // 等待超时是**可重试占用**，不是"已确认未 fence"。对外仍收敛到 Broker 既有的
      // `WorkspaceWriterNotFenced` 分类（调用方按该稳定串判定），具体原因放 detail。
      if (error instanceof ScopeLockBusyError) {
        throw new WorkspaceWriterNotFencedError(
          `scope 锁在 ${error.waitedMs}ms 内不可取得（可重试占用，非物理停止证据）path=${lockPath}${
            error.holderDiagnostic ? `；持有者诊断 ${error.holderDiagnostic}` : ""
          }`,
        );
      }
      // provider 不可用是环境错误：绝不能退化成"没有锁也能写"。
      if (error instanceof ScopeLockUnavailableError) {
        throw new WorkspaceWriterNotFencedError(`scope 内核锁不可用：${error.message}`);
      }
      throw error;
    }
  }

  private buildGrant(input: {
    probe: WorkspaceHostIdentityProbe;
    input: {
      tenantId: string;
      scopeDigest: string;
      writerGeneration: number;
      authority: AuthorityIdentity;
      root: string;
      operationId: string;
    };
    writerRoot: string;
    previousWriterGeneration: number | null;
    stop: WriterStopEvidence | null;
  }): WorkspaceWriterGrant {
    const stop = input.stop;
    return {
      scopeDigest: input.input.scopeDigest,
      writerGeneration: input.input.writerGeneration,
      invocationId: input.input.authority.invocationId,
      attemptId: input.input.authority.attemptId,
      ownershipId: input.input.authority.ownershipId,
      leaseEpoch: input.input.authority.leaseEpoch,
      grantRef: `grant:${input.input.scopeDigest}:${input.input.writerGeneration}`,
      root: input.writerRoot,
      operationId: input.input.operationId,
      oldWriterRevoked: stop ? stop.stopped && stop.processGroupEmpty : true,
      backendEvidence: {
        hostIdentity: input.probe.hostIdentity,
        storageIdentity: input.probe.storageIdentity,
        workspaceId: input.probe.workspaceId,
        canonicalRoot: input.probe.canonicalRoot,
        scopeDigest: input.input.scopeDigest,
        writerGeneration: input.input.writerGeneration,
        writerRoot: input.writerRoot,
        previousWriterGeneration: input.previousWriterGeneration,
        previousWriterPresent: stop?.previousWriterPresent ?? false,
        oldWriterRevoked: stop ? stop.stopped && stop.processGroupEmpty : true,
        processGroupEmpty: stop?.processGroupEmpty ?? true,
        drained: stop?.drained ?? true,
        stopSignals: stop?.signals ?? [],
        stoppedPids: stop?.pids ?? [],
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  private async writeGrantRecord(scopeDigest: string, grant: WorkspaceWriterGrant): Promise<void> {
    const grantsRoot = await this.grantsRootFor(scopeDigest);
    await mkdir(grantsRoot, { recursive: true });
    const location = path.join(grantsRoot, `${grant.writerGeneration}.json`);
    const existing = await readJson<WorkspaceWriterGrant>(location);
    if (existing) {
      if (JSON.stringify(grantIdentity(existing)) !== JSON.stringify(grantIdentity(grant))) {
        throw new WorkspaceWriterNotFencedError("同 generation 的 writer 记录冲突");
      }
      return;
    }
    const staging = `${location}.${sha256Hex(grant.operationId).slice(0, 12)}.staging`;
    await writeFile(staging, JSON.stringify(grant), { flag: "wx" }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    await rename(staging, location);
  }

  private async writeCurrentWriter(
    scopeDigest: string,
    grant: WorkspaceWriterGrant,
    operationId: string,
  ): Promise<void> {
    const grantsRoot = await this.grantsRootFor(scopeDigest);
    await mkdir(grantsRoot, { recursive: true });
    const location = path.join(grantsRoot, "current.json");
    const staging = path.join(grantsRoot, `current.${sha256Hex(operationId).slice(0, 12)}.staging`);
    await writeFile(staging, JSON.stringify(grant), { flag: "wx" }).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        const staged = await readJson<WorkspaceWriterGrant>(staging);
        if (!staged || JSON.stringify(staged) !== JSON.stringify(grant)) {
          throw new WorkspaceWriterNotFencedError("current writer 暂存冲突");
        }
      },
    );
    await rename(staging, location);
  }

  private async readCurrentWriter(scopeDigest: string): Promise<WorkspaceWriterGrant | null> {
    return readJson<WorkspaceWriterGrant>(
      path.join(await this.grantsRootFor(scopeDigest), "current.json"),
    );
  }

  // ── 物理写者全集（A07 决策二） ───────────────────────────

  private async ledgerPath(scopeDigest: string): Promise<string> {
    return path.join(await this.grantsRootFor(scopeDigest), LEDGER_FILE);
  }

  /**
   * 把某代际登记进高水位账本（单调，只增不减）。
   *
   * 撤销会摘掉 `current.json`；如果没有账本，"最高代际"就只剩指针，
   * `activateWriter` 便可能接受一个比已分配代际更低（甚至已被撤销）的 generation。
   */
  private async recordAllocatedGeneration(scopeDigest: string, generation: number): Promise<void> {
    const ledger = await readJson<ScopeWriterLedgerRecord>(await this.ledgerPath(scopeDigest));
    const highest = Math.max(ledger?.highestAllocatedGeneration ?? 0, generation);
    await writeJsonStable(await this.ledgerPath(scopeDigest), {
      schemaVersion: 1,
      scopeDigest,
      highestAllocatedGeneration: highest,
      updatedAt: new Date().toISOString(),
    } satisfies ScopeWriterLedgerRecord);
  }

  /** 本 scope 的全部 Writer 归属记录（目录枚举，不依赖任何指针文件）。 */
  private async listWriterRecords(scopeDigest: string): Promise<WriterProcessRecord[]> {
    const component = safeComponent(scopeDigest);
    const dir = path.join(await this.controlRoot(), WRITERS_DIR);
    const names = await readdir(dir).catch(() => [] as string[]);
    const records: WriterProcessRecord[] = [];
    for (const name of names) {
      if (!name.startsWith(`${component}.`) || !name.endsWith(".json")) continue;
      const record = await readManagedWriterContainment<WriterProcessRecord>(path.join(dir, name));
      if (record) records.push(record);
    }
    return records.sort((left, right) => left.writerGeneration - right.writerGeneration);
  }

  /** 已分配过的代际（grant 记录文件 + 撤销墓碑 + 账本 + current 指针的并集）。 */
  private async listAllocatedGenerations(scopeDigest: string): Promise<number[]> {
    const grantsRoot = await this.grantsRootFor(scopeDigest);
    const revoked = await listGenerationFiles(path.join(grantsRoot, REVOKED_DIR));
    const grants = await listGenerationFiles(grantsRoot);
    const ledger = await readJson<ScopeWriterLedgerRecord>(await this.ledgerPath(scopeDigest));
    const records = await this.listWriterRecords(scopeDigest);
    const current = await this.readCurrentWriter(scopeDigest);
    return [
      ...new Set([
        ...grants,
        ...revoked,
        ...records.map((record) => record.writerGeneration),
        ...(ledger ? [ledger.highestAllocatedGeneration] : []),
        ...(current ? [current.writerGeneration] : []),
      ]),
    ].sort((left, right) => left - right);
  }

  /**
   * 读出这个 scope 的物理写者全集。
   *
   * 这是 `activateWriter` 在临界区里的核对基准：代际高水位、当前授权指针、
   * 每一代的撤销墓碑、以及**全部未确认停止的 Writer 记录**。
   */
  async readScopeWriterState(scopeDigest: string): Promise<ScopeWriterState> {
    const [current, records, allocations, revocations] = await Promise.all([
      this.readCurrentWriter(scopeDigest),
      this.listWriterRecords(scopeDigest),
      this.listAllocatedGenerations(scopeDigest),
      listGenerationFiles(path.join(await this.grantsRootFor(scopeDigest), REVOKED_DIR)),
    ]);
    const unreconciled: UnreconciledWriter[] = [];
    for (const record of records) {
      if (record.stop?.confirmed === true) continue;
      unreconciled.push({
        writerGeneration: record.writerGeneration,
        phase: record.phase,
        pid: record.pid,
        processGroupId: record.processGroupId,
        recordPath: await this.writerRecordPath(scopeDigest, record.writerGeneration),
        reason: writerUnreconciledReason(record),
      });
    }
    return {
      scopeDigest,
      highestAllocatedGeneration: allocations.at(-1) ?? 0,
      current,
      revokedGenerations: revocations.sort((left, right) => left - right),
      writerRecords: records,
      unreconciledWriters: unreconciled,
    };
  }

  /**
   * 真实停止**所有更旧且未确认停止**的写者。
   *
   * 返回逐代结果（含失败原因），由调用方决定是拒绝还是在重试后推进：
   * 本方法不做"猜一个 PID 就 kill"的事，也不删除任何未确认记录。
   */
  private async stopUnreconciledWriters(
    scopeDigest: string,
    requestedGeneration: number,
  ): Promise<Array<{ writerGeneration: number; reason: string; evidence: WriterStopEvidence }>> {
    const state = await this.readScopeWriterState(scopeDigest);
    const outcomes: Array<{
      writerGeneration: number;
      reason: string;
      evidence: WriterStopEvidence;
    }> = [];
    const stale = state.unreconciledWriters
      .filter((entry) => entry.writerGeneration < requestedGeneration)
      .sort((left, right) => left.writerGeneration - right.writerGeneration);
    for (const entry of stale) {
      const evidence = await this.stopWriterGeneration(scopeDigest, entry.writerGeneration);
      outcomes.push({
        writerGeneration: entry.writerGeneration,
        reason: entry.reason,
        evidence,
      });
    }
    return outcomes;
  }

  async getWriter(
    scopeDigest: string,
    writerGeneration: number,
  ): Promise<WorkspaceWriterGrant | null> {
    // A07 7.4：撤销之后不得再交出这份 grant —— "进程已停"不等于"授权已撤销"。
    if (await this.readWriterRevocation(scopeDigest, writerGeneration)) return null;
    const current = await this.readCurrentWriter(scopeDigest);
    if (!current || current.writerGeneration !== writerGeneration) return null;
    return current;
  }

  async assertWriter(grant: WorkspaceWriterGrant): Promise<void> {
    if (await this.readWriterRevocation(grant.scopeDigest, grant.writerGeneration)) {
      throw new WorkspaceWriterNotFencedError("该 writer 代际已被撤销");
    }
    const persisted = await this.readCurrentWriter(grant.scopeDigest);
    if (
      !persisted ||
      persisted.grantRef !== grant.grantRef ||
      persisted.writerGeneration !== grant.writerGeneration ||
      persisted.ownershipId !== grant.ownershipId ||
      persisted.attemptId !== grant.attemptId ||
      persisted.leaseEpoch !== grant.leaseEpoch ||
      !persisted.oldWriterRevoked
    ) {
      throw new WorkspaceWriterNotFencedError("当前 writer 不是该 grant");
    }
  }

  /**
   * 受管写入的唯一授权出口。
   *
   * 声明受管理的 Shell/File 写入必须先向 Broker 取得授权；只有当前 generation 的
   * 精确持有者能拿到可写根，未授权请求在真正 IO 之前被拒绝（不返回任何可写路径）。
   */
  async authorizeWrite(input: {
    scopeDigest: string;
    writerGeneration: number;
    ownershipId: string;
  }): Promise<{ root: string; writerGeneration: number; grantRef: string }> {
    const probe = await this.observeIdentity();
    if (probe.scopeDigest !== input.scopeDigest) {
      throw new WorkspaceWriterNotFencedError("实际存储 scope 与冻结 scope 不一致");
    }
    // A07 7.1：冻结期间不得再签发任何可写根。只靠"冻结时把 Writer 停了"不够 ——
    // 授权出口必须自己读屏障，否则冻结之后仍会有人拿到写路径。
    const freeze = await this.readFreeze(input.scopeDigest);
    if (freeze) {
      throw new WorkspaceWriterNotFencedError(
        `安全点冻结期间不接受写入授权（intent ${freeze.checkpointIntentId}）`,
      );
    }
    // A07 7.4：已撤销的代际即使还躺在 current.json 里也不得授权。
    if (await this.readWriterRevocation(input.scopeDigest, input.writerGeneration)) {
      throw new WorkspaceWriterNotFencedError("该 writer 代际已被撤销");
    }
    // A07 决策二：授权出口同样要核对"未确认停止的更旧写者集合"。
    // 冻结只覆盖其中一个方向；若更旧代际仍有未确认停止的写者，签发新写权就等于
    // 默认承认"两个可写者"。这条检查只看更旧代际，因此对正常路径是零代价的（无记录即通过）。
    const stale = (await this.listWriterRecords(input.scopeDigest)).filter(
      (record) =>
        record.writerGeneration < input.writerGeneration && record.stop?.confirmed !== true,
    );
    if (stale.length > 0) {
      throw new WorkspaceWriterNotFencedError(
        `存在未确认停止的更旧 Writer（${stale
          .map(
            (record) =>
              `generation ${record.writerGeneration}（${writerUnreconciledReason(record)}）`,
          )
          .join("、")}），拒绝签发写入授权`,
      );
    }
    const current = await this.readCurrentWriter(input.scopeDigest);
    if (
      !current ||
      current.writerGeneration !== input.writerGeneration ||
      current.ownershipId !== input.ownershipId ||
      !current.oldWriterRevoked
    ) {
      throw new WorkspaceWriterNotFencedError("写入未获当前 Writer 授权");
    }
    return {
      root: current.root,
      writerGeneration: current.writerGeneration,
      grantRef: current.grantRef,
    };
  }

  /**
   * 受管写入的**锁内**授权复核（A07 决策六）。
   *
   * 与 `authorizeWrite` 同样读屏障，但更严：它核对的是**完整归属身份**，而不是
   * `(generation, ownershipId)` 两个字段 —— 后者在"同 Attempt 换 Owner/Epoch"的重放
   * 场景下会承认一份属于旧执行的写权。返回这次写入真正归属的那份 grant。
   *
   * 本方法**只能**在 scope 临界区内调用；它是"冻结期无新增/缓存旁路写入"的实现点。
   */
  private async assertManagedWriteGrant(
    identity: WorkspaceWriterIdentity,
    what: string,
  ): Promise<WorkspaceWriterGrant> {
    const freeze = await this.readFreeze(identity.scopeDigest);
    if (freeze) {
      throw new WorkspaceWriterNotFencedError(
        `${what}：安全点冻结期间不接受受管写入（intent ${freeze.checkpointIntentId}）`,
      );
    }
    if (await this.readWriterRevocation(identity.scopeDigest, identity.writerGeneration)) {
      throw new WorkspaceWriterNotFencedError(`${what}：该 writer 代际已被撤销`);
    }
    const stale = (await this.listWriterRecords(identity.scopeDigest)).filter(
      (record) =>
        record.writerGeneration < identity.writerGeneration && record.stop?.confirmed !== true,
    );
    if (stale.length > 0) {
      throw new WorkspaceWriterNotFencedError(
        `${what}：存在未确认停止的更旧 Writer（${stale
          .map(
            (record) =>
              `generation ${record.writerGeneration}（${writerUnreconciledReason(record)}）`,
          )
          .join("、")}），拒绝受管写入`,
      );
    }
    const current = await this.readCurrentWriter(identity.scopeDigest);
    if (!current || !current.oldWriterRevoked) {
      throw new WorkspaceWriterNotFencedError(`${what}：写入未获当前 Writer 授权`);
    }
    const mismatch = writerIdentityMismatch(writerIdentityOf(current, identity.tenantId), identity);
    if (mismatch) {
      throw new WorkspaceWriterNotFencedError(
        `${what}：请求身份与当前 Writer 不一致（${mismatch}）`,
      );
    }
    return current;
  }

  /**
   * 受管 File 写/删的唯一入口（A07 决策六）。
   *
   * 关键性质：**授权复核与真实 IO 在同一个 scope 临界区里完成**。调用方拿不到一个
   * "稍后想写就写"的可写根，因此冻结一旦落盘，任何尚未执行的文件写入都会 fail closed ——
   * 这正是 `authorizeWrite` 单独无法保证的那一段（授权与 IO 之间的交错）。
   *
   * 幂等性说明：允许的操作只有 write(path, content) 与 delete(path)，重复执行结果相同，
   * 因此**不**另设 operation receipt 来判重；相反，写路径必须走 `grants/<generation>.json`
   * 的归属复核。设计稿提到的"稳定 operationId"在本题面下不产生可核对的事新事实，
   * 该偏离记录在 implementation-result.json。
   */
  async executeManagedFileOperation(input: {
    identity: WorkspaceWriterIdentity;
    operation: ManagedFileOperation;
  }): Promise<ManagedFileOperationResult> {
    const probe = await this.observeIdentity();
    if (probe.scopeDigest !== input.identity.scopeDigest) {
      throw new WorkspaceWriterNotFencedError("实际存储 scope 与请求 scope 不一致");
    }
    return await this.withScopeLock(probe.scopeDigest, probe.hostIdentity, async () => {
      const grant = await this.assertManagedWriteGrant(input.identity, "受管文件操作");
      const target = managedWriteTarget(grant.root, input.operation.path);
      try {
        if (input.operation.kind === "write") {
          secureManagedFileWrite(grant.root, input.operation.path, input.operation.content);
        } else {
          secureManagedFileDelete(grant.root, input.operation.path);
        }
      } catch (error) {
        throw new WorkspaceWriterNotFencedError(
          `受管文件操作拒绝了不安全路径：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { kind: input.operation.kind, path: target } satisfies ManagedFileOperationResult;
    });
  }

  // ── 真实进程组管理 ─────────────────────────────────────

  /**
   * 以受管 Writer 身份启动一个真实子进程（进程组 leader）。
   *
   * 只有持有该 generation 有效 grant 的调用方才允许启动；启动后的进程组归属 Broker，
   * 后续换代时由 Broker 真实终止它。
   */
  async spawnManagedWriter(input: {
    tenantId: string;
    scopeDigest: string;
    writerGeneration: number;
    command: string;
    args: string[];
    cwd: string;
    activityPath?: string | null;
  }): Promise<{ writerRef: string; pid: number; processGroupId: number }> {
    const probe = await this.observeIdentity();
    if (probe.scopeDigest !== input.scopeDigest) {
      throw new WorkspaceWriterNotFencedError("实际存储 scope 与冻结 scope 不一致");
    }
    await this.claimScope(input.tenantId, probe.scopeDigest);
    // A07 7.3：「读 grant → 确认没有存活 Writer → spawn → 登记 PID」必须在**同一临界区**。
    // 之前 `activateWriter` 有锁而这里没有，于是接管可以插在"检查旧 grant"与"spawn/登记"之间，
    // 平台认为旧 Writer 已清掉之后旧进程才被启动。
    return this.withScopeLock(probe.scopeDigest, probe.hostIdentity, async () => {
      const freeze = await this.readFreeze(probe.scopeDigest);
      if (freeze) {
        throw new WorkspaceWriterNotFencedError(
          `安全点冻结期间不接受受管 Writer 启动（intent ${freeze.checkpointIntentId}）`,
        );
      }
      if (await this.readWriterRevocation(probe.scopeDigest, input.writerGeneration)) {
        throw new WorkspaceWriterNotFencedError("该 writer 代际已被撤销");
      }
      const current = await this.readCurrentWriter(probe.scopeDigest);
      if (!current || current.writerGeneration !== input.writerGeneration) {
        throw new WorkspaceWriterNotFencedError("没有该 generation 的有效 writer grant");
      }
      const recordPath = await this.writerRecordPath(probe.scopeDigest, input.writerGeneration);
      const existing = await readManagedWriterContainment<WriterProcessRecord>(recordPath);
      if (existing) {
        // `spawning` 表示"确定启动过、但进程组未知"：绝不能当成"没有 Writer"。
        const possiblyAlive =
          existing.phase === "spawning" || (existing.pid !== null && processAlive(existing.pid));
        if (possiblyAlive) {
          throw new WorkspaceWriterNotFencedError("该 generation 已有(或可能有)存活的受管 Writer");
        }
      }
      // A07 决策三：用户 command 在 containment 定位**确认落盘之前**不得开始运行。
      // 启动流程本身负责 ①意图 → ②wrapper → ③持久定位 → ④GO 的顺序与失败收口。
      const launched = await startManagedWriter({
        recordPath,
        scopeDigest: probe.scopeDigest,
        writerGeneration: input.writerGeneration,
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        activityPath: input.activityPath ?? null,
      });
      return {
        writerRef: `writer:${probe.scopeDigest}:${input.writerGeneration}`,
        pid: launched.pid,
        processGroupId: launched.processGroupId,
      };
    });
  }

  /**
   * 真实撤销某代际的受管 Writer：停止进程组，并**让该 grant 立即失效**。
   *
   * A07 7.4：只杀进程组的撤销是不完整的 —— `getWriter`/`assertWriter`/`authorizeWrite`
   * 仍会承认 `current.json` 里那份 grant。撤销必须同时落一份持久墓碑，并把指向该代际的
   * `current.json` 摘掉；否则"DB 层可能还会拦"就成了唯一防线，而那不是物理撤销的证据。
   */
  async revokeWriterGeneration(identity: WorkspaceWriterIdentity): Promise<WriterStopEvidence> {
    const reason = "revoked_by_control_plane";
    const scopeDigest = identity.scopeDigest;
    const writerGeneration = identity.writerGeneration;
    const probe = await this.observeIdentity();
    return await this.withScopeLock(probe.scopeDigest, probe.hostIdentity, async () => {
      // A07 决策五：**先核对"要撤的是不是这一份归属"，再碰任何进程**。
      // 这一步必须发生在 `stopWriterGeneration` 之前 —— 一旦发了信号，误杀就已经是物理事实，
      // 事后回滚不了"另一个健康 Writer 的进程组已经被停掉"。
      const attribution = await this.readWriterAttribution(scopeDigest, writerGeneration);
      if (attribution) {
        const mismatch = writerIdentityMismatch(attribution, identity);
        if (mismatch) {
          throw new WorkspaceWriterNotFencedError(
            `撤销请求的精确身份与该代际的持久归属不一致（${mismatch}）：不做任何物理停止`,
          );
        }
      } else {
        // 没有持久归属 = 这一代从未被授予过物理写权，因此不存在"属于它的"containment。
        // 但盘上可能留有**无法归属**的写者记录（例如另一条路径登记过同一代际）：
        // 那种情况下绝不能凭编号去停它 —— fail closed，交由人工/重试处置。
        const orphan = await readManagedWriterContainment<WriterProcessRecord>(
          await this.writerRecordPath(scopeDigest, writerGeneration),
        );
        if (orphan && orphan.stop?.confirmed !== true) {
          throw new WorkspaceWriterNotFencedError(
            `generation ${writerGeneration} 有未确认停止的 containment，但盘上没有可核对的持久归属：拒绝按编号停止`,
          );
        }
      }
      const evidence = await this.stopWriterGeneration(scopeDigest, writerGeneration);
      await writeJsonStable(await this.revokedWriterPath(scopeDigest, writerGeneration), {
        scopeDigest,
        writerGeneration,
        reason,
        revokedAt: new Date().toISOString(),
        identity,
        evidence,
      } satisfies WriterRevocationRecord);
      // 先入账再摘指针：`current.json` 被摘掉之后，代际高水位仍必须由账本维持，
      // 否则下一代可以从一个"指针为空"的 scope 回退到更低（甚至已被撤销）的代际。
      await this.recordAllocatedGeneration(scopeDigest, writerGeneration);
      const current = await this.readCurrentWriter(scopeDigest);
      if (current?.writerGeneration === writerGeneration) {
        await rm(path.join(await this.grantsRootFor(scopeDigest), "current.json"), {
          force: true,
        }).catch(() => undefined);
      }
      return evidence;
    });
  }

  /**
   * 真实停止某代际的受管 Writer，并把**停止确认事实**写回它自己的记录。
   *
   * A07 决策二：
   * - `spawning`（只有启动意图、没有进程组定位）永远返回 `stopped: false`，
   *   记录保留为"未确认" —— 确定启动过却无法核验，就不能声明已停止；
   * - 只有在进程组实测清空**且** IO 排空之后才写 `confirmed = true`；
   * - 失败时**不删记录**，只累加尝试次数与失败原因，供重试与可审计处置；
   * - 记录即使已确认停止也保留（GC 与"停止事实"是两件事），因此"记录缺失"
   *   只意味着"这一代从未登记过进程"，而不是"曾经有过、被清掉了"。
   */
  private async stopWriterGeneration(
    scopeDigest: string,
    generation: number,
  ): Promise<WriterStopEvidence> {
    const recordPath = await this.writerRecordPath(scopeDigest, generation);
    const record = await readManagedWriterContainment<WriterProcessRecord>(recordPath);
    const signals: string[] = [];
    if (!record) {
      return {
        previousWriterPresent: false,
        stopped: true,
        processGroupEmpty: true,
        drained: true,
        signals,
        pids: [],
      };
    }
    // 已确认停止：直接返回那份实测证据。停止是幂等的物理事实，不重复发信号。
    if (record.stop?.confirmed === true) return record.stop.evidence;

    const attempts = (record.stop?.attempts ?? 0) + 1;
    const attemptedAt = new Date().toISOString();
    // A07 7.3：`spawning` 阶段只有"启动意图"，没有进程组。确定启动过、却无法核验，
    // 因此必须按"可能仍有写者"报告；声明 stopped=true 就等于把真实写者当成不存在。
    // 记录**保留**，让后续调用方（与运维）仍能看到这份归属。
    if (record.phase === "spawning" || record.processGroupId === null || record.pid === null) {
      const evidence: WriterStopEvidence = {
        previousWriterPresent: true,
        stopped: false,
        processGroupEmpty: false,
        drained: false,
        signals,
        pids: [],
      };
      await this.persistStopAttempt(recordPath, record, evidence, attempts, attemptedAt);
      return evidence;
    }
    const pids = [record.pid];
    if (await this.processGroupAlive(record.processGroupId)) {
      this.signalProcessGroup(record.processGroupId, "SIGTERM");
      signals.push("SIGTERM");
      await this.waitForProcessGroupExit(record.processGroupId, STOP_WAIT_MS);
    }
    if (await this.processGroupAlive(record.processGroupId)) {
      this.signalProcessGroup(record.processGroupId, "SIGKILL");
      signals.push("SIGKILL");
      await this.waitForProcessGroupExit(record.processGroupId, STOP_WAIT_MS);
    }
    const processGroupEmpty = !(await this.processGroupAlive(record.processGroupId));
    const drained = processGroupEmpty && (await this.awaitActivityDrain(record));
    const evidence: WriterStopEvidence = {
      previousWriterPresent: true,
      stopped: processGroupEmpty && drained,
      processGroupEmpty,
      drained,
      signals,
      pids,
    };
    await this.persistStopAttempt(recordPath, record, evidence, attempts, attemptedAt);
    return evidence;
  }

  /**
   * 把一次停止尝试写回**同一份记录**（A07 决策二）。
   *
   * 绝不 `rm(recordPath)`：记录里的进程组定位是后续重试的唯一依据，
   * 无条件删除等于把"无法确认"伪造成"没有写者"。
   */
  private async persistStopAttempt(
    recordPath: string,
    record: WriterProcessRecord,
    evidence: WriterStopEvidence,
    attempts: number,
    attemptedAt: string,
  ): Promise<void> {
    const confirmed = evidence.stopped && evidence.processGroupEmpty && evidence.drained;
    const locationless =
      record.phase === "spawning" || record.processGroupId === null || record.pid === null;
    // 停止证据同样是"崩溃后必须能回读"的事实，因此走持久写入。
    await writeJsonDurable(recordPath, {
      ...record,
      stop: {
        confirmed,
        confirmedAt: confirmed ? attemptedAt : null,
        lastAttemptAt: attemptedAt,
        attempts,
        lastFailure: confirmed
          ? null
          : locationless
            ? "只有启动意图、缺少可核验的进程组定位"
            : "进程组在停止等待窗口内未确认清空，或写入活动未排空",
        evidence,
      },
    } satisfies WriterProcessRecord);
  }

  /** 进程组内是否仍有存活成员（真实 `ps` 探测，不用内存推断）。 */
  private async processGroupAlive(processGroupId: number): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("ps", ["-Ao", "pgid="]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .some((value) => Number.parseInt(value, 10) === processGroupId);
    } catch {
      // 无法探测时按存活处理：fail closed 比误判"已退出"安全。
      return processAlive(processGroupId);
    }
  }

  private signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-processGroupId, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private async waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.processGroupAlive(processGroupId))) return;
      await delay(50);
    }
  }

  /** 排空：旧 Writer 的落盘活动文件大小/时间连续两次采样一致。 */
  private async awaitActivityDrain(record: WriterProcessRecord): Promise<boolean> {
    if (!record.activityPath) return true;
    try {
      const first = await stat(record.activityPath);
      await delay(DRAIN_SAMPLE_MS);
      const second = await stat(record.activityPath);
      return first.size === second.size && first.mtimeMs === second.mtimeMs;
    } catch {
      return true;
    }
  }

  // ── 安全点 / 快照 ──────────────────────────────────────

  /**
   * 建立**物理**安全点：不是只写一份 JSON 回执。
   *
   * A07 7.1：回执形状合法不足以证明"扫描期间没有写入"。冻结必须
   * 1) 在同一临界区内确认该代际的受管 Writer 进程组已停止并排空（否则拒绝冻结）；
   * 2) 落下持久写屏障，使 `authorizeWrite`/`spawnManagedWriter` 从此刻起一律 fail closed。
   * 顺序是先停 Writer、后落屏障，且全程持锁 —— 因此屏障生效后不可能再出现新的写者。
   */
  async freeze(input: {
    grant: WorkspaceWriterGrant;
    checkpointIntentId: string;
    anchorDigest: string;
  }): Promise<SafePointReceipt> {
    const probe = await this.observeIdentity();
    if (probe.scopeDigest !== input.grant.scopeDigest) {
      throw new WorkspaceWriterNotFencedError("实际存储 scope 与冻结 grant 不一致");
    }
    await this.testHooks?.beforeFreezeScopeLock?.();
    return this.withScopeLock(probe.scopeDigest, probe.hostIdentity, async () => {
      // grant 的当前性必须在 scope 锁内复核；否则 activate/revoke 可插在复核与落屏障之间。
      await this.assertWriter(input.grant);
      const intentTuple = {
        checkpointIntentId: input.checkpointIntentId,
        scopeDigest: input.grant.scopeDigest,
        writerGeneration: input.grant.writerGeneration,
        anchorDigest: input.anchorDigest,
      };
      const intent = await this.readSafePointIntent(probe.scopeDigest, input.checkpointIntentId);
      if (intent && !sameSafePointTuple(intent, intentTuple)) {
        throw new WorkspaceWriterNotFencedError("同一 intent id 的物理冻结 tuple 冲突");
      }
      if (intent?.state === "releasing" || intent?.state === "released") {
        throw new CheckpointIntentRetiredError();
      }
      const existing = await this.readFreeze(probe.scopeDigest);
      if (existing) {
        if (sameSafePointTuple(existing, intentTuple)) {
          if (!intent) {
            throw new WorkspaceWriterNotFencedError("冻结屏障缺少物理 intent 记录");
          }
          return {
            checkpointIntentId: existing.checkpointIntentId,
            scopeDigest: existing.scopeDigest,
            writerGeneration: existing.writerGeneration,
            anchorDigest: existing.anchorDigest,
            frozenAt: existing.frozenAt,
          };
        }
        throw new WorkspaceWriterNotFencedError(
          `scope 已由另一安全点冻结（intent ${existing.checkpointIntentId}）`,
        );
      }
      const frozenAt = intent?.frozenAt ?? new Date().toISOString();
      const frozenIntent: SafePointIntentRecord = {
        ...intentTuple,
        state: "frozen",
        frozenAt,
        updatedAt: new Date().toISOString(),
      };
      // 先持久化可恢复的 freeze 意图；若进程死在停 Writer/落屏障前，
      // 同 tuple 重放会继续完成，release 也能先将其单向终结。
      await this.persistSafePointIntent(frozenIntent);
      const stopEvidence = await this.stopWriterGeneration(
        probe.scopeDigest,
        input.grant.writerGeneration,
      );
      if (!stopEvidence.stopped || !stopEvidence.processGroupEmpty) {
        throw new WorkspaceWriterNotFencedError("冻结未能确认已登记的受管 Writer 已停止");
      }
      const receipt: SafePointReceipt = {
        ...intentTuple,
        frozenAt,
      };
      await writeJsonStable(await this.freezePath(probe.scopeDigest), {
        scopeDigest: probe.scopeDigest,
        checkpointIntentId: input.checkpointIntentId,
        writerGeneration: input.grant.writerGeneration,
        anchorDigest: input.anchorDigest,
        frozenAt: receipt.frozenAt,
        stopEvidence,
      } satisfies WorkspaceFreezeRecord);
      await writeJsonStable(
        path.join(await this.controlRoot(), SAFE_POINTS_DIR, `${input.checkpointIntentId}.json`),
        receipt,
      );
      return receipt;
    });
  }

  async releaseFreeze(receipt: SafePointReceipt): Promise<void> {
    const probe = await this.observeIdentity();
    if (probe.scopeDigest !== receipt.scopeDigest) {
      throw new WorkspaceWriterNotFencedError("实际存储 scope 与解冻回执不一致");
    }
    // A07 7.1：屏障必须随解冻一起撤销，否则安全点结束后该 scope 永久拒绝写入。
    // 只撤销**完整 tuple 匹配**的屏障：迟到的旧 release 不得解掉更新的冻结。
    await this.withScopeLock(probe.scopeDigest, probe.hostIdentity, async () => {
      const intent = await this.readSafePointIntent(probe.scopeDigest, receipt.checkpointIntentId);
      if (intent && !sameSafePointTuple(intent, receipt)) {
        throw new WorkspaceWriterNotFencedError("同一 intent id 的物理释放 tuple 冲突");
      }
      const releasing: SafePointIntentRecord = {
        checkpointIntentId: receipt.checkpointIntentId,
        scopeDigest: receipt.scopeDigest,
        writerGeneration: receipt.writerGeneration,
        anchorDigest: receipt.anchorDigest,
        frozenAt: intent?.frozenAt ?? receipt.frozenAt,
        state: "releasing",
        updatedAt: new Date().toISOString(),
      };
      // releasing 是不可逆的终结决定：先持久它，再删屏障。删除失败会向上抛出，
      // 盘上仍为 releasing，后续原消费者可按同 tuple 续做。
      if (intent?.state !== "released") await this.persistSafePointIntent(releasing);
      const freeze = await this.readFreeze(probe.scopeDigest);
      if (freeze && sameSafePointTuple(freeze, receipt)) {
        // 匹配当前屏障时，物理删除失败就是 release 失败，必须沿 RPC 返回给持久维护 lane。
        // 只有文件本来不存在（`force:true`）或当前屏障属于更新 tuple 时才是幂等成功。
        await rm(await this.freezePath(probe.scopeDigest), { force: true });
        await this.testHooks?.afterReleaseBarrierRemoved?.();
      }
      await this.persistSafePointIntent({
        ...releasing,
        state: "released",
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async snapshot(input: {
    grant: WorkspaceWriterGrant;
    checkpointIntentId: string;
    anchorDigest: string;
    storage?: SnapshotStorageRef;
    requirements: SnapshotRequirements;
  }): Promise<SnapshotStorageReceipt> {
    const probe = await this.observeIdentity();
    if (probe.scopeDigest !== input.grant.scopeDigest) {
      throw new WorkspaceWriterNotFencedError("实际存储 scope 与快照 grant 不一致");
    }
    const storage = resolveSnapshotStorage(input.storage, this.storage);
    return this.withScopeLock(probe.scopeDigest, probe.hostIdentity, async () => {
      await this.assertWriter(input.grant);
      const freeze = await this.readFreeze(probe.scopeDigest);
      if (
        !freeze ||
        freeze.scopeDigest !== input.grant.scopeDigest ||
        freeze.checkpointIntentId !== input.checkpointIntentId ||
        freeze.writerGeneration !== input.grant.writerGeneration ||
        freeze.anchorDigest !== input.anchorDigest
      ) {
        throw new WorkspaceWriterNotFencedError("快照缺少与请求完整匹配的冻结屏障");
      }
      return (
        await storage.writeSnapshot(input.grant.root, input.checkpointIntentId, input.requirements)
      ).receipt;
    });
  }

  async restore(input: {
    manifestRef: string;
    manifestDigest: string;
    destination: string;
    storage?: SnapshotStorageRef;
    operationId?: string;
    requirements?: SnapshotRequirements;
  }): Promise<void> {
    const probe = await this.observeIdentity();
    const storage = resolveSnapshotStorage(input.storage, this.storage);
    const manifest = await storage.readManifest(
      input.manifestRef,
      input.manifestDigest,
      input.requirements,
    );
    await this.withScopeLock(probe.scopeDigest, probe.hostIdentity, () =>
      storage.restoreSnapshot(manifest, input.destination, input.operationId, input.requirements),
    );
  }

  // ── 清理 ───────────────────────────────────────────────

  async cleanup(preparation: WorkspacePreparation): Promise<void> {
    const probe = await this.observeIdentity();
    await this.withScopeLock(probe.scopeDigest, probe.hostIdentity, async () => {
      const canonicalRoot = probe.canonicalRoot;
      const controlRoot = await this.controlRoot();
      const expectedRoot = await resolveReal(
        path.join(canonicalRoot, RUNS_DIR, preparation.candidateAttemptId, preparation.operationId),
      );
      const target = await resolveReal(preparation.candidateRoot);
      // 绝不递归删除共享受管根或控制面目录。
      if (target === canonicalRoot || isInside(target, canonicalRoot)) {
        throw new WorkspaceCleanupRejectedError("拒绝清理受管 Workspace 共享根");
      }
      if (target === controlRoot || isInside(target, controlRoot)) {
        throw new WorkspaceCleanupRejectedError("拒绝清理控制面目录");
      }
      if (target !== expectedRoot) {
        throw new WorkspaceCleanupRejectedError("清理目标与 Candidate 注册归属不一致");
      }
      // 归属必须可回读：没有稳定 operation 登记的资源不允许被清理。
      const claim = await readJson<CandidateClaimRecord>(
        await this.candidateClaimPath(preparation.operationId),
      );
      const registered =
        claim !== null &&
        (await resolveReal(claim.candidateRoot)) === target &&
        claim.candidateAttemptId === preparation.candidateAttemptId;
      if (!registered) {
        // 目录已不存在 → 清理已完成，重复调用幂等成功；
        // 目录仍在而登记缺失 → 说明这不是本 Candidate 的注册资源，拒绝。
        if (await pathExists(target)) {
          throw new WorkspaceCleanupRejectedError("Candidate operation 归属不可回读");
        }
        return;
      }
      // 不触碰当前 Owner 的实际写根。
      const grantFiles = await readJson<WorkspaceWriterGrant>(
        path.join(await this.grantsRootFor(probe.scopeDigest), "current.json"),
      );
      // 只有当清理目标本身是当前 Owner 写根的祖先（删除它会毁掉在用的写根）才拒绝。
      if (grantFiles && isInside(target, grantFiles.root)) {
        throw new WorkspaceCleanupRejectedError("清理目标包含当前 Owner 的写根");
      }
      // Snapshot restore 的隔离候选与状态文件都由同一稳定 operation 派生；Candidate 被放弃时
      // 必须一起清掉，不能只删正式 target 而把半恢复 staging 留给后续进程误判为可续做。
      await rm(target, { recursive: true, force: true });
      await rm(`${target}.staging`, { recursive: true, force: true });
      await rm(`${target}.restore-state.json`, { force: true });
    });
  }
}

// ─── 工具 ──────────────────────────────────────────────────

function execFileAsync(file: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 进程是否存活（真实 signal 0 探测；EPERM 说明进程存在但无权操作）。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Grant 身份（不含易变 evidence）：回执幂等重放的比较基准。 */
/**
 * 从一份真实 grant 投影出**精确归属身份**（A07 决策五/六）。
 *
 * `tenantId` 不在 grant 里（它属于 scope 归属），因此由调用方显式给出。
 */
function writerIdentityOf(grant: WorkspaceWriterGrant, tenantId: string): WorkspaceWriterIdentity {
  return {
    tenantId,
    scopeDigest: grant.scopeDigest,
    writerGeneration: grant.writerGeneration,
    invocationId: grant.invocationId,
    attemptId: grant.attemptId,
    ownershipId: grant.ownershipId,
    operationId: grant.operationId,
  };
}

/**
 * 把受管文件操作的相对路径解析成受管根内的绝对路径（A07 决策六）。
 *
 * 只接受相对路径，并在解析后复核结果仍在根内：`..`、绝对路径、以及指向根自身的写法
 * 一律拒绝。控制端口因此不可能借"文件能力"去写根外的东西。
 */
function managedWriteTarget(root: string, relPath: string): string {
  if (!relPath || path.isAbsolute(relPath)) {
    throw new WorkspaceWriterNotFencedError("受管文件操作只接受受管根内的相对路径");
  }
  const base = path.resolve(root);
  const target = path.resolve(base, relPath);
  const rel = path.relative(base, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new WorkspaceWriterNotFencedError(`受管文件操作路径越出受管根：${relPath}`);
  }
  return target;
}

/**
 * 撤销请求与**持久归属**的逐项比对（A07 决策五）。
 *
 * 返回首个不一致的说明；`null` 表示逐字一致。刻意不做"generation 相等就算过"的短路 ——
 * 那正是"按编号停别人"的实现形态。
 */
function writerIdentityMismatch(
  attribution: WorkspaceWriterIdentity,
  requested: WorkspaceWriterIdentity,
): string | null {
  const pairs: Array<[keyof WorkspaceWriterIdentity, unknown, unknown]> = [
    ["tenantId", attribution.tenantId, requested.tenantId],
    ["scopeDigest", attribution.scopeDigest, requested.scopeDigest],
    ["writerGeneration", attribution.writerGeneration, requested.writerGeneration],
    ["invocationId", attribution.invocationId, requested.invocationId],
    ["attemptId", attribution.attemptId, requested.attemptId],
    ["ownershipId", attribution.ownershipId, requested.ownershipId],
    ["operationId", attribution.operationId, requested.operationId],
  ];
  for (const [field, actual, expected] of pairs) {
    if (actual !== expected) {
      return `${field}: 持久归属 ${String(actual)} ≠ 请求 ${String(expected)}`;
    }
  }
  return null;
}

function grantIdentity(grant: WorkspaceWriterGrant): Record<string, unknown> {
  return {
    scopeDigest: grant.scopeDigest,
    writerGeneration: grant.writerGeneration,
    invocationId: grant.invocationId,
    attemptId: grant.attemptId,
    ownershipId: grant.ownershipId,
    leaseEpoch: grant.leaseEpoch,
    grantRef: grant.grantRef,
    root: grant.root,
    oldWriterRevoked: grant.oldWriterRevoked,
  };
}

/** `activateWriter` 的**请求身份**（A07 7.2）：回执重放必须逐项命中这一组事实。 */
interface ActivationRequestIdentity {
  scopeDigest: string;
  writerGeneration: number;
  invocationId: string;
  attemptId: string;
  ownershipId: string;
  leaseEpoch: string;
  writerRoot: string;
}

/** 返回第一处不一致的字段名；完全一致返回 `null`（合法重放）。 */
function activationRequestMismatch(
  grant: WorkspaceWriterGrant,
  request: ActivationRequestIdentity,
): string | null {
  const pairs: Array<[keyof ActivationRequestIdentity, unknown, unknown]> = [
    ["scopeDigest", grant.scopeDigest, request.scopeDigest],
    ["writerGeneration", grant.writerGeneration, request.writerGeneration],
    ["invocationId", grant.invocationId, request.invocationId],
    ["attemptId", grant.attemptId, request.attemptId],
    ["ownershipId", grant.ownershipId, request.ownershipId],
    ["leaseEpoch", grant.leaseEpoch, request.leaseEpoch],
    ["writerRoot", grant.root, request.writerRoot],
  ];
  for (const [field, actual, expected] of pairs) {
    if (actual !== expected) return `${field}: 回执 ${String(actual)} ≠ 请求 ${String(expected)}`;
  }
  return null;
}

export function createWorkspaceHostBroker(input: {
  root: string;
  /** 实际受管写根；省略时等于控制面根。 */
  managedRoot?: string;
  hostIdentity?: string;
  snapshotStorage?: SnapshotStorage;
  /** 仅供真实并发测试控制交错；生产装配不得传入。 */
  testHooks?: {
    beforeFreezeScopeLock?: () => Promise<void>;
    afterReleaseBarrierRemoved?: () => Promise<void>;
  };
}): WorkspaceHostBroker {
  return new WorkspaceHostBroker(input);
}

// ─── RPC：两个独立 Broker 客户端 / 进程 ─────────────────────
//
// 真实部署形态是独立进程（scripts/workers/workspace-host.ts）。这里提供最小的
// 请求/响应通道，让"跨进程并发激活同一 scope"可以被真实复现与验证。

const RPC_METHODS = [
  "probeIdentity",
  "prepare",
  "activateWriter",
  "getWriter",
  "assertWriter",
  "authorizeWrite",
  "spawnManagedWriter",
  "revokeWriterGeneration",
  "executeManagedFileOperation",
  "freeze",
  "releaseFreeze",
  "snapshot",
  "restore",
  "cleanup",
] as const;
type RpcMethod = (typeof RPC_METHODS)[number];

export function createWorkspaceHostRpcServer(broker: WorkspaceHostBroker): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRpc(broker, request, response);
  });
}

async function handleRpc(
  broker: WorkspaceHostBroker,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/rpc") {
    response.writeHead(404).end();
    return;
  }
  const body = await readRequestBody(request);
  let parsed: { method?: string; params?: Record<string, unknown> };
  try {
    parsed = JSON.parse(body) as { method?: string; params?: Record<string, unknown> };
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ ok: false, error: { name: "BadRequest", message: "非法 JSON" } }),
    );
    return;
  }
  const method = parsed.method as RpcMethod | undefined;
  if (!method || !RPC_METHODS.includes(method)) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ ok: false, error: { name: "BadRequest", message: "未知 RPC 方法" } }),
    );
    return;
  }
  try {
    const target = broker as unknown as Record<
      string,
      ((...args: unknown[]) => unknown) | undefined
    >;
    const handler = target[method];
    if (!handler) throw new WorkspaceWriterNotFencedError(`Broker 未实现 ${method}`);
    const result = await handler.call(broker, ...paramsToArgs(method, parsed.params));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: result ?? null }));
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: { name, message } }));
  }
}

/**
 * params → 方法位置参数。
 *
 * 契约（A06 统一）：除下列多参方法外，**整个 params 对象就是该方法的唯一参数**。
 * 客户端不得再包一层（`{ receipt }` / `{ preparation }` 都会让服务端拿到包装对象）。
 */
function paramsToArgs(method: RpcMethod, params: Record<string, unknown> | undefined): unknown[] {
  const value = params ?? {};
  if (method === "getWriter") return [value.scopeDigest, value.writerGeneration];
  if (method === "assertWriter") return [value.grant];
  // `revokeWriterGeneration` 走默认分支：它的唯一参数就是**完整归属身份对象**。
  // 之前这里把位置参数摊平，正好把"按编号撤销"固化进了 RPC 契约。
  return [value];
}

/**
 * RPC 参数必须是**可序列化值**：普通对象/数组/原始值。
 *
 * 只检查到"原型必须是 Object.prototype 或 null"，因为那正好区分了
 * `{ kind: "file", root }` 这样的数据与 `new FileSnapshotStorage(...)` 这样的能力对象。
 */
function assertRpcSerializable(value: unknown, method: string, path = "$"): void {
  if (value === null) return;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return;
  if (type === "undefined") return;
  if (type === "function") {
    throw new WorkspaceRpcContractError(`RPC ${method} 参数含不可序列化值：${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertRpcSerializable(item, method, `${path}[${index}]`));
    return;
  }
  if (type !== "object") {
    throw new WorkspaceRpcContractError(`RPC ${method} 参数含不可序列化值：${path}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkspaceRpcContractError(
      `RPC ${method} 参数含带方法/原型的实例：${path}（控制端口只传可序列化值）`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    assertRpcSerializable(record[key], method, `${path}.${key}`);
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** 通过 RPC 访问另一个 Broker 进程（独立客户端）。 */
export function createRemoteWorkspaceHost(baseUrl: string): WorkspaceHost & {
  probeIdentity(): Promise<WorkspaceHostIdentityProbe>;
  spawnManagedWriter(input: {
    tenantId: string;
    scopeDigest: string;
    writerGeneration: number;
    command: string;
    args: string[];
    cwd: string;
    activityPath?: string | null;
  }): Promise<{ writerRef: string; pid: number; processGroupId: number }>;
  /** 撤销必须携带完整归属身份（A07 决策五），契约与 `WorkspaceHost` 逐字一致。 */
  revokeWriterGeneration(identity: WorkspaceWriterIdentity): Promise<WriterStopEvidence>;
  authorizeWrite(input: {
    scopeDigest: string;
    writerGeneration: number;
    ownershipId: string;
  }): Promise<{ root: string; writerGeneration: number; grantRef: string }>;
  /** 受管文件写/删的唯一入口（A07 决策六）：携带完整归属身份。 */
  executeManagedFileOperation(input: {
    identity: WorkspaceWriterIdentity;
    operation: ManagedFileOperation;
  }): Promise<ManagedFileOperationResult>;
} {
  const call = async <T>(method: RpcMethod, params: Record<string, unknown>): Promise<T> => {
    // A06：契约守卫。带方法的实例（SnapshotStorage 之类）一旦进 JSON 就静默退化成普通
    // 对象，远端会在"调用不存在的方法"上失败 —— 那是在错误的地方、以错误的方式暴露。
    // 这里在**发网络之前**拒绝，让"控制端口只传可序列化值"成为可验证的契约。
    assertRpcSerializable(params, method);
    const response = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    const payload = (await response.json()) as
      | { ok: true; result: T }
      | { ok: false; error: { name: string; message: string } };
    if (!payload.ok) {
      const error = new Error(payload.error.message);
      error.name = payload.error.name;
      throw error;
    }
    return payload.result;
  };
  return {
    probeIdentity: () => call<WorkspaceHostIdentityProbe>("probeIdentity", {}),
    prepare: (input) =>
      call<WorkspacePreparation>("prepare", input as unknown as Record<string, unknown>),
    activateWriter: (input) =>
      call<WorkspaceWriterGrant>("activateWriter", input as unknown as Record<string, unknown>),
    getWriter: (scopeDigest, writerGeneration) =>
      call<WorkspaceWriterGrant | null>("getWriter", { scopeDigest, writerGeneration }),
    assertWriter: (grant) => call<void>("assertWriter", { grant }),
    authorizeWrite: (input) =>
      call<{ root: string; writerGeneration: number; grantRef: string }>(
        "authorizeWrite",
        input as unknown as Record<string, unknown>,
      ),
    spawnManagedWriter: (input) =>
      call<{ writerRef: string; pid: number; processGroupId: number }>(
        "spawnManagedWriter",
        input as unknown as Record<string, unknown>,
      ),
    revokeWriterGeneration: (identity) =>
      call<WriterStopEvidence>(
        "revokeWriterGeneration",
        identity as unknown as Record<string, unknown>,
      ),
    executeManagedFileOperation: (input) =>
      call<ManagedFileOperationResult>(
        "executeManagedFileOperation",
        input as unknown as Record<string, unknown>,
      ),
    freeze: (input) =>
      call<SafePointReceipt>("freeze", input as unknown as Record<string, unknown>),
    // A06：参数**不包装**。服务端把一个 params 对象当作"该方法的唯一参数"，
    // 之前发 `{ receipt }` / `{ preparation }` 会让服务端拿到包装对象：
    // `receipt.checkpointIntentId` 变 undefined（写出"undefined.released"却返回成功）、
    // `preparation.candidateRoot` 变 undefined（清理目标错位）。
    releaseFreeze: (receipt) =>
      call<void>("releaseFreeze", receipt as unknown as Record<string, unknown>),
    snapshot: (input) =>
      call<SnapshotStorageReceipt>("snapshot", input as unknown as Record<string, unknown>),
    restore: (input) => call<void>("restore", input as unknown as Record<string, unknown>),
    cleanup: (preparation) =>
      call<void>("cleanup", preparation as unknown as Record<string, unknown>),
  };
}

/** 启动一个真实的 Broker RPC 服务（进程内/子进程入口共用）。 */
export async function listenWorkspaceHostRpc(input: {
  broker: WorkspaceHostBroker;
  port?: number;
  hostname?: string;
}): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const server = createWorkspaceHostRpcServer(input.broker);
  await new Promise<void>((resolve) => {
    server.listen(input.port ?? 0, input.hostname ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (input.port ?? 0);
  return {
    port,
    url: `http://${input.hostname ?? "127.0.0.1"}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 生成"持续写入指定文件"的受管 Writer 脚本入口参数（真实旧 Writer 场景）。 */
export function continuousWriterArgs(input: { targetFile: string; payload: string }): string[] {
  const script = [
    "const fs = require('node:fs');",
    `const file = ${JSON.stringify(input.targetFile)};`,
    `const payload = ${JSON.stringify(input.payload)};`,
    "let n = 0;",
    "const tick = () => {",
    "  n += 1;",
    "  fs.appendFileSync(file, `${payload}:${n}\\n`);",
    "};",
    "tick();",
    "setInterval(tick, 20);",
  ].join("\n");
  return ["-e", script];
}
