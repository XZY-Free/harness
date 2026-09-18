/**
 * 测试容器归属判定的定向验证（不依赖 Docker）：
 * 只有「本项目 + 本工作区 + 无活跃运行者」的容器才可回收，其余一律保留。
 * 真实容器的回收/保留证据见 container-ownership.integration.test.ts。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OWNERSHIP_LABELS,
  type OwnedContainerCandidate,
  currentOwnership,
  isProcessAlive,
  liveRunIds,
  ownershipLabels,
  purgeDeadRunMarkers,
  registerRun,
  releaseRun,
  runMarkerPath,
  selectReclaimableContainers,
} from "./container-ownership";

/** 确定超出系统 pid 范围的编号，用于构造「进程已死」的标记。 */
const DEAD_PID = 4_194_304;

let root: string;
const extraRoots: string[] = [];

/** 造一个「其他工作区」的根目录，登记后由 afterEach 统一清理。 */
function foreignWorkspaceRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "snow-other-ws-"));
  extraRoots.push(dir);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "snow-container-ownership-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const dir of extraRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function candidate(overrides: Partial<OwnedContainerCandidate>): OwnedContainerCandidate {
  return {
    id: "container-id",
    project: "snow-harness",
    workspace: "workspace-hash",
    run: "run-1",
    ...overrides,
  };
}

describe("测试容器归属：可回收判定", () => {
  const self = { project: "snow-harness", workspace: "workspace-hash" };

  it("本项目 + 本工作区 + 无活跃运行者 → 可回收", () => {
    const orphan = candidate({ id: "orphan", run: "gone" });
    expect(selectReclaimableContainers([orphan], new Set(["still-running"]), self)).toEqual([
      orphan,
    ]);
  });

  it("活跃运行者 / 其他项目 / 其他工作区 / 标签缺失 → 一律保留", () => {
    const live = candidate({ id: "live", run: "still-running" });
    const otherProject = candidate({ id: "other-project", project: "other-project" });
    const otherWorkspace = candidate({ id: "other-workspace", workspace: "another-hash" });
    const noRunLabel = candidate({ id: "no-run", run: null });
    const noProjectLabel = candidate({ id: "no-project", project: null });
    const noWorkspaceLabel = candidate({ id: "no-workspace", workspace: null });
    const emptyRun = candidate({ id: "empty-run", run: "" });

    const reclaimable = selectReclaimableContainers(
      [live, otherProject, otherWorkspace, noRunLabel, noProjectLabel, noWorkspaceLabel, emptyRun],
      new Set(["still-running"]),
      self,
    );

    expect(reclaimable).toEqual([]);
  });

  it("同一候选集合里只挑出真正的孤儿", () => {
    const orphan = candidate({ id: "orphan", run: "gone" });
    const live = candidate({ id: "live", run: "alive" });
    const otherProject = candidate({ id: "other-project", project: "other-project" });
    expect(
      selectReclaimableContainers([orphan, live, otherProject], new Set(["alive"]), self).map(
        (item) => item.id,
      ),
    ).toEqual(["orphan"]);
  });
});

describe("测试容器归属：进程与运行标记", () => {
  it("存活判定：当前进程存活，越界 pid 视为已死", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });

  it("运行标记生命周期：登记后算活跃，释放后不再活跃", () => {
    const ownership = currentOwnership(root);
    expect(liveRunIds(root).has(ownership.runId)).toBe(false);
    registerRun(ownership);
    expect(liveRunIds(root).has(ownership.runId)).toBe(true);
    releaseRun(ownership);
    expect(liveRunIds(root).has(ownership.runId)).toBe(false);
  });

  it("只有本项目 + 本工作区 + 存活 pid 的标记才算活跃运行", () => {
    const ownership = currentOwnership(root);
    const otherWorkspace = currentOwnership(foreignWorkspaceRoot());
    const writeMarker = (runId: string, marker: Record<string, unknown>) =>
      writeFileSync(join(root, "tmp/testcontainers-runs", `${runId}.json`), JSON.stringify(marker));
    registerRun(ownership);
    writeMarker("other-project", {
      runId: "other-project",
      pid: process.pid,
      project: "other-project",
      workspace: ownership.workspace,
    });
    writeMarker("other-workspace", {
      runId: "other-workspace",
      pid: process.pid,
      project: ownership.project,
      workspace: otherWorkspace.workspace,
    });
    writeMarker("dead-process", {
      runId: "dead-process",
      pid: DEAD_PID,
      project: ownership.project,
      workspace: ownership.workspace,
    });

    const live = liveRunIds(root);
    expect([...live]).toEqual([ownership.runId]);
  });

  it("清理死标记只作用于本项目 + 本工作区，其他归属的标记保留", () => {
    const ownership = currentOwnership(root);
    const otherWorkspace = currentOwnership(foreignWorkspaceRoot());
    const registry = join(root, "tmp/testcontainers-runs");
    mkdirSync(registry, { recursive: true });
    const writeMarker = (runId: string, marker: Record<string, unknown>) => {
      writeFileSync(join(registry, `${runId}.json`), JSON.stringify(marker));
      return join(registry, `${runId}.json`);
    };
    const ownDead = writeMarker("own-dead", {
      runId: "own-dead",
      pid: DEAD_PID,
      project: ownership.project,
      workspace: ownership.workspace,
    });
    const ownLive = runMarkerPath(ownership);
    registerRun(ownership);
    const foreignDead = writeMarker("foreign-dead", {
      runId: "foreign-dead",
      pid: DEAD_PID,
      project: "other-project",
      workspace: ownership.workspace,
    });
    const otherWorkspaceDead = writeMarker("other-workspace-dead", {
      runId: "other-workspace-dead",
      pid: DEAD_PID,
      project: ownership.project,
      workspace: otherWorkspace.workspace,
    });

    purgeDeadRunMarkers(root);

    expect(() => readFileSync(ownDead, "utf8")).toThrow();
    expect(readFileSync(ownLive, "utf8")).toContain(ownership.runId);
    expect(readFileSync(foreignDead, "utf8")).toContain("foreign-dead");
    expect(readFileSync(otherWorkspaceDead, "utf8")).toContain("other-workspace-dead");
  });
});

describe("测试容器归属：标识", () => {
  it("归属标签三项齐备且与归属对象一致", () => {
    const ownership = currentOwnership(root);
    expect(ownershipLabels(ownership)).toEqual({
      [OWNERSHIP_LABELS.project]: ownership.project,
      [OWNERSHIP_LABELS.workspace]: ownership.workspace,
      [OWNERSHIP_LABELS.run]: ownership.runId,
    });
  });

  it("工作区指纹同根稳定、异根不同；运行标识每次唯一", () => {
    const other = foreignWorkspaceRoot();
    expect(currentOwnership(root).workspace).toBe(currentOwnership(root).workspace);
    expect(currentOwnership(root).workspace).not.toBe(currentOwnership(other).workspace);
    expect(currentOwnership(root).runId).not.toBe(currentOwnership(root).runId);
  });

  it("项目标识与 package.json 包名一致", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      name: string;
    };
    expect(currentOwnership(root).project).toBe(pkg.name);
  });
});
