/**
 * A06：控制端口（Broker RPC）的**可序列化契约**与候选目录归属。
 *
 * 审查报告 A06 的阻断点里，有五条发生在"控制面 ↔ 受管 Broker"这条边界上：
 *
 * 2. `createRemoteWorkspaceHost.snapshot()` 无条件抛错，RPC 方法清单里也没有 `snapshot`；
 * 3. Remote restore 把带方法的 `SnapshotStorage` 实例塞进 JSON 请求；
 * 4. Remote `releaseFreeze` 发 `{receipt}`，服务端把包装对象当 receipt 用
 *    （读不到 `checkpointIntentId`，写出 `undefined.released` 却返回成功）；
 * 5. Remote `cleanup` 发 `{preparation}`，服务端同样未拆包装，清理目标错位；
 * 6. 候选工作目录建在控制面目录里，而 `activateWriter` 明确拒绝控制面目录作 Writer root。
 *
 * 本文件只验证**端口本身**：真实 RPC server + 真实 RPC client，不涉及数据库。
 * 端到端（默认 Checkpoint 命令 → 持久快照 → runtime-start 恢复激活）见
 * `checkpoint-default-path.integration.test.ts`。
 */
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileSnapshotStorage,
  SnapshotStorageUnavailableError,
  resolveSnapshotStorage,
  snapshotStorageRefFromRoot,
} from "@/lib/workspace/snapshot-storage";
import type { WorkspaceWriterGrant } from "@/lib/workspace/workspace-host";
import {
  createRemoteWorkspaceHost,
  createWorkspaceHostBroker,
  listenWorkspaceHostRpc,
} from "@/lib/workspace/workspace-host-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const filesystemSemantics = {
  kind: "portable",
  caseSensitive: true,
  symlinks: true,
  permissions: true,
  hardlinks: false,
  specialFiles: false,
  xattrsAcl: false,
  mtime: "preserved",
} as const;

const requirements = { checkpointPolicy: null, filesystemSemantics } as never;

