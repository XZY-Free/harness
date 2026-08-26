/**
 * 唯一 Outbound Runtime Auth Resolver 测试（03 专项 §5/§9/§13/§14）。
 *
 * 不变量：
 * - 只做 tenantId + identityMode + credentialRefId → RuntimeTransportAuth；
 * - none 要求 ref=null；bearer 逐项验证 CredentialRef（同租户/存在/active/未过期/
 *   provider=env/env 存在非空/指纹一致），任一失败网络前 fail closed；
 * - workload_token / api_key 在 external 侧 fail closed（不自动映射 bearer）；
 * - Secret 红线：错误信息不回显 token；Rotation（rotated/revoked）不自动切换 ref。
 *
 * 事实源：docs/V12/01/03-ExternalRuntime-CredentialAuthority.md。
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { tenant as tenantTable } from "@/lib/persistence/schema/identity";
import { credentialRefTable } from "@/lib/persistence/schema/tool";
import {
  OutboundRuntimeAuthError,
  outboundAuthHeaders,
  resolveOutboundRuntimeAuth,
} from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { beforeEach, describe, expect, it } from "vitest";

const TOKEN = "external-secret-token-03";
const ENV_NAME = "SNOWHARNESS_TEST_OUTBOUND_TOKEN";
const FINGERPRINT = `sha256:${createHash("sha256").update(TOKEN, "utf8").digest("hex")}`;

let tenantId: string;
const OTHER_TENANT_ID = "tenant-outbound-other";

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

describe("resolveOutboundRuntimeAuth（03 §5）", () => {
  it("none：ref=null → {mode:none}；携带 ref → credential_ref_conflict", async () => {
    expect(
      await resolveOutboundRuntimeAuth({ tenantId, identityMode: "none", credentialRefId: null }),
    ).toEqual({
      mode: "none",
    });
    const refId = await seedCredentialRef();
    await expectAuthErrorKind(
      resolveOutboundRuntimeAuth({ tenantId, identityMode: "none", credentialRefId: refId }),
      "credential_ref_conflict",
    );
  });

  it("bearer：valid env CredentialRef 通过 → {mode:bearer, token}", async () => {
    const refId = await seedCredentialRef();
    const auth = await resolveOutboundRuntimeAuth({
      tenantId,
      identityMode: "bearer",
      credentialRefId: refId,
    });
    expect(auth).toEqual({ mode: "bearer", token: TOKEN });
  });

  it("bearer：ref 缺失 → credential_ref_conflict", async () => {
    await expectAuthErrorKind(
      resolveOutboundRuntimeAuth({ tenantId, identityMode: "bearer", credentialRefId: null }),
      "credential_ref_conflict",
    );
  });

  it("bearer：跨租户 ref → 拒绝（租户隔离）", async () => {
    const refId = await seedCredentialRef({ tenantId: OTHER_TENANT_ID });
    await expectAuthErrorKind(
      resolveOutboundRuntimeAuth({ tenantId, identityMode: "bearer", credentialRefId: refId }),
      "credential_unresolvable",
    );
  });

  it("bearer：revoked / rotated → 拒绝（Rotation fail closed，不切换 ref）", async () => {
    for (const lifecycleState of ["revoked", "rotated"] as const) {
      const refId = await seedCredentialRef({ lifecycleState });
      await expectAuthErrorKind(
        resolveOutboundRuntimeAuth({ tenantId, identityMode: "bearer", credentialRefId: refId }),
        "credential_unresolvable",
      );
    }
  });

  it("bearer：已过期 → 拒绝", async () => {
    const refId = await seedCredentialRef({ expiresAt: new Date(Date.now() - 1_000) });
    await expectAuthErrorKind(
      resolveOutboundRuntimeAuth({ tenantId, identityMode: "bearer", credentialRefId: refId }),
      "credential_unresolvable",
    );
  });

  it("bearer：env 缺失 → 拒绝", async () => {
    const refId = await seedCredentialRef({ vaultRef: "SNOWHARNESS_TEST_OUTBOUND_MISSING" });
    await expectAuthErrorKind(
      resolveOutboundRuntimeAuth({ tenantId, identityMode: "bearer", credentialRefId: refId }),
      "credential_unresolvable",
    );
  });

  it("bearer：指纹不匹配 → 拒绝", async () => {
    const refId = await seedCredentialRef({
      fingerprint: `sha256:${"0".repeat(64)}`,
    });
    await expectAuthErrorKind(
      resolveOutboundRuntimeAuth({ tenantId, identityMode: "bearer", credentialRefId: refId }),
      "credential_unresolvable",
    );
  });

  it("bearer：provider 非 env → 拒绝（阶段 1 fail closed）", async () => {
    const refId = await seedCredentialRef({ provider: "vault" });
    await expectAuthErrorKind(
      resolveOutboundRuntimeAuth({ tenantId, identityMode: "bearer", credentialRefId: refId }),
      "credential_unresolvable",
    );
  });

  it("external 侧 workload_token / api_key → identity_mode_invalid（不自动映射 bearer）", async () => {
    await expectAuthErrorKind(
      resolveOutboundRuntimeAuth({
        tenantId,
        identityMode: "workload_token",
        credentialRefId: null,
      }),
      "identity_mode_invalid",
    );
    await expectAuthErrorKind(
      resolveOutboundRuntimeAuth({ tenantId, identityMode: "api_key", credentialRefId: null }),
      "identity_mode_invalid",
    );
  });

  it("Secret 红线：所有失败错误信息不回显 token", async () => {
    const badFingerprintRefId = await seedCredentialRef({
      fingerprint: `sha256:${"0".repeat(64)}`,
    });
    const cases: Array<() => Promise<unknown>> = [
      () =>
        resolveOutboundRuntimeAuth({
          tenantId,
          identityMode: "bearer",
          credentialRefId: "nonexistent-ref",
        }),
      () =>
        resolveOutboundRuntimeAuth({
          tenantId,
          identityMode: "bearer",
          credentialRefId: badFingerprintRefId,
        }),
    ];
    for (const run of cases) {
      await expect(run()).rejects.toBeInstanceOf(OutboundRuntimeAuthError);
      try {
        await run();
      } catch (err) {
        expect((err as Error).message).not.toContain(TOKEN);
      }
    }
  });
});

describe("outboundAuthHeaders（03 §9）", () => {
  it("none：完全不发送 Authorization", () => {
    expect(outboundAuthHeaders({ mode: "none" })).toEqual({});
  });

  it("bearer：Authorization: Bearer <external token>", () => {
    expect(outboundAuthHeaders({ mode: "bearer", token: "t" })).toEqual({
      authorization: "Bearer t",
    });
  });

  it("workload_token：External A2A 本地 fail closed；Hosted（allowWorkloadToken）放行", () => {
    expect(() => outboundAuthHeaders({ mode: "workload_token", token: "wt" })).toThrow(
      OutboundRuntimeAuthError,
    );
    expect(
      outboundAuthHeaders({ mode: "workload_token", token: "wt" }, { allowWorkloadToken: true }),
    ).toEqual({ authorization: "Bearer wt" });
  });
});
