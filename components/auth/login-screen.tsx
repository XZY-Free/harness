import { LoginForm } from "./login-form";

interface LoginScreenProps {
  readonly returnTo?: string;
  readonly onAuthenticated?: (returnTo: string) => void;
}

export function LoginScreen({ returnTo = "/chat", onAuthenticated }: LoginScreenProps) {
  return (
    <main className="flex min-h-dvh items-center justify-center overflow-auto bg-background px-6 py-[clamp(2rem,9vh,5rem)] text-foreground">
      <section aria-labelledby="login-title" className="w-full max-w-80">
        <header className="mb-7 text-center">
          <p className="mb-5 font-semibold text-[15px] tracking-[-0.01em]">SnowHarness</p>
          <h1 id="login-title" className="font-semibold text-xl tracking-[-0.02em]">
            登录
          </h1>
        </header>
        <LoginForm returnTo={returnTo} onAuthenticated={onAuthenticated} />
      </section>
    </main>
  );
}
