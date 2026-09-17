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
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";
import type {
  SnapshotRequirements,
  SnapshotStorage,
  SnapshotStorageReceipt,
} from "@/lib/workspace/snapshot-storage";
import { FileSnapshotStorage } from "@/lib/workspace/snapshot-storage";
import type {
  SafePointReceipt,
  WorkspaceHost,
  WorkspacePreparation,
  WorkspaceWriterGrant,
} from "@/lib/workspace/workspace-host";

// ─── 稳定字面量 ────────────────────────────────────────────

const CONTROL_DIR = ".snow";
const HOST_IDENTITY_FILE = "host-identity.json";
const WORKSPACE_IDENTITY_FILE = "workspace-identity.json";
const SCOPE_CLAIM_FILE = "workspace-scope.json";
const OPERATIONS_DIR = "operations";
const WRITERS_DIR = "writers";
const CANDIDATES_DIR = "candidates";
const GRANTS_DIR = "grants";
const SAFE_POINTS_DIR = "safe-points";
const SNAPSHOT_DIR = "snapshot-storage";

/** 停止进程组的单次等待上限（先 SIGTERM，再 SIGKILL）。 */
const STOP_WAIT_MS = 3_000;
/** 排空采样间隔。 */
const DRAIN_SAMPLE_MS = 60;
/** 物理 scope 临界区等待上限与重试间隔。 */
const SCOPE_LOCK_TIMEOUT_MS = 10_000;
const SCOPE_LOCK_RETRY_MS = 15;

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

