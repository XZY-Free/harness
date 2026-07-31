export function StudioGatePage({ status, message }: { status: number; message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-[var(--fg-muted)]">
      <div className="text-center">
        <div className="text-[48px] font-semibold text-[var(--fg)]">{status}</div>
        <div className="mt-2 text-[14px]">{message}</div>
      </div>
    </div>
  );
}
