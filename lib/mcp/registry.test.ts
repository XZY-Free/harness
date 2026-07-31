import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearPoolForTest,
  closeClient,
  getOrConnect,
  getServer,
  listEnabledServers,
  listServers,
  rateLimitCheck,
  redactEnv,
} from "./registry";

/**
 * V3.4 Stage C：MCP registry 测试——连接池复用、redactEnv、CRUD 委托。
 * mock @/lib/db/queries 与 ./client，不触真实 DB / 网络。
 */

const queryMocks = vi.hoisted(() => ({
  listMcpServerConfigs: vi.fn(),
  listEnabledMcpServerConfigs: vi.fn(),
  getMcpServerConfigByName: vi.fn(),
  deleteMcpServerConfig: vi.fn(),
}));
vi.mock("@/lib/db/queries", () => ({
  listMcpServerConfigs: queryMocks.listMcpServerConfigs,
  listEnabledMcpServerConfigs: queryMocks.listEnabledMcpServerConfigs,
  getMcpServerConfigByName: queryMocks.getMcpServerConfigByName,
  deleteMcpServerConfig: queryMocks.deleteMcpServerConfig,
}));

const clientMocks = vi.hoisted(() => ({
  connectServer: vi.fn(),
}));
vi.mock("./client", () => ({
  connectServer: clientMocks.connectServer,
}));

beforeEach(() => {
  vi.clearAllMocks();
  _clearPoolForTest();
});

describe("redactEnv", () => {
  it("token/secret/key/password 值脱敏为 ***，其余保留", async () => {
    const r = redactEnv({ GITHUB_TOKEN: "abc", API_KEY: "k1", NORMAL_VAR: "v", PASSWORD: "p" });
    expect(r).toEqual({ GITHUB_TOKEN: "***", API_KEY: "***", NORMAL_VAR: "v", PASSWORD: "***" });
  });

  // S1（10-P2-1）：扩展关键词 pat/cred/api/auth 脱敏
  it("pat/cred/api/auth 关键词变量脱敏为 ***", async () => {
    const r = redactEnv({
      GIT_PAT: "pat-value",
      CREDENTIAL_STORE: "cred-data",
      API_ENDPOINT: "https://api.example.com",
      AUTH_HEADER: "bearer xyz",
      NORMAL_CONFIG: "keep",
    });
    expect(r).toEqual({
      GIT_PAT: "***",
      CREDENTIAL_STORE: "***",
      API_ENDPOINT: "***",
      AUTH_HEADER: "***",
      NORMAL_CONFIG: "keep",
    });
  });

  it("关键词大小写不敏感（PAT/pat/Pat 均脱敏）", async () => {
    const r = redactEnv({ PAT: "v1", pat: "v2", Pat: "v3" });
    expect(r).toEqual({ PAT: "***", pat: "***", Pat: "***" });
  });

  it("null env → null", async () => {
    expect(redactEnv(null)).toBeNull();
  });
});

describe("listServers / listEnabledServers / getServer 委托 queries", () => {
  it("listServers → listMcpServerConfigs", async () => {
    queryMocks.listMcpServerConfigs.mockResolvedValue([{ id: "m1", name: "github" }]);
    const r = await listServers();
    expect(r).toEqual([{ id: "m1", name: "github" }]);
  });

  it("listEnabledServers → listEnabledMcpServerConfigs", async () => {
    queryMocks.listEnabledMcpServerConfigs.mockResolvedValue([]);
    expect(await listEnabledServers()).toEqual([]);
  });

  it("getServer → getMcpServerConfigByName", async () => {
    queryMocks.getMcpServerConfigByName.mockResolvedValue(null);
    expect(await getServer("nope")).toBeNull();
  });
});