interface WriterProcessRecord {
  scopeDigest: string;
  writerGeneration: number;
  pid: number;
  processGroupId: number;
  command: string;
  activityPath: string | null;
  registeredAt: string;
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

function isInside(parent: string, child: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`)
  );
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
  private controlRootCache: string | null = null;

  constructor(input: {
    root: string;
    /** 实际受管写根；省略时等于控制面根。 */
    managedRoot?: string;
    hostIdentity?: string;
    snapshotStorage?: SnapshotStorage;
  }) {
    this.rootOverride = path.resolve(input.root);
    this.managedRootOverride = path.resolve(input.managedRoot ?? input.root);
    this.hostIdentityOverride = input.hostIdentity?.trim() || null;
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
  private async candidateClaimPath(operationId: string): Promise<string> {
    return path.join(await this.controlRoot(), CANDIDATES_DIR, `${sha256Hex(operationId)}.json`);
  }

  // ── 准备 ───────────────────────────────────────────────

  async prepare(input: {
    candidateAttemptId: string;
    revisionId: string;
    workspaceBindingId: string;
    operationId: string;
  }): Promise<WorkspacePreparation> {
    const candidateRoot = path.join(
      await this.controlRoot(),
      CANDIDATES_DIR,
      input.candidateAttemptId,
      input.operationId,
    );
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
    return this.withScopeLock(probe.scopeDigest, async () => {
      // 回执幂等：同一 operation 重放（响应丢失后的重试）返回同一 receipt，不回退 generation。
      const receiptKey = `activate:${input.operationId}`;
      const recorded = await readJson<BackendOperationReceipt>(
        await this.operationPath(receiptKey),
      );
      if (recorded) return recorded.receipt as unknown as WorkspaceWriterGrant;

      const current = await this.readCurrentWriter(probe.scopeDigest);
      if (current && current.writerGeneration > input.writerGeneration) {
        throw new WorkspaceWriterNotFencedError("Backend 已存在更高 writer generation");
      }
      const candidateGrant = this.buildGrant({
        probe,
        input,
        writerRoot,
        previousWriterGeneration: current?.writerGeneration ?? null,
        stop: null,
      });
      if (current && current.writerGeneration === input.writerGeneration) {
        if (
          JSON.stringify(grantIdentity(current)) !== JSON.stringify(grantIdentity(candidateGrant))
        ) {
          throw new WorkspaceWriterNotFencedError("同 generation 的 writer 身份冲突");
        }
        await this.writeCurrentWriter(probe.scopeDigest, current, input.operationId);
        await writeJsonStable(await this.operationPath(receiptKey), {
          operationId: receiptKey,
          receipt: current,
          recordedAt: new Date().toISOString(),
        } satisfies BackendOperationReceipt);
        return current;
      }

      // 真实的旧 Writer 撤销：停止旧执行组并确认退出；没有实际检查不得声明已撤销。
      const stop: WriterStopEvidence = current
        ? await this.stopWriterGeneration(probe.scopeDigest, current.writerGeneration)
        : {
            previousWriterPresent: false,
            stopped: true,
            processGroupEmpty: true,
            drained: true,
            signals: [],
            pids: [],
          };
      if (!stop.stopped || !stop.processGroupEmpty) {
        throw new WorkspaceWriterNotFencedError("旧 Writer 进程组未确认停止");
      }
      const grant = this.buildGrant({
        probe,
        input,
        writerRoot,
        previousWriterGeneration: current?.writerGeneration ?? null,
        stop,
      });
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
   * 物理 scope 的跨进程临界区。
   *
   * 用 `mkdir` 的原子性做互斥量：同 root 的不同 Broker 进程/实例都能看到同一把锁，
   * 因此"读代际 → 停旧 Writer → 写新代际"不会交错，generation 严格单调。
   */
  private async withScopeLock<T>(scopeDigest: string, run: () => Promise<T>): Promise<T> {
    const lockDir = path.join(await this.grantsRootFor(scopeDigest), ".scope.lock");
    await mkdir(path.dirname(lockDir), { recursive: true });
    const deadline = Date.now() + SCOPE_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await mkdir(lockDir);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() > deadline) {
          throw new WorkspaceWriterNotFencedError("scope 锁等待超时");
        }
        await delay(SCOPE_LOCK_RETRY_MS);
      }
    }
    try {
      return await run();
    } finally {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
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

  async getWriter(
    scopeDigest: string,
    writerGeneration: number,
  ): Promise<WorkspaceWriterGrant | null> {
    const current = await this.readCurrentWriter(scopeDigest);
    if (!current || current.writerGeneration !== writerGeneration) return null;
    return current;
  }

  async assertWriter(grant: WorkspaceWriterGrant): Promise<void> {
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
    const current = await this.readCurrentWriter(probe.scopeDigest);
    if (!current || current.writerGeneration !== input.writerGeneration) {
      throw new WorkspaceWriterNotFencedError("没有该 generation 的有效 writer grant");
    }
    const recordPath = await this.writerRecordPath(probe.scopeDigest, input.writerGeneration);
    const existing = await readJson<WriterProcessRecord>(recordPath);
    if (existing && processAlive(existing.pid)) {
      throw new WorkspaceWriterNotFencedError("该 generation 已有存活的受管 Writer");
    }
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid === undefined) throw new WorkspaceWriterNotFencedError("受管 Writer 启动失败");
    child.stdout?.resume();
    child.stderr?.resume();
    child.unref();
    await writeJsonStable(recordPath, {
      scopeDigest: probe.scopeDigest,
      writerGeneration: input.writerGeneration,
      pid: child.pid,
      processGroupId: child.pid,
      command: [input.command, ...input.args].join(" "),
      activityPath: input.activityPath ?? null,
      registeredAt: new Date().toISOString(),
    } satisfies WriterProcessRecord);
    return {
      writerRef: `writer:${probe.scopeDigest}:${input.writerGeneration}`,
      pid: child.pid,
      processGroupId: child.pid,
    };
  }

  /** 真实停止某代际的受管 Writer 进程组并确认退出；返回可核验证据。 */
  async revokeWriterGeneration(
    scopeDigest: string,
    writerGeneration: number,
  ): Promise<WriterStopEvidence> {
    const probe = await this.observeIdentity();
    return await this.stopWriterGeneration(scopeDigest, writerGeneration);
  }

  private async stopWriterGeneration(
    scopeDigest: string,
    generation: number,
  ): Promise<WriterStopEvidence> {
    const recordPath = await this.writerRecordPath(scopeDigest, generation);
    const record = await readJson<WriterProcessRecord>(recordPath);
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
    await rm(recordPath, { force: true });
    return {
      previousWriterPresent: true,
      stopped: processGroupEmpty,
      processGroupEmpty,
      drained,
      signals,
      pids,
    };
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

  async freeze(input: {
    grant: WorkspaceWriterGrant;
    checkpointIntentId: string;
    anchorDigest: string;
  }): Promise<SafePointReceipt> {
    await this.assertWriter(input.grant);
    const probe = await this.observeIdentity();
    const receipt: SafePointReceipt = {
      checkpointIntentId: input.checkpointIntentId,
      scopeDigest: input.grant.scopeDigest,
      writerGeneration: input.grant.writerGeneration,
      anchorDigest: input.anchorDigest,
      frozenAt: new Date().toISOString(),
    };
    await writeJsonExclusive(
      path.join(await this.controlRoot(), SAFE_POINTS_DIR, `${input.checkpointIntentId}.json`),
      receipt,
    );
    return receipt;
  }

  async releaseFreeze(receipt: SafePointReceipt): Promise<void> {
    const probe = await this.observeIdentity();
    await writeFile(
      path.join(
        await this.controlRoot(),
        SAFE_POINTS_DIR,
        `${receipt.checkpointIntentId}.released`,
      ),
      JSON.stringify(receipt),
      { flag: "a" },
    );
  }

  async snapshot(input: {
    grant: WorkspaceWriterGrant;
    checkpointIntentId: string;
    anchorDigest: string;
    storage?: SnapshotStorage;
    requirements: SnapshotRequirements;
  }): Promise<SnapshotStorageReceipt> {
    await this.assertWriter(input.grant);
    const storage = input.storage ?? this.storage;
    return (
      await storage.writeSnapshot(input.grant.root, input.checkpointIntentId, input.requirements)
    ).receipt;
  }

  async restore(input: {
    manifestRef: string;
    manifestDigest: string;
    destination: string;
    storage?: SnapshotStorage;
    operationId?: string;
    requirements?: SnapshotRequirements;
  }): Promise<void> {
    const storage = input.storage ?? this.storage;
    const manifest = await storage.readManifest(
      input.manifestRef,
      input.manifestDigest,
      input.requirements,
    );
    await storage.restoreSnapshot(
      manifest,
      input.destination,
      input.operationId,
      input.requirements,
    );
  }

  // ── 清理 ───────────────────────────────────────────────

  async cleanup(preparation: WorkspacePreparation): Promise<void> {
    const probe = await this.observeIdentity();
    const canonicalRoot = probe.canonicalRoot;
    const controlRoot = await this.controlRoot();
    const expectedRoot = await resolveReal(
      path.join(
        controlRoot,
        CANDIDATES_DIR,
        preparation.candidateAttemptId,
        preparation.operationId,
      ),
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
    await rm(target, { recursive: true, force: true });
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

export function createWorkspaceHostBroker(input: {
  root: string;
  /** 实际受管写根；省略时等于控制面根。 */
  managedRoot?: string;
  hostIdentity?: string;
  snapshotStorage?: SnapshotStorage;
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
  "freeze",
  "releaseFreeze",
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

function paramsToArgs(method: RpcMethod, params: Record<string, unknown> | undefined): unknown[] {
  const value = params ?? {};
  if (method === "getWriter") return [value.scopeDigest, value.writerGeneration];
  if (method === "assertWriter") return [value.grant];
  if (method === "revokeWriterGeneration") {
    return [value.scopeDigest, value.writerGeneration];
  }
  return [value];
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
  revokeWriterGeneration(
    scopeDigest: string,
    writerGeneration: number,
  ): Promise<WriterStopEvidence>;
  authorizeWrite(input: {
    scopeDigest: string;
    writerGeneration: number;
    ownershipId: string;
  }): Promise<{ root: string; writerGeneration: number; grantRef: string }>;
} {
  const call = async <T>(method: RpcMethod, params: Record<string, unknown>): Promise<T> => {
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
    revokeWriterGeneration: (scopeDigest, writerGeneration) =>
      call<WriterStopEvidence>("revokeWriterGeneration", { scopeDigest, writerGeneration }),
    freeze: (input) =>
      call<SafePointReceipt>("freeze", input as unknown as Record<string, unknown>),
    releaseFreeze: (receipt) => call<void>("releaseFreeze", { receipt }),
    restore: (input) => call<void>("restore", input as unknown as Record<string, unknown>),
    cleanup: (preparation) =>
      call<void>("cleanup", { preparation } as unknown as Record<string, unknown>),
    snapshot: async () => {
      throw new WorkspaceWriterNotFencedError("远程 Broker 不承接 in-process SnapshotStorage");
    },
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
