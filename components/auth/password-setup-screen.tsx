"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, apiPath } from "@/lib/api-fetch";
import { useState } from "react";

interface PasswordSetupScreenProps {
  readonly account: string;
  readonly displayName?: string | null;
  readonly returnTo?: string;
  readonly onAuthenticated?: (returnTo: string) => void;
}

export function PasswordSetupScreen({
  account,
  displayName,
  returnTo = "/chat",
  onAuthenticated,
}: PasswordSetupScreenProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  return (
    <main className="flex min-h-dvh items-center overflow-auto bg-background px-[clamp(1.5rem,6vw,6rem)] py-[clamp(2.5rem,10vh,7rem)] text-foreground">
      <section
        aria-label="SnowHarness 首次设密"
        className="mx-auto grid w-full max-w-5xl items-center gap-[clamp(3rem,6vw,5rem)] md:grid-cols-2"
      >
        <div className="space-y-3">
          <p className="font-semibold text-[clamp(1.5rem,2.6vw,2.25rem)] tracking-[-0.04em]">
            SnowHarness
          </p>
          <p className="max-w-sm text-sm leading-6 text-muted-foreground">
            {displayName ? `${displayName}，` : ""}企业身份已验证。请为下次登录设置密码。
          </p>
        </div>

        <form
          className="w-full max-w-[28rem] space-y-5 md:justify-self-end"
          onSubmit={async (event) => {
            event.preventDefault();
            if (submitting) return;
            if (password !== confirmPassword) {
              setError("两次输入的密码不一致");
              return;
            }
            setSubmitting(true);
            setError(null);
            try {
              const response = await apiFetch(
                `/api/auth/setup-password?returnTo=${encodeURIComponent(returnTo)}`,
                {
                  method: "POST",
                  credentials: "include",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ password, confirmPassword }),
                },
              );
              const body = (await response.json().catch(() => null)) as
                | { authenticated: true; return_to: string }
                | { error?: { message?: string } }
                | null;
              if (!response.ok || !body || !("authenticated" in body)) {
                setError(
                  body && "error" in body
                    ? (body.error?.message ?? "密码设置失败，请重新登录")
                    : "密码设置失败，请重新登录",
                );
                return;
              }
              if (onAuthenticated) onAuthenticated(body.return_to);
              else window.location.assign(apiPath(body.return_to));
            } catch {
              setError("暂时无法连接服务器，请稍后重试");
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="setup-account">账号</Label>
            <Input
              id="setup-account"
              value={account}
              readOnly
              aria-readonly="true"
              autoComplete="username"
              className="h-11 rounded-[10px] border-border-strong bg-muted/45 px-3.5 shadow-none"
            />
            <p className="text-xs leading-5 text-muted-foreground">
              此账号来自企业登录，不能修改。
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-password">设置密码</Label>
            <Input
              id="setup-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={1024}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              required
              autoFocus
              className="h-11 rounded-[10px] border-border-strong px-3.5 shadow-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/35"
            />
            <p className="text-xs leading-5 text-muted-foreground">至少 12 个字符。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-confirm-password">确认密码</Label>
            <Input
              id="setup-confirm-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={1024}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={submitting}
              required
              className="h-11 rounded-[10px] border-border-strong px-3.5 shadow-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/35"
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={submitting}
            className="h-11 w-full rounded-[10px] text-sm shadow-none hover:bg-primary/90"
          >
            {submitting ? "正在保存…" : "保存并进入 SnowHarness"}
          </Button>
        </form>
      </section>
    </main>
  );
}
