import { LoginScreen } from "@/components/auth/login-screen";
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

  return <LoginScreen returnTo={returnTo} />;
}

function safeReturnTo(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "/chat";
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : "/chat";
}
