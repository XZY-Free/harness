import {
  type UserAuthenticationProvider,
  openSourceAuthenticationProvider,
} from "@/lib/identity/authentication-provider";
import type { IdentityExtension } from "@/lib/identity/identity-extension";

/**
 * 开源发行版的静态组合根。
 * 私有发行版在构建时替换此模块；运行期不从请求参数选择身份提供器。
 */
export function createIdentityExtension(): IdentityExtension {
  return {
    authenticationProvider: openSourceAuthenticationProvider,
  };
}

export function getConfiguredAuthenticationProvider(): UserAuthenticationProvider {
  return createIdentityExtension().authenticationProvider;
}
