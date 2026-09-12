"use client";

import type { ExternalAuthZoneConfig } from "@/lib/identity/authentication-provider";
import { AuthScreenLayout } from "./auth-screen-layout";
import { LoginForm } from "./login-form";

interface LoginScreenProps {
  readonly returnTo?: string;
  readonly onAuthenticated?: (returnTo: string) => void;
  readonly externalAuth?: ExternalAuthZoneConfig;
}

export function LoginScreen({
  returnTo = "/chat",
  onAuthenticated,
  externalAuth,
}: LoginScreenProps) {
  return (
    <AuthScreenLayout title="登录">
      <LoginForm
        returnTo={returnTo}
        onAuthenticated={onAuthenticated}
        externalAuth={externalAuth}
      />
    </AuthScreenLayout>
  );
}
