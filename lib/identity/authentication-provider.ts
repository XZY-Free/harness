import { authConfig } from "@/lib/config";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import type { EnterpriseProfileObservation } from "@/lib/identity/enterprise-profile-source";

export interface AuthenticatedUserEvidence {
  readonly externalSubject: string;
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
  readonly returnTo: string;
}

export interface AuthenticationRedirect {
  readonly location: string;
}

export interface UserAuthenticationProvider {
  readonly name: string;
  authenticate(input: { readonly headers: Headers }): Promise<AuthenticationResult>;
  login?(context: AuthenticationLoginContext): Promise<AuthenticationRedirect>;
  callback?(request: Request): Promise<AuthenticationResult>;
  logout?(input: { readonly headers: Headers }): Promise<AuthenticationRedirect | undefined>;
}

export class AuthenticationProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationProviderConfigurationError";
  }
}

/** 开源主仓认证提供器：保留现有 dev / trusted-headers 两种正式入口。 */
export const openSourceAuthenticationProvider: UserAuthenticationProvider = {
  name: "open-source",
  async authenticate({ headers }) {
    if (authConfig.mode === "dev") {
      return {
        status: "authenticated",
        evidence: {
          externalSubject: DEFAULT_USER_ID,
          email: DEFAULT_USER_EMAIL,
          displayName: DEFAULT_USER_NAME,
          trustedAuthenticationClaims: {},
        },
      };
    }

    const externalSubject = headerValue(headers, authConfig.externalIdHeader);
    const email = headerValue(headers, authConfig.emailHeader);
    const displayName = headerValue(headers, authConfig.nameHeader);
    if (!externalSubject) return { status: "unauthenticated" };
    if (!email) return { status: "denied", reason: "缺少 SSO 用户邮箱" };

    return {
      status: "authenticated",
      evidence: {
        externalSubject,
        email,
        displayName,
        trustedAuthenticationClaims: {},
      },
    };
  },
};

function headerValue(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value?.trim() ? value.trim() : null;
}