describe("连接池复用", () => {
  it("同名 server 复用 client（connectServer 只调一次）", async () => {
    queryMocks.getMcpServerConfigByName.mockResolvedValue({
      id: "m1",
      name: "github",
      enabled: true,
      transport: "stdio",
      command: "x",
    });
    clientMocks.connectServer.mockResolvedValue({
      listTools: vi.fn(),
      callTool: vi.fn(),
      close: vi.fn(),
    });
    await getOrConnect("github");
    await getOrConnect("github");
    expect(clientMocks.connectServer).toHaveBeenCalledTimes(1);
  });

  it("禁用的 server → 抛错，不 connect", async () => {
    queryMocks.getMcpServerConfigByName.mockResolvedValue({
      id: "m1",
      name: "github",
      enabled: false,
      transport: "stdio",
      command: "x",
    });
    await expect(getOrConnect("github")).rejects.toThrow("已禁用");
    expect(clientMocks.connectServer).not.toHaveBeenCalled();
  });

  it("不存在的 server → 抛错", async () => {
    queryMocks.getMcpServerConfigByName.mockResolvedValue(null);
    await expect(getOrConnect("ghost")).rejects.toThrow("不存在");
  });

  it("closeClient 移除池条目并 close", async () => {
    const close = vi.fn(async () => {});
    queryMocks.getMcpServerConfigByName.mockResolvedValue({
      id: "m1",
      name: "github",
      enabled: true,
      transport: "stdio",
      command: "x",
    });
    clientMocks.connectServer.mockResolvedValue({ listTools: vi.fn(), callTool: vi.fn(), close });
    await getOrConnect("github");
    await closeClient("github");
    expect(close).toHaveBeenCalled();
    // 关闭后再次 getOrConnect → 重新 connect
    await getOrConnect("github");
    expect(clientMocks.connectServer).toHaveBeenCalledTimes(2);
  });
});

describe("V6-M3-3（B7）TTL 心跳", () => {
  it("TTL 内重复 getOrConnect → 不调 listTools（跳过 ping）", async () => {
    const listTools = vi.fn().mockResolvedValue({ tools: [] });
    queryMocks.getMcpServerConfigByName.mockResolvedValue({
      id: "m1",
      name: "ttl-skip",
      enabled: true,
      transport: "stdio",
      command: "x",
    });
    clientMocks.connectServer.mockResolvedValue({
      listTools,
      callTool: vi.fn(),
      close: vi.fn(),
    });
    await getOrConnect("ttl-skip");
    // 第二次：TTL 内 → listTools 不应被调用
    await getOrConnect("ttl-skip");
    expect(listTools).not.toHaveBeenCalled();
  });

  it("TTL 过期后 getOrConnect → 调 listTools（执行 ping）", async () => {
    vi.useFakeTimers();
    try {
      const listTools = vi.fn().mockResolvedValue({ tools: [] });
      queryMocks.getMcpServerConfigByName.mockResolvedValue({
        id: "m1",
        name: "ttl-expire",
        enabled: true,
        transport: "stdio",
        command: "x",
      });
      clientMocks.connectServer.mockResolvedValue({
        listTools,
        callTool: vi.fn(),
        close: vi.fn(),
      });
      await getOrConnect("ttl-expire");
      expect(listTools).not.toHaveBeenCalled(); // 刚连接视为已 ping
      // 推进 61s（超过 60s TTL）
      vi.advanceTimersByTime(61_000);
      await getOrConnect("ttl-expire");
      expect(listTools).toHaveBeenCalledTimes(1); // TTL 过期 → ping
    } finally {
      vi.useRealTimers();
    }
  });
});

// S1（10-P2-4）：per-server 限流真实超限测试。
// callCounts 是模块级 Map,用唯一 serverName 隔离每个测试(避免累积干扰)。
// RATE_LIMIT_PER_MIN 模块加载时读 env(默认 10),测试环境固定 10/min。
let serverSeq = 0;
function uniqueServer(): string {
  serverSeq += 1;
  return `srv-limit-${serverSeq}`;
}

describe("rateLimitCheck 限流（10-P2-4）", () => {
  it("前 10 次 → 不抛(窗口内允许)", () => {
    const server = uniqueServer();
    for (let i = 0; i < 10; i++) {
      expect(() => rateLimitCheck(server)).not.toThrow();
    }
  });

  it("第 11 次 → 抛限流错(超 10/min)", () => {
    const server = uniqueServer();
    for (let i = 0; i < 10; i++) {
      rateLimitCheck(server);
    }
    expect(() => rateLimitCheck(server)).toThrow(/调用限流/);
  });

  it("不同 server 独立计数(A 超限不影响 B)", () => {
    const a = uniqueServer();
    const b = uniqueServer();
    for (let i = 0; i < 10; i++) rateLimitCheck(a);
    // A 已超限
    expect(() => rateLimitCheck(a)).toThrow(/调用限流/);
    // B 首次调用正常
    expect(() => rateLimitCheck(b)).not.toThrow();
  });

  it("超限后继续调用 → 持续抛错(count 继续累加)", () => {
    const server = uniqueServer();
    for (let i = 0; i < 10; i++) rateLimitCheck(server);
    expect(() => rateLimitCheck(server)).toThrow(/调用限流/);
    expect(() => rateLimitCheck(server)).toThrow(/调用限流/);
  });
});
