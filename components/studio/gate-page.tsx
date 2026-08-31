import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import Link from "next/link";

export function StudioGatePage({
  status,
  message,
  fullScreen = false,
}: {
  status: number;
  message: string;
  fullScreen?: boolean;
}) {
  return (
    <section
      aria-labelledby="studio-gate-title"
      className={cn(
        "mx-auto flex max-w-xl items-center justify-center px-6 text-muted-foreground",
        fullScreen ? "min-h-dvh" : "min-h-[28rem]",
      )}
    >
      <div className="w-full rounded-2xl border border-border bg-card px-8 py-10 text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <LockKeyhole className="size-4" aria-hidden="true" />
        </span>
        <h1
          id="studio-gate-title"
          className="mt-4 text-2xl font-semibold tracking-tight text-foreground"
        >
          {status} · 无法访问
        </h1>
        <p className="mt-2 text-sm">{message}</p>
        <Link href="/chat" className={cn(buttonVariants({ variant: "outline" }), "mt-6")}>
          <ArrowLeft aria-hidden="true" />
          返回使用端
        </Link>
      </div>
    </section>
  );
}
