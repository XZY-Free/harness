import { AuthenticationError, resolvePrincipal } from "@/lib/identity/resolver";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function requireAuthenticatedPage(returnTo: string): Promise<void> {
  try {
    await resolvePrincipal(await headers());
  } catch (error) {
    if (error instanceof AuthenticationError) {
      redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    throw error;
  }
}
