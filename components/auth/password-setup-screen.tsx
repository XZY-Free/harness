"use client";

import { useBrand } from "@/components/brand/brand-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, apiPath } from "@/lib/api-fetch";
import {
  MIN_ACCEPTABLE_STRENGTH,
  PASSWORD_MIN_LENGTH,
  isPasswordLengthAcceptable,
  passwordStrengthScore,
} from "@/lib/identity/password-strength";
import { useRef, useState } from "react";
import { AuthScreenLayout } from "./auth-screen-layout";

const STRENGTH_WORDS = ["", "弱", "中", "好", "强"] as const;
const STRENGTH_WORD_CLASS = [
  "",
  "text-destructive",
  "text-warning",
  "text-success",
  "text-success",
] as const;
const STRENGTH_SEGMENT_CLASS = [
  "",
  "bg-destructive",
  "bg-warning",
  "bg-success",
  "bg-success",
] as const;

/** 字段行栅格：控件 1fr + 预留 72px 状态栏，全行等宽对齐、状态出现零布局抖动。 */
const FIELD_ROW_CLASS = "grid grid-cols-[minmax(0,1fr)_72px] items-center gap-x-2.5";

interface PasswordSetupScreenProps {
  readonly account: string;
  readonly returnTo?: string;
  readonly onAuthenticated?: (returnTo: string) => void;
}

export function PasswordSetupScreen({
  account,
  returnTo = "/chat",
  onAuthenticated,
}: PasswordSetupScreenProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const brand = useBrand();

  const score = passwordStrengthScore(password);
  const lengthOk = isPasswordLengthAcceptable(password);
  const passwordInvalid = password.length > 0 && (!lengthOk || score < MIN_ACCEPTABLE_STRENGTH);
  const strengthWord =
    password.length === 0
      ? ""
      : !lengthOk
        ? password.length < PASSWORD_MIN_LENGTH
          ? "太短"
          : "太长"
        : score < MIN_ACCEPTABLE_STRENGTH
          ? "太弱"
          : STRENGTH_WORDS[score];
  const strengthWordClass =
    password.length === 0 ? "" : passwordInvalid ? "text-destructive" : STRENGTH_WORD_CLASS[score];
  const matchState =
    confirmPassword.length === 0
      ? null
      : password === confirmPassword
        ? ("ok" as const)
        : ("mismatch" as const);

  return (
    <AuthScreenLayout title="首次设密">
      <form
        className="w-full space-y-5"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting) return;
          if (password.length === 0 || passwordInvalid) {
            passwordRef.current?.focus();
            return;
          }
          if (matchState !== "ok") {
            confirmRef.current?.focus();
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
          <span className="sr-only">账号来自企业登录，不能修改。</span>
          <div className={FIELD_ROW_CLASS}>
            <div className="flex h-11 items-center gap-2 rounded-[10px] border border-border-strong bg-muted/45 px-3.5 text-sm">
              <span className="truncate">{account}</span>
              <span className="ml-auto flex-none rounded-[5px] bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                企业身份
              </span>
            </div>
            <span aria-hidden="true" />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="setup-password">设置密码</Label>
          <span id="setup-password-hint" className="sr-only">
            8–128 个字符，避免常见密码。
          </span>
          <div className={FIELD_ROW_CLASS}>
            <Input
              id="setup-password"
              ref={passwordRef}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              autoFocus
              aria-invalid={passwordInvalid || undefined}
              aria-describedby="setup-password-hint setup-password-state"
              className={`h-11 rounded-[10px] px-3.5 shadow-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/35 ${
                passwordInvalid ? "border-destructive" : "border-border-strong"
              }`}
            />
            <span className="flex flex-col gap-[3px]">
              <span aria-hidden="true" className="flex gap-[3px]">
                {[0, 1, 2, 3].map((segment) => (
                  <i
                    key={segment}
                    className={`h-1 flex-1 rounded-[2px] ${
                      password.length > 0 && segment < score
                        ? STRENGTH_SEGMENT_CLASS[score]
                        : "bg-border-strong"
                    }`}
                  />
                ))}
              </span>
              <span
                id="setup-password-state"
                aria-live="polite"
                className={`text-center text-[11px] leading-none ${strengthWordClass}`}
              >
                {strengthWord}
              </span>
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="setup-confirm-password">确认密码</Label>
          <span id="setup-confirm-hint" className="sr-only">
            再次输入以确认。
          </span>
          <div className={FIELD_ROW_CLASS}>
            <Input
              id="setup-confirm-password"
              ref={confirmRef}
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={submitting}
              aria-invalid={matchState === "mismatch" || undefined}
              aria-describedby="setup-confirm-hint setup-confirm-state"
              className={`h-11 rounded-[10px] px-3.5 shadow-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/35 ${
                matchState === "mismatch" ? "border-destructive" : "border-border-strong"
              }`}
            />
            <span className="flex flex-col justify-center">
              <span
                id="setup-confirm-state"
                aria-live="polite"
                className={`text-center text-[11px] leading-none ${
                  matchState === "ok"
                    ? "text-success"
                    : matchState === "mismatch"
                      ? "text-destructive"
                      : ""
                }`}
              >
                {matchState === "ok" ? "一致" : matchState === "mismatch" ? "不一致" : ""}
              </span>
            </span>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className={FIELD_ROW_CLASS}>
          <Button
            type="submit"
            disabled={submitting}
            className="h-11 w-full rounded-[10px] text-sm shadow-none hover:bg-primary/90"
          >
            {submitting ? "正在保存…" : `保存并进入 ${brand.name}`}
          </Button>
          <span aria-hidden="true" />
        </div>
      </form>
    </AuthScreenLayout>
  );
}
