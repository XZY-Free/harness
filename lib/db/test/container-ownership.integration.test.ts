/**
 * 容器归属与孤儿回收的**真实 Docker** 证据。
 *
 * 用 `docker create`（不 start，零内存开销）真实创建带归属标签的容器，然后调用生产回收入口
 * `beginOwnedTestMysqlRun()`，断言：
 * - 本项目 + 本工作区 + 无活跃运行者的孤儿容器被回收；
 * - 有活跃运行者的容器、其他项目容器、其他工作区容器一律保留；
 * - 两个先后启动的流程互不误删对方（运行登记在互斥区内生效）；
 * - 本组测试依赖的活跃 MySQL 容器（globalSetup 起的那个）在回收后仍可连接。
 *
 * 测试自身创建的容器在 finally 里逐个 `docker rm -f`；不使用全局 prune。
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";
import {
  OWNERSHIP_LABELS,
  type TestContainerOwnership,
  beginOwnedTestMysqlRun,
  currentOwnership,
  releaseRun,
  runMarkerPath,
} from "./container-ownership";

const IMAGE = "mysql:8.0";
const created: string[] = [];
const ownerships: TestContainerOwnership[] = [];
const markers: string[] = [];

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** 真实创建一个带标签的容器（不启动）。 */
function createLabelledContainer(labels: Record<string, string>): string {
  const args = ["create"];
  for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
  args.push(IMAGE);
  const id = docker(args).trim();
  created.push(id);
  return id;
}

function scopeLabels(ownership: TestContainerOwnership, run: string): Record<string, string> {
  return {
    [OWNERSHIP_LABELS.project]: ownership.project,
    [OWNERSHIP_LABELS.workspace]: ownership.workspace,
    [OWNERSHIP_LABELS.run]: run,
  };
}

function containerExists(id: string): boolean {
  return docker(["ps", "-a", "--filter", `id=${id}`, "--format", "{{.ID}}"]).trim().length > 0;
}

/** 登记一个「活跃运行者」标记：pid 用当前进程，确保按定义它是活的。 */
function registerForeignLiveRun(ownership: TestContainerOwnership, runId: string): void {
  const path = runMarkerPath({ ...ownership, runId });
  markers.push(path);
  writeFileSync(
    path,
    `${JSON.stringify({
      runId,
      pid: process.pid,
      project: ownership.project,
      workspace: ownership.workspace,
      host: "test",
      startedAt: new Date().toISOString(),
    })}\n`,
  );
}

/** 写一个 pid 已死的运行标记（pid 越界即「已死」）。 */
function registerDeadRun(ownership: TestContainerOwnership, runId: string): void {
  const path = runMarkerPath({ ...ownership, runId });
  markers.push(path);
  writeFileSync(
    path,
    `${JSON.stringify({
      runId,
      pid: 4_194_304,
      project: ownership.project,
      workspace: ownership.workspace,
      host: "test",
      startedAt: new Date().toISOString(),
    })}\n`,
  );
}

afterEach(() => {
  for (const id of created.splice(0)) {
    try {
      docker(["rm", "-f", id]);
    } catch {
      // 已被回收的容器再删一次会报错，忽略即可。
    }
  }
  for (const ownership of ownerships.splice(0)) releaseRun(ownership);
  for (const marker of markers.splice(0)) rmSync(marker, { force: true });
});

/**
 * 本文件的每个用例都要经 `docker` CLI 真实往返多次（`docker create`、`docker ps -a`、
 * `docker image inspect`），第一个用例还要建 4 个容器并连一次 MySQL。
 *
 * 单独运行时约 1s；但验收的 `integration` 阶段与其他 13 个文件并行，Docker Desktop 的
 * CLI 往返会显著变慢（实测在整组并行下超过 vitest 的 5s 默认预算）。因此这里显式声明
 * 现实的预算——与 `db` 项目对真实 IO 用例使用 60s 的约定一致——而不是让用例依赖机器空载。
 */
const DOCKER_TEST_TIMEOUT_MS = 60_000;

describe("测试容器归属：真实 Docker 回收边界", () => {
  it(
    "回收自身孤儿；活跃运行者与其他归属容器全部保留",
    async () => {
      // 前置：image 必须存在——globalSetup 已用它起了本次运行的 MySQL。
      expect(docker(["image", "inspect", IMAGE]).trim()).not.toBe("");

      const self = currentOwnership(process.cwd());
      const orphanRun = `orphan-${Date.now()}`;
      const liveRun = `live-${Date.now()}`;
      registerForeignLiveRun(self, liveRun);

      const orphan = createLabelledContainer(scopeLabels(self, orphanRun));
      const activeRun = createLabelledContainer(scopeLabels(self, liveRun));
      const foreignProject = createLabelledContainer({
        ...scopeLabels(self, "foreign-run"),
        [OWNERSHIP_LABELS.project]: "another-project",
      });
      const foreignWorkspace = createLabelledContainer({
        ...scopeLabels(self, "foreign-run"),
        [OWNERSHIP_LABELS.workspace]: "0000000000000000",
      });

      const began = beginOwnedTestMysqlRun(process.cwd());
      ownerships.push(began.ownership);

      // 自身孤儿被回收。
      expect(began.report.removed).toContain(orphan);
      expect(containerExists(orphan)).toBe(false);
      // 活跃运行者的容器既在候选里、又被保留——证明「有活跃运行者」这一条真的生效。
      expect(began.report.retained).toContain(activeRun);
      expect(began.report.removed).not.toContain(activeRun);
      expect(containerExists(activeRun)).toBe(true);
      // 其他项目 / 其他工作区的容器不在候选范围，必须原样存在。
      expect(began.report.removed).not.toContain(foreignProject);
      expect(began.report.removed).not.toContain(foreignWorkspace);
      expect(containerExists(foreignProject)).toBe(true);
      expect(containerExists(foreignWorkspace)).toBe(true);

      // 本次运行依赖的活跃 MySQL（globalSetup 起的）在回收后仍然可连接。
      const url = process.env.DATABASE_URL;
      expect(url, "integration 组依赖 globalSetup 注入的 DATABASE_URL").toBeTruthy();
      const connection = await mysql.createConnection(url as string);
      try {
        const [rows] = await connection.query("SELECT 1 AS ok");
        expect(rows).toEqual([{ ok: 1 }]);
      } finally {
        await connection.end();
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  it(
    "先后启动的两个流程互不误删：先登记的运行仍算活跃",
    () => {
      const first = beginOwnedTestMysqlRun(process.cwd());
      ownerships.push(first.ownership);
      const firstContainer = createLabelledContainer(
        scopeLabels(first.ownership, first.ownership.runId),
      );

      const second = beginOwnedTestMysqlRun(process.cwd());
      ownerships.push(second.ownership);

      expect(second.report.removed).not.toContain(firstContainer);
      expect(second.report.retained).toContain(firstContainer);
      expect(containerExists(firstContainer)).toBe(true);
      expect(second.ownership.runId).not.toBe(first.ownership.runId);
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  it(
    "pid 已死的运行标记对应的容器视为孤儿",
    () => {
      const self = currentOwnership(process.cwd());
      const deadRun = `dead-${Date.now()}`;
      // 只写标记、不登记活进程：pid 越界即「已死」。
      registerDeadRun(self, deadRun);
      const orphan = createLabelledContainer(scopeLabels(self, deadRun));

      const began = beginOwnedTestMysqlRun(process.cwd());
      ownerships.push(began.ownership);

      expect(began.report.removed).toContain(orphan);
      expect(containerExists(orphan)).toBe(false);
    },
    DOCKER_TEST_TIMEOUT_MS,
  );
});
