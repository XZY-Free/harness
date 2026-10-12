/**
 * 测试容器归属与孤儿回收。
 *
 * 背景：本 harness 有意禁用 testcontainers 的 Ryuk（网络受限拉不动镜像），
 * 容器释放完全依赖 `stop()`。一旦运行被中断（SIGKILL / 测试进程被杀），
 * 容器会永久留在 Docker 里，反复运行会逐步占满虚拟机内存，把后续运行
 * 拖成 OOM——那会让「验收失败」变成环境噪声而不是产品结论。
 *
 * 因此需要在启动时回收**孤儿**容器。回收必须严格限定范围，禁止全局 prune：
 *
 * - 只认本项目（`snow.test.project`）+ 本工作区（`snow.test.workspace`）的容器；
 *   其他项目、其他工作区（worktree / 克隆）的容器一律不动。
 * - 只回收**没有活跃运行者**的容器：每个运行实例在启动时登记运行标记，
 *   标记里的 pid 仍存活即视为活跃；标记缺失或 pid 已死才是孤儿。
 *   不使用「创建时间早」或 `org.testcontainers=true` 作为判据——那会误删
 *   其他项目或其他运行实例正在用的容器。
 * - 启动检查、孤儿清理、新运行登记三者共用**同一把互斥锁**，避免两个并发
 *   启动流程互相把对方刚登记的运行判成孤儿。
 * - 归属不明的资源（缺标签 / 标签不全）不删除。
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

/** 归属标签：项目 / 工作区 / 运行实例，三者缺一不可。 */
export const OWNERSHIP_LABELS = {
  project: "snow.test.project",
  workspace: "snow.test.workspace",
  run: "snow.test.run",
} as const;

/** 本项目标识（与 package.json 的包名一致，跨 worktree 稳定）。 */
const PROJECT = "snow-harness";

/** 运行标记目录（`tmp/` 已被 .gitignore 覆盖，不进版本管理）。 */
const RUN_REGISTRY_DIR = "tmp/testcontainers-runs";
const RECLAIM_LOCK_DIR = `${RUN_REGISTRY_DIR}/.reclaim.lock`;
const RECLAIM_LOCK_OWNER = "owner.json";
/** 锁的持有者 pid 已死、或锁文件超过该时长未更新时，视为残留锁并清理。 */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 15_000;

export interface TestContainerOwnership {
  readonly project: string;
  readonly workspace: string;
  readonly runId: string;
  /** 工作区绝对路径（运行标记的落地根）。 */
  readonly root: string;
}

export interface OwnedContainerCandidate {
  readonly id: string;
  readonly project: string | null;
  readonly workspace: string | null;
  readonly run: string | null;
}

export interface ReclaimReport {
  readonly removed: readonly string[];
  readonly retained: readonly string[];
  /** 未能执行回收的原因（可回收范围之外，不影响容器正常启动）。 */
  readonly skippedReason?: "docker-unavailable" | "lock-unavailable";
}