/** 形状合法但不是当前 Writer 的 grant：用于证明请求真的到了对端。 */
function fakeGrant(scopeDigest: string, root: string): WorkspaceWriterGrant {
  return {
    scopeDigest,
    writerGeneration: 1,
    invocationId: "00000000-0000-4000-8000-000000000001",
    attemptId: "00000000-0000-4000-8000-000000000002",
    ownershipId: "00000000-0000-4000-8000-000000000003",
    leaseEpoch: "1",
    grantRef: "grant:fixture",
    root,
    operationId: "fixture",
    oldWriterRevoked: true,
    backendEvidence: {},
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

interface RpcProxy {
  readonly url: string;
  /** 按顺序记录端口上真实出现过的 RPC 调用（方法名 + 上线参数）。 */
  readonly calls: Array<{ method: string; params: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function respondJson(response: ServerResponse, status: number, body: string): Promise<void> {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

/**
 * 记账代理：把 `POST /rpc` 原样转发给真实 Broker，同时记录 `{method, params}`。
 *
 * 用途是**给"请求是否真的离开了客户端"提供可证伪的证据**。旧版
 * `createRemoteWorkspaceHost.snapshot()` 是客户端本地直接 throw，
 * 端口上一个请求都不会出现 —— 只看"抛了什么错"无法区分这两种情况，
 * 只看计数可以。
 */
async function startRpcProxy(targetUrl: string): Promise<RpcProxy> {
  const calls: RpcProxy["calls"] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = JSON.parse(raw) as { method: string; params: Record<string, unknown> };
      calls.push({ method: parsed.method, params: parsed.params });
      // 客户端发的是 `POST <baseUrl>/rpc`：代理必须转发到同一路径，否则拿到的是
      // 路由 404 的空响应（会以"Unexpected end of JSON input"伪装成 JSON 问题）。
      const upstream = await fetch(new URL("/rpc", targetUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      await respondJson(response, upstream.status, await upstream.text());
    })().catch(async (error: unknown) => {
      if (!response.headersSent) {
        await respondJson(response, 500, JSON.stringify({ message: String(error) }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe("WorkspaceHost 控制端口契约（A06）", () => {
  let roots: string[] = [];
  let hostRoot: string;
  let writerRoot: string;
  let storageRoot: string;
  let brokerStorageRoot: string;
  let rpc: Awaited<ReturnType<typeof listenWorkspaceHostRpc>> | null = null;
  let proxies: RpcProxy[] = [];

  beforeEach(async () => {
    roots = [];
    proxies = [];
    const base = await mkdtemp(path.join(tmpdir(), "a06-rpc-contract-"));
    roots.push(base);
    hostRoot = path.join(base, "host");
    writerRoot = path.join(base, "writer");
    storageRoot = path.join(base, "snapshot-storage");
    brokerStorageRoot = path.join(base, "broker-default-storage");
    rpc = null;
  });

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) await proxy.close();
    await rpc?.close();
    rpc = null;
    for (const root of roots) await rm(root, { recursive: true, force: true });
    roots = [];
  });

  /** 真实 RPC 端点：Broker 自己持有一份默认存储（用于验证 `broker_default` 语义）。 */
  async function listenBroker() {
    const broker = createWorkspaceHostBroker({
      root: hostRoot,
      managedRoot: writerRoot,
      snapshotStorage: new FileSnapshotStorage(brokerStorageRoot),
    });
    const probe = await broker.probeIdentity();
    rpc = await listenWorkspaceHostRpc({ broker });
    return { broker, probe, url: rpc.url };
  }

  it("snapshot 真的经 RPC 到达 Broker；storage 以可序列化引用上线，不是实例", async () => {
    const { probe, url } = await listenBroker();
    const proxy = await startRpcProxy(url);
    proxies.push(proxy);
    const remote = createRemoteWorkspaceHost(proxy.url);

    const error = await remote
      .snapshot({
        grant: fakeGrant(probe.scopeDigest, writerRoot),
        checkpointIntentId: "00000000-0000-4000-8000-00000000000a",
        anchorDigest: `sha256:${"a".repeat(64)}`,
        // A06：跨控制端口传的是**数据**（{kind,root}），不是 FileSnapshotStorage 实例。
        storage: { kind: "file", root: storageRoot },
        requirements,
      })
      .then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );

    // 旧实现：客户端**本地**抛"远程 Broker 不承接 in-process SnapshotStorage"，
    // 且 `RPC_METHODS` 里没有 snapshot —— 端口上不会出现任何调用。
    // 这里直接以"端口上真的出现了 snapshot 调用"作为可证伪的判别依据。
    expect(proxy.calls.map((call) => call.method)).toEqual(["snapshot"]);
    // ③：实例方法无法过 JSON。线上必须已经是数据引用，否则对端只能拿到普通对象。
    expect(proxy.calls[0]?.params).toMatchObject({
      storage: { kind: "file", root: storageRoot },
    });
    // 失败发生在对端对真实 Writer 的校验上（fakeGrant 不是当前 Writer）……
    expect(error?.name).toBe("WorkspaceWriterNotFenced");
    // ……而不是客户端的短路消息。
    expect(error?.message).not.toMatch(/不承接 in-process SnapshotStorage/);
  });

  it("releaseFreeze 不再包装参数：解冻登记落在目标安全点上，而不是 undefined.released", async () => {
    const { url } = await listenBroker();
    const remote = createRemoteWorkspaceHost(url);
    const checkpointIntentId = "00000000-0000-4000-8000-00000000000b";
    // 控制面根与 Broker 同源：realpath(root) + ".snow"（macOS 的 /var → /private/var）。
    const controlRoot = path.join(await realpath(hostRoot), ".snow");

    await remote.releaseFreeze({
      checkpointIntentId,
      scopeDigest: "sha256:fixture",
      writerGeneration: 1,
      anchorDigest: `sha256:${"b".repeat(64)}`,
      frozenAt: new Date().toISOString(),
    });

    const released = path.join(controlRoot, "safe-points", `${checkpointIntentId}.released`);
    expect(await pathExists(released)).toBe(true);
    // 旧实现把 `{receipt}` 当 receipt 用：`receipt.checkpointIntentId` 是 undefined，
    // 于是写出名为 `undefined.released` 的文件却返回成功 —— 目标安全点从未被解冻。
    expect(await pathExists(path.join(controlRoot, "safe-points", "undefined.released"))).toBe(
      false,
    );
    expect(JSON.parse(await readFile(released, "utf8"))).toMatchObject({ checkpointIntentId });
  });

  it("候选运行目录与候选归属登记分离：目录在受管写根内，登记仍在控制面；cleanup 真实释放该目录", async () => {
    const { probe, url } = await listenBroker();
    const remote = createRemoteWorkspaceHost(url);

    const preparation = await remote.prepare({
      candidateAttemptId: "00000000-0000-4000-8000-00000000000c",
      revisionId: "00000000-0000-4000-8000-00000000000d",
      workspaceBindingId: "00000000-0000-4000-8000-00000000000e",
      operationId: "a06-candidate",
    });
    const canonicalRoot = probe.canonicalRoot;
    const controlRoot = path.join(await realpath(hostRoot), ".snow");
    // ⑥：候选**运行目录**必须在受管写根内、控制面目录外，否则随后的 activateWriter
    // 会以"Writer root 不能是控制面目录"拒绝 —— 恢复成功也无法激活。
    const runsDir = path.join(canonicalRoot, ".snow-runs");
    expect(preparation.candidateRoot.startsWith(`${runsDir}${path.sep}`)).toBe(true);
    expect(preparation.candidateRoot.startsWith(`${controlRoot}${path.sep}`)).toBe(false);
    expect(await pathExists(preparation.candidateRoot)).toBe(true);
    // 归属登记仍在控制面：清理/幂等/越权判定靠那份登记，不靠目录位置。
    const claimDir = path.join(controlRoot, "candidates");
    expect((await stat(claimDir)).isDirectory()).toBe(true);

    // ⑤：参数不包装时，服务端拿到的是 preparation 本身 → 真实删除注册的候选目录。
    await remote.cleanup(preparation);
    expect(await pathExists(preparation.candidateRoot)).toBe(false);
    // 幂等：目录已不在、登记仍在 → 重复清理仍然成功（不是"目标错位"式的静默成功）。
    await remote.cleanup(preparation);
  });

  it("带方法的实例进 RPC 参数在发网络之前被拒绝（不会静默退化成普通对象）", async () => {
    const { url } = await listenBroker();
    const remote = createRemoteWorkspaceHost(url);

    await expect(
      remote.snapshot({
        grant: fakeGrant("sha256:fixture", writerRoot),
        checkpointIntentId: "00000000-0000-4000-8000-00000000000f",
        anchorDigest: `sha256:${"c".repeat(64)}`,
        // 实例方法无法过 JSON：一旦发出去，对端只会得到不带方法的普通对象。
        storage: new FileSnapshotStorage(storageRoot) as never,
        requirements,
      }),
    ).rejects.toThrow(/控制端口只传可序列化值/);

    // 反证"这是发包前的本地拒绝"：把端点指向必然连接失败的位置，若守卫没有先行生效，
    // 抛出的会是网络错误而不是契约错误。
    const unreachable = createRemoteWorkspaceHost("http://127.0.0.1:1");
    const error = await unreachable
      .snapshot({
        grant: fakeGrant("sha256:fixture", writerRoot),
        checkpointIntentId: "00000000-0000-4000-8000-000000000010",
        anchorDigest: `sha256:${"d".repeat(64)}`,
        storage: new FileSnapshotStorage(storageRoot) as never,
        requirements,
      })
      .then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );
    expect(error?.message).toMatch(/控制端口只传可序列化值/);
    expect(error?.message).not.toMatch(/fetch failed|ECONNREFUSED/i);

    // 同一个端点用**可序列化引用**调用时才会真的走网络（这里由连接失败证明）。
    await expect(
      unreachable.snapshot({
        grant: fakeGrant("sha256:fixture", writerRoot),
        checkpointIntentId: "00000000-0000-4000-8000-000000000011",
        anchorDigest: `sha256:${"e".repeat(64)}`,
        storage: { kind: "file", root: storageRoot },
        requirements,
      }),
    ).rejects.not.toThrow(/控制端口只传可序列化值/);
  });

  it("SnapshotStorage 引用语义：无物理根=broker_default，有物理根=file；无回退时 fail closed", () => {
    expect(snapshotStorageRefFromRoot(null)).toEqual({ kind: "broker_default" });
    expect(snapshotStorageRefFromRoot(undefined)).toEqual({ kind: "broker_default" });
    expect(snapshotStorageRefFromRoot("/tmp/snapshots")).toEqual({
      kind: "file",
      root: "/tmp/snapshots",
    });

    // `file` 引用自带物理根：任何一端都能解析出真实 IO。
    const file = resolveSnapshotStorage({ kind: "file", root: storageRoot }, null);
    expect(file).toBeInstanceOf(FileSnapshotStorage);

    // `broker_default` 只对**持有**该存储的 Broker 有意义；没有回退就必须拒绝，
    // 不能猜一个路径出来。
    const brokerDefault = new FileSnapshotStorage(brokerStorageRoot);
    expect(resolveSnapshotStorage({ kind: "broker_default" }, brokerDefault)).toBe(brokerDefault);
    expect(() => resolveSnapshotStorage({ kind: "broker_default" }, null)).toThrow(
      SnapshotStorageUnavailableError,
    );
    expect(() => resolveSnapshotStorage(undefined, null)).toThrow(SnapshotStorageUnavailableError);
  });
});
