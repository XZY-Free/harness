"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, apiPath } from "@/lib/api-fetch";
import { useState } from "react";

interface LoginFormProps {
  readonly returnTo?: string;
  readonly onAuthenticated?: (returnTo: string) => void;
}

export function LoginForm({ returnTo = "/chat", onAuthenticated }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      className="w-full space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
          const response = await apiFetch(
            `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
            {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ email: email.trim(), password }),
            },
          );
          const body = (await response.json().catch(() => null)) as
            | { authenticated: true; return_to: string }
            | { error?: { message?: string } }
            | null;
          if (!response.ok || !body || !("authenticated" in body)) {
            setError(
              body && "error" in body
                ? (body.error?.message ?? "登录失败，请重试")
                : "登录失败，请重试",
            );
            return;
          }
          if (onAuthenticated) {
            onAuthenticated(body.return_to);
          } else {
            window.location.assign(apiPath(body.return_to));
          }
        } catch {
          setError("暂时无法连接服务器，请稍后重试");
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="login-email" className="text-sm font-medium tracking-[-0.01em]">
          邮箱
        </Label>
        <Input
          id="login-email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
          required
          autoFocus
          className="h-11 rounded-[10px] border-border-strong px-3.5 shadow-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/35"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="login-password" className="text-sm font-medium tracking-[-0.01em]">
          密码
        </Label>
        <Input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
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
        {submitting ? "正在登录…" : "登录"}
      </Button>
    </form>
  );
}
