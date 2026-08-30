/**
 * Runtime/AgentCall 共用的 External CredentialRef 解析长期 Authority 测试。
 *
 * 目标：为后续 AgentCall A2A exact binding 提供协议中立的外部 outbound 凭证权威，
 * 长期 API 只做 tenantId + identityMode + credentialRefId → {mode:none}|{mode:bearer,token}，
 * 不发 HTTP、不写 DB、不输出 secret。
 *
 * 保留自旧 lib/runtime/credentials/resolve-outbound-runtime-auth.test.ts 的关键事实：
 * - none 要求 ref=null；bearer 要求 exact ref；omitted/null/blank identity/ref 组合 fail closed；
 * - tenant exact match；active；未过期；provider=env；env token 非空；fingerprint 精确匹配；
 * - revoked/rotated/expired/missing/cross-tenant/unsupported identity 全部网络前拒绝，
 *   不自动切换最新 ref；
 * - 错误 message/JSON 不包含 token；headers none 无 Authorization，bearer 原样映射；
 * - 测试清理 env，不能泄漏到其它测试。
 *
 * 本测试只定义 external outbound credential authority：不证明 Runtime hosted workload token，
 * workload_token 也不进入本 external authority（留在 Runtime 域调用方）。
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  OutboundCredentialError,
  outboundCredentialHeaders,
  resolveOutboundCredential,
} from "@/lib/identity/resolve-outbound-credential";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { tenant as tenantTable } from "@/lib/persistence/schema/identity";
import { credentialRefTable } from "@/lib/persistence/schema/tool";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TOKEN = "external-secret-token-a2a";
const ENV_NAME = "SNOWHARNESS_TEST_OUTBOUND_CREDENTIAL_TOKEN";
const FINGERPRINT = `sha256:${createHash("sha256").update(TOKEN, "utf8").digest("hex")}`;

let tenantId: string;
const OTHER_TENANT_ID = "tenant-outbound-credential-other";

beforeEach(async () => {
  await resetDatabase(db);
  const tenant = await ensureDefaultTenant();
  tenantId = tenant.id;
  await db.insert(tenantTable).values({
    id: OTHER_TENANT_ID,
    key: OTHER_TENANT_ID,
    name: OTHER_TENANT_ID,
  });
  process.env[ENV_NAME] = TOKEN;
});

afterEach(() => {
  delete process.env[ENV_NAME];
  process.env.SNOWHARNESS_TEST_OUTBOUND_CREDENTIAL_MISSING = undefined;
});

async function seedCredentialRef(
  overrides: {
    tenantId?: string;
    provider?: string;
    vaultRef?: string;
    fingerprint?: string;
    lifecycleState?: "active" | "revoked" | "rotated";
    expiresAt?: Date | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(credentialRefTable).values({
    id,
    tenantId: overrides.tenantId ?? tenantId,
    provider: overrides.provider ?? "env",
    vaultRef: overrides.vaultRef ?? ENV_NAME,
    fingerprint: overrides.fingerprint ?? FINGERPRINT,
    lifecycleState: overrides.lifecycleState ?? "active",
    ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
  });
  return id;
}

function expectAuthErrorKind(
  promise: Promise<unknown>,
  kind: "identity_mode_invalid" | "credential_ref_conflict" | "credential_unresolvable",
) {
  return expect(promise).rejects.toMatchObject({ kind });
}

describe("resolveOutboundCredential（external authority）", () => {
  it("none：ref=null → {mode:none}；携带 ref → credential_ref_conflict", async () => {
    expect(
      await resolveOutboundCredential({
        tenantId,
        identityMode: "none",
        credentialRefId: null,
      }),
    ).toEqual({ mode: "none" });
    const refId = await seedCredentialRef();
    await expectAuthErrorKind(
      resolveOutboundCredential({ tenantId, identityMode: "none", credentialRefId: refId }),
      "credential_ref_conflict",
    );
  });

  it("bearer：valid env CredentialRef 通过 → {mode:bearer, token}", async () => {
    const refId = await seedCredentialRef();
    const auth = await resolveOutboundCredential({
      tenantId,
      identityMode: "bearer",
      credentialRefId: refId,
    });
    expect(auth).toEqual({ mode: "bearer", token: TOKEN });
  });

  it("bearer：ref 缺失 → credential_ref_conflict", async () => {
    await expectAuthErrorKind(
      resolveOutboundCredential({ tenantId, identityMode: "bearer", credentialRefId: null }),
      "credential_ref_conflict",
    );
  });

  it("bearer：跨租户 ref → 拒绝（租户隔离）", async () => {
    const refId = await seedCredentialRef({ tenantId: OTHER_TENANT_ID });
    await expectAuthErrorKind(
      resolveOutboundCredential({ tenantId, identityMode: "bearer", credentialRefId: refId }),
      "credential_unresolvable",
    );
  });

  it("bearer：revoked / rotated → 拒绝（Rotation fail closed，不切换 ref）", async () => {
    for (const lifecycleState of ["revoked", "rotated"] as const) {
      const refId = await seedCredentialRef({ lifecycleState });
      await expectAuthErrorKind(
        resolveOutboundCredential({ tenantId, identityMode: "bearer", credentialRefId: refId }),
        "credential_unresolvable",
      );
    }
  });

  it("bearer：已过期 → 拒绝", async () => {
    const refId = await seedCredentialRef({ expiresAt: new Date(Date.now() - 1_000) });
    await expectAuthErrorKind(
      resolveOutboundCredential({ tenantId, identityMode: "bearer", credentialRefId: refId }),
      "credential_unresolvable",
    );
  });

  it("bearer：env 缺失 → 拒绝", async () => {
    const refId = await seedCredentialRef({
      vaultRef: "SNOWHARNESS_TEST_OUTBOUND_CREDENTIAL_MISSING",
    });
    await expectAuthErrorKind(
      resolveOutboundCredential({ tenantId, identityMode: "bearer", credentialRefId: refId }),
      "credential_unresolvable",
    );
  });

  it("bearer：env token 空 → 拒绝", async () => {
    process.env.SNOWHARNESS_TEST_OUTBOUND_CREDENTIAL_MISSING = "";
    const refId = await seedCredentialRef({
      vaultRef: "SNOWHARNESS_TEST_OUTBOUND_CREDENTIAL_MISSING",
      fingerprint: `sha256:${createHash("sha256").update("", "utf8").digest("hex")}`,
    });
    await expectAuthErrorKind(
      resolveOutboundCredential({ tenantId, identityMode: "bearer", credentialRefId: refId }),
      "credential_unresolvable",
    );
  });

  it("bearer：指纹不匹配 → 拒绝", async () => {
    const refId = await seedCredentialRef({
      fingerprint: `sha256:${"0".repeat(64)}`,
    });
    await expectAuthErrorKind(
      resolveOutboundCredential({ tenantId, identityMode: "bearer", credentialRefId: refId }),
      "credential_unresolvable",
    );
  });

  it("bearer：provider 非 env → 拒绝（阶段 1 fail closed）", async () => {
    const refId = await seedCredentialRef({ provider: "vault" });
    await expectAuthErrorKind(
      resolveOutboundCredential({ tenantId, identityMode: "bearer", credentialRefId: refId }),
      "credential_unresolvable",
    );
  });

  it("omitted/blank identity/ref 组合 fail closed", async () => {
    // blank identityMode：不属于 none/bearer → identity_mode_invalid。
    await expectAuthErrorKind(
      resolveOutboundCredential({ tenantId, identityMode: "", credentialRefId: null }),
      "identity_mode_invalid",
    );
    // omitted credentialRefId（undefined 语义→ null path）与 blank ref 同列。
    await expectAuthErrorKind(
      resolveOutboundCredential({ tenantId, identityMode: "bearer", credentialRefId: "" }),
      "credential_ref_conflict",
    );
  });

  it("unsupported identity（workload_token/api_key）→ identity_mode_invalid，不自动映射 bearer", async () => {
    // workload_token 属 Runtime 域 hosted token，不进入 external authority。
    await expectAuthErrorKind(
      resolveOutboundCredential({
        tenantId,
        identityMode: "workload_token",
        credentialRefId: null,
      }),
      "identity_mode_invalid",
    );
    await expectAuthErrorKind(
      resolveOutboundCredential({ tenantId, identityMode: "api_key", credentialRefId: null }),
      "identity_mode_invalid",
    );
  });

  it("Secret 红线：错误 message 不回显 token", async () => {
    const badFingerprintRefId = await seedCredentialRef({
      fingerprint: `sha256:${"0".repeat(64)}`,
    });
    const cases: Array<() => Promise<unknown>> = [
      () =>
        resolveOutboundCredential({
          tenantId,
          identityMode: "bearer",
          credentialRefId: "nonexistent-ref",
        }),
      () =>
        resolveOutboundCredential({
          tenantId,
          identityMode: "bearer",
          credentialRefId: badFingerprintRefId,
        }),
    ];
    for (const run of cases) {
      await expect(run()).rejects.toBeInstanceOf(OutboundCredentialError);
      try {
        await run();
      } catch (err) {
        expect((err as Error).message).not.toContain(TOKEN);
        // 错误对象 JSON 序列化也不得包含 token。
        expect(JSON.stringify(err)).not.toContain(TOKEN);
      }
    }
  });
});

describe("outboundCredentialHeaders（external authority）", () => {
  it("none：完全不发送 Authorization", () => {
    expect(outboundCredentialHeaders({ mode: "none" })).toEqual({});
  });

  it("bearer：Authorization: Bearer <external token> 原样映射", () => {
    expect(outboundCredentialHeaders({ mode: "bearer", token: "t" })).toEqual({
      authorization: "Bearer t",
    });
  });

  it("workload_token：不属于 external authority，header 映射本地 fail closed", () => {
    expect(() =>
      outboundCredentialHeaders({ mode: "workload_token", token: "wt" } as never),
    ).toThrow(OutboundCredentialError);
  });
});
