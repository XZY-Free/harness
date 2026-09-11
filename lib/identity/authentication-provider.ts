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
  readonly externalLoginLabel?: string;
  authenticate(input: { readonly headers: Headers }): Promise<AuthenticationResult>;
  login?(context: AuthenticationLoginContext): Promise<AuthenticationLoginResult>;
  beginExternalLogin?(context: ExternalAuthenticationLoginContext): Promise<AuthenticationRedirect>;
  completeExternalLogin?(request: Request): Promise<AuthenticationResult>;
  logout?(input: { readonly headers: Headers }): Promise<void>;
}

export class AuthenticationProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationProviderConfigurationError";
  }
}
