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
            模型或执行服务未能完成请求。可以调整模型后重新发送，不会覆盖已有消息。
          </p>
        </div>
      </div>
    </div>
  );
}
