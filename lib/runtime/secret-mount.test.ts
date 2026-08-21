import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V3.8 Stage C：Secret mount 生命周期 + env 注入 + 脱敏测试。
 *
 * 覆盖：加密存储/解密注入、轮换(旧值清除)、撤销(停止注入)、
 * ToolRun output 不含 secret、master key 缺失 fail-closed、--env-file 用后删除。
 */

// Mock DB queries
const queries = vi.hoisted(() => ({
  createSecretMount: vi.fn(),
  getSecretMount: vi.fn(),
  listActiveSecretsByScope: vi.fn(),
  rotateSecretMount: vi.fn(),
  revokeSecretMount: vi.fn(),
}));

vi.mock("@/lib/db/queries", () => queries);

import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decrypt, encrypt } from "./secret-crypto";
import {
  cleanupSecretEnvFile,
  createSecret,
  injectSecrets,
  resolveSecrets,
  revokeSecret,
  rotateSecret,
  writeSecretEnvFile,
} from "./secret-mount";
import { clearThreadSecrets, redactText, registerSecretValues } from "./secret-redaction";

const TEST_KEY = Buffer.alloc(32, 0x42).toString("base64");
const TID = "test-secret-thread";
const TEST_DIR = resolve(".test-secret-mount");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SECRET_MASTER_KEY = TEST_KEY;
  process.env.SECRET_MASTER_KEY_ID = "test-v1";
  queries.createSecretMount.mockImplementation(async (params) => ({
    id: "sm-1",
    name: params.name,
    scope: params.scope,
    scopeRef: params.scopeRef ?? null,
    keyId: params.keyId,
    ciphertext: params.ciphertext,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    rotatedAt: null,
  }));
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.SECRET_MASTER_KEY;
  // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
  delete process.env.SECRET_MASTER_KEY_ID;
  clearThreadSecrets(TID);
  vi.restoreAllMocks();
});

describe("createSecret", () => {
  it("加密存储 secret + status=active", async () => {
    const mount = await createSecret({
      threadId: TID,
      name: "API_KEY",
      scope: "thread",
      scopeRef: TID,
      value: "sk-secret-123",
    });

    expect(mount.name).toBe("API_KEY");
    expect(mount.status).toBe("active");
    expect(mount.ciphertext).not.toContain("sk-secret-123");
    // 密文可解密回原值
    const decrypted = decrypt({ keyId: mount.keyId, ciphertext: mount.ciphertext });
    expect(decrypted).toBe("sk-secret-123");
  });

  it("master key 缺失 → fail-closed（不存储）", async () => {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.SECRET_MASTER_KEY;
    await expect(
      createSecret({
        threadId: TID,
        name: "API_KEY",
        scope: "thread",
        scopeRef: TID,
        value: "secret",
      }),
    ).rejects.toThrow(/SECRET_MASTER_KEY 未配置/);
    expect(queries.createSecretMount).not.toHaveBeenCalled();
  });
});

describe("rotateSecret", () => {
  it("新密文覆盖 + rotatedAt 更新", async () => {
    const oldEncrypted = encrypt("old-value");
    queries.getSecretMount.mockResolvedValue({
      id: "sm-1",
      name: "API_KEY",
      scope: "thread",
      scopeRef: TID,
      keyId: oldEncrypted.keyId,
      ciphertext: oldEncrypted.ciphertext,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      rotatedAt: null,
    });
    queries.rotateSecretMount.mockResolvedValue({
      id: "sm-1",
      name: "API_KEY",
      scope: "thread",
      scopeRef: TID,
      keyId: "test-v1",
      ciphertext: "new-ciphertext",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      rotatedAt: new Date(),
    });

    const updated = await rotateSecret(TID, "sm-1", "new-value");

    expect(updated.rotatedAt).not.toBeNull();
    expect(queries.rotateSecretMount).toHaveBeenCalledWith("sm-1", expect.any(String), "test-v1");
  });

  it("已撤销的 secret 无法轮换", async () => {
    queries.getSecretMount.mockResolvedValue({
      id: "sm-1",
      name: "API_KEY",
      scope: "thread",
      scopeRef: TID,
      keyId: "test-v1",
      ciphertext: "x",
      status: "revoked",
      createdAt: new Date(),
      updatedAt: new Date(),
      rotatedAt: null,
    });

    await expect(rotateSecret(TID, "sm-1", "new-value")).rejects.toThrow(/已撤销/);
  });
});

describe("revokeSecret", () => {
  it("status=revoked", async () => {
    queries.getSecretMount.mockResolvedValue({
      id: "sm-1",
      name: "API_KEY",
      scope: "thread",
      scopeRef: TID,
      keyId: "test-v1",
      ciphertext: "x",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      rotatedAt: null,
    });
    queries.revokeSecretMount.mockResolvedValue({
      id: "sm-1",
      name: "API_KEY",
      scope: "thread",
      scopeRef: TID,
      keyId: "test-v1",
      ciphertext: "x",
      status: "revoked",
      createdAt: new Date(),
      updatedAt: new Date(),
      rotatedAt: null,
    });

    const updated = await revokeSecret(TID, "sm-1");

    expect(updated.status).toBe("revoked");
  });
});

