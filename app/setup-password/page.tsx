import { PasswordSetupScreen } from "@/components/auth/password-setup-screen";
import { getPasswordEnrollment } from "@/lib/identity/local-authentication";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function PasswordSetupPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const returnTo = safeReturnTo((await searchParams).returnTo);
  const enrollment = await getPasswordEnrollment({ headers: await headers() });
  if (!enrollment) {
    redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  return (
    <PasswordSetupScreen
      account={enrollment.account}
      displayName={enrollment.displayName}
      returnTo={returnTo}
    />
  );
}

function safeReturnTo(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "/chat";
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : "/chat";
}
