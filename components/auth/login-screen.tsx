import { LoginForm } from "./login-form";

interface LoginScreenProps {
  readonly returnTo?: string;
  readonly onAuthenticated?: (returnTo: string) => void;
}

export function LoginScreen({ returnTo = "/chat", onAuthenticated }: LoginScreenProps) {
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
          <LoginForm returnTo={returnTo} onAuthenticated={onAuthenticated} />
        </div>
      </section>
    </main>
  );
}
