/**
 * 执行链企业上下文薄壳——端到端验证（临时脚本，不随仓提交）。
 *
 * 验证链路：lib/identity/prepare-enterprise-user-context（薄壳）→ identity-client
 * → auth-center POST /api/enterprise/user-context → 错误映射回 RequirementError。
 *
 * 前置：auth-center 在 NEX_AUTH_CENTER_URL（默认 http://127.0.0.1:3100）运行；dev 管理员密码可取。
 * 运行（snow_harness 内）：
 *   APP_ENV=development NEX_AUTH_CENTER_URL=http://127.0.0.1:3100 pnpm tsx tmp/enterprise-shell-smoke.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH = process.env.NEX_AUTH_CENTER_URL ?? "http://127.0.0.1:3100";
const ACCOUNT = "admin@nexharness.local";

let failures = 0;
let checks = 0;
function expect(condition: boolean, label: string, detail?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}`, detail !== undefined ? String(detail).slice(0, 200) : "");
}

async function main(): Promise<void> {
  console.log(`\n== 执行链企业上下文薄壳 · 端到端（${AUTH}）==\n`);
  const password = readFileSync(
    join(homedir(), ".config", "nexharness", "dev-admin-password.txt"),
    "utf-8",
  ).trim();

  // 1. 登录拿 ticket → 兑换会话 token
  const login = await fetch(
    `${AUTH}/api/auth/login?returnTo=${encodeURIComponent("http://localhost:3000/chat")}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: ACCOUNT, password }),
    },
  );
  const loginBody = (await login.json()) as { redirect_to?: string };
  const ticket = loginBody.redirect_to
    ? (new URL(loginBody.redirect_to).searchParams.get("ticket") ?? "")
    : "";
  expect(login.status === 200 && Boolean(ticket), "登录并取得 ticket", login.status);
  const resolve = await fetch(`${AUTH}/api/session/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  const resolveBody = (await resolve.json()) as {
    sessionToken?: string;
    principal?: { tenantId: string; userIdentityId: string };
  };
  const token = resolveBody.sessionToken ?? "";
  const principal = resolveBody.principal;
  expect(resolve.status === 200 && Boolean(token), "兑换会话 token", resolve.status);
  if (!principal) throw new Error("principal 缺失");

  // 2. 注册 token 到 identity-client 注册表（等同一次请求校验）
  const { introspectSession, clearIdentityClientCaches } = await import("@/lib/identity-client");
  const remote = await introspectSession(token, { bypassCache: true });
  expect(remote?.userIdentityId === principal.userIdentityId, "introspect 注册 token");

  // 3. 薄壳主路径：stale_allowed → 开源部署无资料源 → unavailable（映射自 409）
  const { prepareEnterpriseUserContext, finalizeEnterpriseUserContextCandidate } = await import(
    "@/lib/identity/prepare-enterprise-user-context"
  );
  const { EnterpriseUserContextRequirementError } = await import(
    "@/lib/identity/enterprise-user-access-policy"
  );
  try {
    await prepareEnterpriseUserContext({
      tenantId: principal.tenantId,
      userIdentityId: principal.userIdentityId,
      policy: { profileRequirement: "stale_allowed", allowedFields: [] },
    });
    expect(false, "stale_allowed 应抛 unavailable");
  } catch (error) {
    if (error instanceof EnterpriseUserContextRequirementError) {
      expect(
        error.code === "enterprise_user_context_unavailable" &&
          error.message.includes("受信企业资料来源"),
        "stale_allowed → unavailable（auth-center 权威消息透传）",
        `${error.code}: ${error.message}`,
      );
    } else {
      expect(false, "错误类型应为 EnterpriseUserContextRequirementError", error);
    }
  }

  // 4. profileRequirement=none → null（本地短路，不发请求）
  const noneCandidate = await prepareEnterpriseUserContext({
    tenantId: principal.tenantId,
    userIdentityId: principal.userIdentityId,
    policy: { profileRequirement: "none", allowedFields: [] },
  });
  expect(noneCandidate === null, "none → null（本地短路）");

  // 5. service-subject 分支 → unavailable（与既有行为一致）
  try {
    await prepareEnterpriseUserContext({
      tenantId: principal.tenantId,
      userIdentityId: "service-subject",
      policy: { profileRequirement: "stale_allowed", allowedFields: [] },
    });
    expect(false, "service-subject 应抛 unavailable");
  } catch (error) {
    expect(
      error instanceof EnterpriseUserContextRequirementError &&
        error.code === "enterprise_user_context_unavailable",
      "service-subject → unavailable（行为等价）",
      error,
    );
  }

  // 6. 终稿复核纯函数（本地）：过期证据 → unavailable
  try {
    finalizeEnterpriseUserContextCandidate(
      {
        publicContext: {
          context_version: "1",
          profile_status: "fresh",
          last_verified_at: new Date(0).toISOString(),
          fields: {},
        },
        evidence: {
          tenantId: principal.tenantId,
          userIdentityId: principal.userIdentityId,
          profileRequirement: "stale_allowed",
          sourceSystem: "smoke",
          profileFingerprint: "fp",
          lastVerifiedAt: new Date(0),
          freshUntil: new Date(0),
          staleUntil: new Date(0),
          maxFreshAgeMs: 1000,
          maxStaleAgeMs: 1000,
        },
      },
      new Date(),
    );
    expect(false, "过期候选应抛 unavailable");
  } catch (error) {
    expect(
      error instanceof EnterpriseUserContextRequirementError && error.message.includes("已失效"),
      "终稿复核：过期候选 → unavailable",
      error,
    );
  }

  // 7. 自动清理（脚本结束）
  clearIdentityClientCaches();

  console.log(`\n== 结果：${checks - failures}/${checks} 通过 ==\n`);
  if (failures > 0) process.exitCode = 1;
}

void main();
