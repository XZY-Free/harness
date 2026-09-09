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
  readonly email: string;
  readonly password: string;
}

export type AuthenticationLoginResult =
  | {
      readonly status: "authenticated";
      readonly sessionToken: string;
      readonly expiresAt: Date;
      readonly user: { readonly email: string; readonly displayName: string | null };
    }
  | { readonly status: "denied" }
  | { readonly status: "rate_limited"; readonly retryAfterSeconds: number };

export interface UserAuthenticationProvider {
  readonly name: string;
  authenticate(input: { readonly headers: Headers }): Promise<AuthenticationResult>;
  login?(context: AuthenticationLoginContext): Promise<AuthenticationLoginResult>;
  logout?(input: { readonly headers: Headers }): Promise<void>;
}

export class AuthenticationProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationProviderConfigurationError";
  }
}
