import { LoginScreen } from "@/components/auth/login-screen";
import { getIdentityExtensions } from "@/lib/identity/identity-extension-bootstrap";
import { AuthenticationError, resolvePrincipal } from "@/lib/identity/resolver";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const returnTo = safeReturnTo((await searchParams).returnTo);
  let authenticated = false;
  try {
    await resolvePrincipal(await headers());
    authenticated = true;
  } catch (error) {
    if (!(error instanceof AuthenticationError)) throw error;
  }
  if (authenticated) redirect(returnTo);

  const { authenticationProvider } = await getIdentityExtensions();
  const externalAuth =
    authenticationProvider.beginExternalLogin &&
    authenticationProvider.completeExternalLogin &&
    authenticationProvider.describeExternalAuth
      ? await authenticationProvider.describeExternalAuth({ returnTo })
      : undefined;

  return <LoginScreen returnTo={returnTo} externalAuth={externalAuth} />;
}

function safeReturnTo(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "/chat";
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : "/chat";
}
