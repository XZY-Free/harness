export function TurnFailureNotice({
  turnState,
  errorCode,
}: {
  readonly turnState: string | null | undefined;
  readonly errorCode: string | null | undefined;
}) {
  if (turnState !== "failed") return null;

  return (
    <div className="shrink-0 bg-background pt-2">
      <div className="composer-track">
        <div
          role="alert"
          data-error-code={errorCode ?? undefined}
          className="rounded-xl border border-destructive/20 bg-destructive/[0.035] px-4 py-3"
        >
          <p className="font-medium text-[13px] text-foreground">本次回复失败</p>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {errorCode === "AGENT_CONTEXT_REQUIREMENT_UNSATISFIED"
              ? "当前身份或资料不满足助手的使用要求。请重新登录后再试；若仍失败，请联系管理员检查资料来源与助手配置。已有消息已保留。"
              : "本次请求未能完成。请查看上方失败原因，处理后重新发送；已有消息已保留。"}
          </p>
        </div>
      </div>
    </div>
  );
}
