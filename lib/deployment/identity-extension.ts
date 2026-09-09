import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import type { UserAuthenticationProvider } from "@/lib/identity/authentication-provider";
import type { IdentityExtension } from "@/lib/identity/identity-extension";
import { localAuthenticationProvider } from "@/lib/identity/local-authentication";

const explicitVitestIdentityFixture: UserAuthenticationProvider = {
  name: "vitest-explicit-identity-fixture",
  async authenticate() {
    return {
      status: "authenticated",
      evidence: {
        externalSubject: DEFAULT_USER_ID,
        email: DEFAULT_USER_EMAIL,
        displayName: DEFAULT_USER_NAME,
        trustedAuthenticationClaims: {},
      },
    };
  },
};

/**
 * 开源发行版的静态组合根。
 * 私有发行版在构建时替换此模块；运行期不从请求参数选择身份提供器。
 */
export function createIdentityExtension(): IdentityExtension {
  return {
    // 仅 Vitest 进程且测试文件显式开启时注入固定身份。APP_ENV=test 的真实应用、
    // Playwright、开发和生产都不会进入此分支，产品行为始终要求真实登录。
    authenticationProvider:
      process.env.VITEST === "true" && process.env.SNOW_VITEST_IDENTITY_FIXTURE === "enabled"
        ? explicitVitestIdentityFixture
        : localAuthenticationProvider,
  };
}

export function getConfiguredAuthenticationProvider(): UserAuthenticationProvider {
  return createIdentityExtension().authenticationProvider;
}
