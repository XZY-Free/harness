/**
 * 企业用户适配器的注册、选择和装配边界。
 *
 * 主仓只提供 default 适配器和 enterprise 注册接口；具体企业目录连接器必须由部署方
 * 在启动、首次解析前注册，不能作为主仓 Mock/Fake 或硬编码资料进入生产路径。
 */
import { enterpriseUserConfig } from "@/lib/config";
import type { EnterpriseUserProfileSnapshot } from "@/lib/identity/enterprise-user";

export type EnterpriseUserAdapterMode = "default" | "enterprise";
export type EnterpriseUserAdapterConfigurationCode =
  | "enterprise_user_adapter_not_registered"
  | "enterprise_user_adapter_already_selected";

export interface EnterpriseUserAdapterSubject {
  tenantId: string;
  tenantKey: string;
  externalSubject: string;
  email: string;
  displayName: string | null;
}

export interface EnterpriseUserAdapter {
  readonly kind: "enterprise";
  fetchFullProfile(subject: EnterpriseUserAdapterSubject): Promise<EnterpriseUserProfileSnapshot>;
}

interface DefaultEnterpriseUserAdapter {
  readonly kind: "default";
  fetchFullProfile(subject: EnterpriseUserAdapterSubject): Promise<EnterpriseUserProfileSnapshot>;
}

export type SelectedEnterpriseUserAdapter = EnterpriseUserAdapter | DefaultEnterpriseUserAdapter;

export class EnterpriseUserAdapterConfigurationError extends Error {
  constructor(
    public readonly code: EnterpriseUserAdapterConfigurationCode,
    message: string,
  ) {
    super(message);
    this.name = "EnterpriseUserAdapterConfigurationError";
  }
}

/**
 * 每个进程一个注册表。resolve 后选择即冻结，避免按请求、用户或失败结果切换适配器。
 */
export class EnterpriseUserAdapterRegistry {
  private enterpriseAdapter: EnterpriseUserAdapter | null = null;
  private selected = false;

  constructor(private readonly mode: EnterpriseUserAdapterMode) {}

  registerEnterpriseAdapter(adapter: EnterpriseUserAdapter): void {
    if (this.selected) {
      throw new EnterpriseUserAdapterConfigurationError(
        "enterprise_user_adapter_already_selected",
        "企业用户适配器已被选定，不能在运行期间更换",
      );
    }
    this.enterpriseAdapter = adapter;
  }

  resolve(): SelectedEnterpriseUserAdapter {
    this.selected = true;
    if (this.mode === "default") return defaultEnterpriseUserAdapter;
    if (this.enterpriseAdapter) return this.enterpriseAdapter;
    throw new EnterpriseUserAdapterConfigurationError(
      "enterprise_user_adapter_not_registered",
      "企业用户模式已启用，但未注册企业用户适配器",
    );
  }
}

const defaultEnterpriseUserAdapter: DefaultEnterpriseUserAdapter = {
  kind: "default",
  async fetchFullProfile(subject) {
    return {
      externalSubject: subject.externalSubject,
      email: subject.email,
      displayName: subject.displayName,
      status: "active",
      sourceSystem: "snowharness-default",
      attributes: {},
    };
  },
};

let runtimeRegistry: EnterpriseUserAdapterRegistry | null = null;

function getRuntimeRegistry(): EnterpriseUserAdapterRegistry {
  if (!runtimeRegistry) {
    runtimeRegistry = new EnterpriseUserAdapterRegistry(enterpriseUserConfig.adapterMode);
  }
  return runtimeRegistry;
}

/** 部署方在启动期间调用，用其私有连接器注册 enterprise 实现。 */
export function registerEnterpriseUserAdapter(adapter: EnterpriseUserAdapter): void {
  getRuntimeRegistry().registerEnterpriseAdapter(adapter);
}

/** 当前进程唯一选中的正式适配器。enterprise 未注册时稳定失败关闭。 */
export function getEnterpriseUserAdapter(): SelectedEnterpriseUserAdapter {
  return getRuntimeRegistry().resolve();
}
