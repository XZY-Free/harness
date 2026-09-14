import type { EnterpriseProfileObservation } from "@/lib/identity/enterprise-profile-source";

export interface AuthenticatedUserEvidence {
  readonly externalSubject: string;
  /** 由认证提供器确认的登录账号；不能接受浏览器表单自报。 */
  readonly loginAccount?: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly trustedAuthenticationClaims: Readonly<Record<string, unknown>>;
  readonly enterpriseProfileObservation?: EnterpriseProfileObservation;
}

export type AuthenticationResult =
  | { readonly status: "authenticated"; readonly evidence: AuthenticatedUserEvidence }
  | { readonly status: "unauthenticated" }
  | { readonly status: "denied"; readonly reason: string };

export interface AuthenticationLoginContext {
  readonly account: string;
  readonly password: string;
}

export interface ExternalAuthenticationLoginContext {
  readonly request: Request;
  readonly callbackUrl: string;
  readonly returnTo: string;
  readonly state: string;
}

/** 通用图标 token；具体字形由公共组件渲染，品牌语义由部署侧配置选择。 */
export type ExternalAuthIcon = "building" | "network" | "chat" | "mail" | "phone" | "key";

export type ExternalAuthDisplayMode = "auto" | "button" | "tiles" | "stacked";

export interface ExternalAuthMethod {
  readonly id: string;
  readonly label: string;
  /** 逻辑路径（如 /api/auth/sso?returnTo=...），渲染时经 apiPath 映射。 */
  readonly href: string;
  readonly icon?: ExternalAuthIcon;
  readonly recommended?: boolean;
}

export interface ExternalAuthZoneConfig {
  readonly dividerLabel: string;
  readonly methods: ReadonlyArray<ExternalAuthMethod>;
  readonly displayMode?: ExternalAuthDisplayMode;
}

export interface AuthenticationRedirect {
  readonly location: string;
}

export type AuthenticationLoginResult =
  | {
      readonly status: "authenticated";
      readonly sessionToken: string;
      readonly expiresAt: Date;
      readonly user: {
        readonly account: string;
        readonly email: string;
        readonly displayName: string | null;
      };
    }
  | { readonly status: "denied" }
  | { readonly status: "rate_limited"; readonly retryAfterSeconds: number };

export interface UserAuthenticationProvider {
  readonly name: string;
  authenticate(input: { readonly headers: Headers }): Promise<AuthenticationResult>;
  login?(context: AuthenticationLoginContext): Promise<AuthenticationLoginResult>;
  beginExternalLogin?(context: ExternalAuthenticationLoginContext): Promise<AuthenticationRedirect>;
  completeExternalLogin?(request: Request): Promise<AuthenticationResult>;
  /** 登录页外部认证区配置；缺省时登录页不渲染认证区。 */
  describeExternalAuth?(context: {
    readonly returnTo: string;
  }): Promise<ExternalAuthZoneConfig> | ExternalAuthZoneConfig;
  /** 本地会话由平台先撤销；企业可清理自身状态并返回浏览器级 HTTPS 注销跳转。
   * returnToUrl 由平台生成，不能使用浏览器提交的任意回跳地址。
   */
  logout?(input: {
    readonly headers: Headers;
    readonly returnToUrl?: string;
    // biome-ignore lint/suspicious/noConfusingVoidType: 保留已有 Promise<void> 退出提供器的合同。
  }): Promise<void | AuthenticationRedirect>;
}

export class AuthenticationProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationProviderConfigurationError";
  }
}