/** 生成本次运行的归属标识（每次 startTestMysql 调用独立一个）。 */
export function currentOwnership(root = process.cwd()): TestContainerOwnership {
  const absoluteRoot = resolve(root);
  return {
    project: PROJECT,
    // 工作区用绝对路径指纹：同一台机器上的不同 worktree / 克隆互不干扰。
    workspace: createHash("sha256").update(absoluteRoot).digest("hex").slice(0, 16),
    runId: `${process.pid}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    root: absoluteRoot,
  };
}

/** docker label 形式的归属标签。 */
export function ownershipLabels(ownership: TestContainerOwnership): Record<string, string> {
  return {
    [OWNERSHIP_LABELS.project]: ownership.project,
    [OWNERSHIP_LABELS.workspace]: ownership.workspace,
    [OWNERSHIP_LABELS.run]: ownership.runId,
  };
}

export function runMarkerPath(ownership: TestContainerOwnership): string {
  return join(ownership.root, RUN_REGISTRY_DIR, `${ownership.runId}.json`);
}

interface RunMarker {
  runId: string;
  pid: number;
  project: string;
  workspace: string;
  host: string;
  startedAt: string;
}

function parseMarker(raw: string): RunMarker | null {
  try {
    const value = JSON.parse(raw) as Partial<RunMarker>;
    if (
      typeof value.runId !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.project !== "string" ||
      typeof value.workspace !== "string"
    ) {
      return null;
    }
    return {
      runId: value.runId,
      pid: value.pid,
      project: value.project,
      workspace: value.workspace,
      host: typeof value.host === "string" ? value.host : "",
      startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
    };
  } catch {
    return null;
  }
}

/** pid 是否存活；EPERM 表示进程存在但属其他用户，同样视为存活。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readMarkers(root: string): { marker: RunMarker; path: string }[] {
  const dir = join(root, RUN_REGISTRY_DIR);
  if (!existsSync(dir)) return [];
  const markers: { marker: RunMarker; path: string }[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    try {
      const marker = parseMarker(readFileSync(path, "utf8"));
      if (marker) markers.push({ marker, path });
    } catch {
      // 读不到就当没有运行者：不因此删除任何容器（容器侧还有标签兜底）。
    }
  }
  return markers;
}

/** 当前工作区的活跃运行实例：同一项目 + 同一工作区 + pid 仍存活。 */
export function liveRunIds(root: string, project = PROJECT): Set<string> {
  const workspace = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
  const live = new Set<string>();
  for (const { marker } of readMarkers(root)) {
    if (marker.project !== project || marker.workspace !== workspace) continue;
    if (isProcessAlive(marker.pid)) live.add(marker.runId);
  }
  return live;
}

/** 清理本工作区内 pid 已死的残留标记文件（只动本项目 + 本工作区的标记）。 */
export function purgeDeadRunMarkers(root: string, project = PROJECT): void {
  const workspace = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
  for (const { marker, path } of readMarkers(root)) {
    if (marker.project !== project || marker.workspace !== workspace) continue;
    if (!isProcessAlive(marker.pid)) rmSync(path, { force: true });
  }
}

/**
 * 纯判定：从候选容器中挑出**可回收**的孤儿。
 *
 * 只有「本项目 + 本工作区 + 有运行标签 + 该运行已无活跃运行者」四条件同时成立
 * 才可回收。任何一条不成立都保留——宁可漏回收，也不误删别人的资源。
 */
export function selectReclaimableContainers(
  candidates: readonly OwnedContainerCandidate[],
  live: ReadonlySet<string>,
  self: Pick<TestContainerOwnership, "project" | "workspace">,
): OwnedContainerCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.project === self.project &&
      candidate.workspace === self.workspace &&
      typeof candidate.run === "string" &&
      candidate.run.length > 0 &&
      !live.has(candidate.run),
  );
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function dockerAvailable(): boolean {
  try {
    docker(["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

/** 列出带本项目标签的全部容器（不限于运行中；`docker ps -a`）。 */
function listOwnedContainers(project = PROJECT): OwnedContainerCandidate[] {
  const format = [
    "{{.ID}}",
    `{{.Label "${OWNERSHIP_LABELS.project}"}}`,
    `{{.Label "${OWNERSHIP_LABELS.workspace}"}}`,
    `{{.Label "${OWNERSHIP_LABELS.run}"}}`,
  ].join("\t");
  const output = docker([
    "ps",
    "-a",
    // 全 ID：与 `docker create` / `docker inspect` 的输出可直接交叉引用，报告里不留歧义。
    "--no-trunc",
    "--filter",
    `label=${OWNERSHIP_LABELS.project}=${project}`,
    "--format",
    format,
  ]);
  const candidates: OwnedContainerCandidate[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, projectLabel, workspace, run] = trimmed.split("\t");
    if (!id) continue;
    candidates.push({
      id,
      project: projectLabel && projectLabel.length > 0 ? projectLabel : null,
      workspace: workspace && workspace.length > 0 ? workspace : null,
      run: run && run.length > 0 ? run : null,
    });
  }
  return candidates;
}

/** 收集运行标记 + 清理 + 登记，全程持有同一把互斥锁。 */
function acquireReclaimLock(root: string): (() => void) | null {
  const lockDir = join(root, RECLAIM_LOCK_DIR);
  const ownerPath = join(lockDir, RECLAIM_LOCK_OWNER);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  mkdirSync(join(root, RUN_REGISTRY_DIR), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(
        ownerPath,
        `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
      );
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // 锁被占用：只有持有者已死或锁过旧才可清理，否则等待。
      let stale = false;
      try {
        const stat = readFileSync(ownerPath, "utf8");
        const owner = JSON.parse(stat) as { pid?: number; at?: string };
        const ageMs = owner.at ? Date.now() - Date.parse(owner.at) : Number.NaN;
        stale =
          typeof owner.pid === "number"
            ? !isProcessAlive(owner.pid)
            : Number.isNaN(ageMs) || ageMs > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) return null;
      sleepSync(50);
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface BeginRunResult {
  readonly ownership: TestContainerOwnership;
  readonly report: ReclaimReport;
}

/**
 * 启动任何 MySQL 测试容器前调用：在互斥锁内完成「看残留 → 回收孤儿 → 登记本运行」。
 *
 * 登记发生在回收之后，所以并发启动的另一个流程只可能看到两类运行：
 * 已登记且 pid 存活的（保留），或 pid 已死的（回收）。
 */
export function beginOwnedTestMysqlRun(root = process.cwd()): BeginRunResult {
  const ownership = currentOwnership(root);
  if (!dockerAvailable()) {
    return {
      ownership,
      report: { removed: [], retained: [], skippedReason: "docker-unavailable" },
    };
  }
  const releaseLock = acquireReclaimLock(ownership.root);
  if (!releaseLock) {
    // 拿不到锁说明另一个启动流程正在回收；跳过回收比误删安全。
    return { ownership, report: { removed: [], retained: [], skippedReason: "lock-unavailable" } };
  }
  try {
    purgeDeadRunMarkers(ownership.root);
    const live = liveRunIds(ownership.root);
    const candidates = listOwnedContainers(ownership.project);
    const reclaimable = selectReclaimableContainers(candidates, live, ownership);
    const removed: string[] = [];
    for (const candidate of reclaimable) {
      docker(["rm", "-f", candidate.id]);
      removed.push(candidate.id);
    }
    const removedIds = new Set(removed);
    const retained = candidates.filter((c) => !removedIds.has(c.id)).map((c) => c.id);
    registerRun(ownership);
    return { ownership, report: { removed, retained } };
  } finally {
    releaseLock();
  }
}

/** 登记本次运行（在归属范围内可见，供其他启动流程判断孤儿）。 */
export function registerRun(ownership: TestContainerOwnership): void {
  mkdirSync(join(ownership.root, RUN_REGISTRY_DIR), { recursive: true });
  const marker: RunMarker = {
    runId: ownership.runId,
    pid: process.pid,
    project: ownership.project,
    workspace: ownership.workspace,
    host: hostname(),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(runMarkerPath(ownership), `${JSON.stringify(marker, null, 2)}\n`);
}

/** 正常结束（容器已 stop）时显式释放运行标记。 */
export function releaseRun(ownership: TestContainerOwnership): void {
  rmSync(runMarkerPath(ownership), { force: true });
}
