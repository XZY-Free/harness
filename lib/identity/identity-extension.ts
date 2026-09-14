import type { UserAuthenticationProvider } from "@/lib/identity/authentication-provider";
import type { EnterpriseProfileSource } from "@/lib/identity/enterprise-profile-source";
import type { EnterpriseAuthorizationProvider } from "./enterprise-authorization";

export interface IdentityExtension {
  readonly authenticationProvider: UserAuthenticationProvider;
  readonly profileSource?: EnterpriseProfileSource;
  readonly authorizationProvider?: EnterpriseAuthorizationProvider;
}

export type IdentityExtensionFactory = () => IdentityExtension | Promise<IdentityExtension>;

export class IdentityExtensionConfigurationError extends Error {
  constructor(
    public readonly code: "identity_extension_provider_conflict" | "identity_extension_invalid",
    message: string,
  ) {
    super(message);
    this.name = "IdentityExtensionConfigurationError";
  }
}

/**
 * 服务端进程级组合根。初始化 Promise 也会缓存失败结果，避免失败后偷偷换回默认身份。
 */
export class IdentityExtensionBootstrap {
  private initialization: Promise<IdentityExtension> | null = null;
  private selected: IdentityExtension | null = null;

  constructor(private readonly factory: IdentityExtensionFactory) {}

  initialize(): Promise<IdentityExtension> {
    if (this.initialization) return this.initialization;
    this.initialization = Promise.resolve()
      .then(() => this.factory())
      .then((extension) => {
        validateExtension(extension);
        this.selected = extension;
        return extension;
      });
    return this.initialization;
  }

  assertSameProvider(extension: IdentityExtension): void {
    if (!this.selected) {
      throw new IdentityExtensionConfigurationError(
        "identity_extension_invalid",
        "身份扩展尚未完成初始化",
      );
    }
    if (this.selected.authenticationProvider !== extension.authenticationProvider) {
      throw new IdentityExtensionConfigurationError(
        "identity_extension_provider_conflict",
        "身份扩展已冻结，不能替换认证提供器",
      );
    }
  }
}

function validateExtension(extension: IdentityExtension): void {
  if (!extension || typeof extension !== "object") {
    throw new IdentityExtensionConfigurationError(
      "identity_extension_invalid",
      "身份扩展必须是对象",
    );
  }
  const authorization = extension.authorizationProvider;
  if (
    authorization &&
    (!authorization.name?.trim() ||
      typeof authorization.evaluate !== "function" ||
      (authorization.agentIds !== "all" &&
        (!Array.isArray(authorization.agentIds) ||
          !authorization.agentIds.length ||
          authorization.agentIds.some((id) => typeof id !== "string" || !id.trim()))))
  ) {
    throw new IdentityExtensionConfigurationError(
      "identity_extension_invalid",
      "企业授权提供器必须声明明确的智能体接管范围",
    );
  }
  const provider = extension.authenticationProvider;
  if (!provider || typeof provider !== "object" || typeof provider.authenticate !== "function") {
    throw new IdentityExtensionConfigurationError(
      "identity_extension_invalid",
      "身份扩展必须提供认证提供器",
    );
  }
  if (typeof provider.name !== "string" || provider.name.trim().length === 0) {
    throw new IdentityExtensionConfigurationError(
      "identity_extension_invalid",
      "认证提供器必须有稳定名称",
    );
  }
}
