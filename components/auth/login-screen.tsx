import { apiPath } from "@/lib/api-fetch";
import { LoginForm } from "./login-form";

interface LoginScreenProps {
  readonly returnTo?: string;
  readonly onAuthenticated?: (returnTo: string) => void;
  readonly externalLoginLabel?: string;
}

export function LoginScreen({
  returnTo = "/chat",
  onAuthenticated,
  externalLoginLabel,
}: LoginScreenProps) {
  return (
    <main className="flex min-h-dvh items-center overflow-auto bg-background px-[clamp(1.5rem,6vw,6rem)] py-[clamp(2.5rem,10vh,7rem)] text-foreground">
      <section
        aria-label="SnowHarness 登录"
        className="mx-auto grid w-full max-w-5xl items-center gap-[clamp(3rem,6vw,5rem)] md:grid-cols-2"
      >
        <p className="font-semibold text-[clamp(1.5rem,2.6vw,2.25rem)] tracking-[-0.04em]">
          SnowHarness
        </p>
        <div className="w-full max-w-[28rem] md:justify-self-end">
          {externalLoginLabel ? (
            <>
              <a
                href={apiPath(`/api/auth/sso?returnTo=${encodeURIComponent(returnTo)}`)}
                className="flex h-11 w-full items-center justify-center rounded-[10px] border border-border-strong bg-background px-4 text-sm font-medium transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
              >
                {externalLoginLabel}
              </a>
              <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>或使用密码</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          ) : null}
          <LoginForm returnTo={returnTo} onAuthenticated={onAuthenticated} />
        </div>
      </section>
    </main>
  );
}