describe("resolveSecrets", () => {
  it("解析 active secrets → env map + 注册脱敏", async () => {
    const enc1 = encrypt("sk-secret-value");
    const enc2 = encrypt("token-abc");
    queries.listActiveSecretsByScope.mockResolvedValue([
      {
        id: "sm-1",
        name: "API_KEY",
        scope: "thread",
        scopeRef: TID,
        keyId: enc1.keyId,
        ciphertext: enc1.ciphertext,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        rotatedAt: null,
      },
      {
        id: "sm-2",
        name: "AUTH_TOKEN",
        scope: "thread",
        scopeRef: TID,
        keyId: enc2.keyId,
        ciphertext: enc2.ciphertext,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        rotatedAt: null,
      },
    ]);

    const env = await resolveSecrets(TID, "thread", TID);

    expect(env.API_KEY).toBe("sk-secret-value");
    expect(env.AUTH_TOKEN).toBe("token-abc");

    // 脱敏已注册
    expect(redactText("error: sk-secret-value is invalid", TID)).toBe("error: *** is invalid");
    expect(redactText("using token-abc", TID)).toBe("using ***");
  });

  it("无 secret → 空 env + 清除旧脱敏值", async () => {
    queries.listActiveSecretsByScope.mockResolvedValue([]);
    // 先注册一些旧值
    registerSecretValues(TID, ["old-secret"]);
    expect(redactText("old-secret", TID)).toBe("***");

    const env = await resolveSecrets(TID, "thread", TID);

    expect(env).toEqual({});
    // 旧值已清除
    expect(redactText("old-secret", TID)).toBe("old-secret");
  });

  it("master key 缺失 → fail-closed（不返回空 env）", async () => {
    // biome-ignore lint/performance/noDelete: 测试恢复 env 原状需 delete
    delete process.env.SECRET_MASTER_KEY;
    await expect(resolveSecrets(TID, "thread", TID)).rejects.toThrow(/SECRET_MASTER_KEY 未配置/);
  });

  it("解密失败 → 明确错误（不静默空值）", async () => {
    queries.listActiveSecretsByScope.mockResolvedValue([
      {
        id: "sm-1",
        name: "API_KEY",
        scope: "thread",
        scopeRef: TID,
        keyId: "wrong-key",
        ciphertext: "invalid-ciphertext",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        rotatedAt: null,
      },
    ]);

    await expect(resolveSecrets(TID, "thread", TID)).rejects.toThrow(/解密失败/);
  });
});

describe("injectSecrets", () => {
  it("合并 env（secret 覆盖同名 key）", () => {
    const base = { PATH: "/usr/bin", API_KEY: "old-value" };
    const secrets = { API_KEY: "new-secret", NEW_VAR: "secret-val" };
    const result = injectSecrets(base, secrets);
    expect(result.API_KEY).toBe("new-secret");
    expect(result.NEW_VAR).toBe("secret-val");
    expect(result.PATH).toBe("/usr/bin");
  });
});

describe("writeSecretEnvFile / cleanupSecretEnvFile", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("写入临时 env 文件 + 用后删除", async () => {
    const secrets = { API_KEY: "sk-secret", TOKEN: "tok-123" };
    const filePath = await writeSecretEnvFile(secrets, TEST_DIR, TID);

    // 文件存在且包含 secret（审计修复后值用单引号包裹防注入）
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("API_KEY='sk-secret'");
    expect(content).toContain("TOKEN='tok-123'");

    // 用后删除
    await cleanupSecretEnvFile(filePath);
    await expect(readFile(filePath, "utf-8")).rejects.toThrow();
  });

  it("cleanupSecretEnvFile 对不存在的文件不抛错", async () => {
    await expect(cleanupSecretEnvFile("/nonexistent/file.env")).resolves.not.toThrow();
  });
});

describe("脱敏完整性", () => {
  it("ToolRun output 不含 secret 明文（经 redactText 扫描）", async () => {
    const enc = encrypt("super-secret-123");
    queries.listActiveSecretsByScope.mockResolvedValue([
      {
        id: "sm-1",
        name: "API_KEY",
        scope: "thread",
        scopeRef: TID,
        keyId: enc.keyId,
        ciphertext: enc.ciphertext,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        rotatedAt: null,
      },
    ]);

    await resolveSecrets(TID, "thread", TID);

    // 模拟工具输出含 secret
    const toolOutput = JSON.stringify({
      ok: true,
      stdout: "API key super-secret-123 is valid",
      env: "API_KEY=super-secret-123",
    });

    const { redactObject } = await import("./secret-redaction");
    const redacted = redactObject(JSON.parse(toolOutput), TID);

    expect(JSON.stringify(redacted)).not.toContain("super-secret-123");
    expect(JSON.stringify(redacted)).toContain("***");
  });

  it("日志不含 secret（经 redactText 扫描）", async () => {
    const enc = encrypt("log-secret-value");
    queries.listActiveSecretsByScope.mockResolvedValue([
      {
        id: "sm-1",
        name: "KEY",
        scope: "thread",
        scopeRef: TID,
        keyId: enc.keyId,
        ciphertext: enc.ciphertext,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        rotatedAt: null,
      },
    ]);

    await resolveSecrets(TID, "thread", TID);

    const logMsg = "Processing with key=log-secret-value";
    const redacted = redactText(logMsg, TID);
    expect(redacted).not.toContain("log-secret-value");
    expect(redacted).toContain("***");
  });
});
