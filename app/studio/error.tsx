"use client";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowLeft, RefreshCw, TriangleAlert } from "lucide-react";
import Link from "next/link";

export default function StudioError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <section
      role="alert"
      aria-labelledby="studio-error-title"
      className="mx-auto flex min-h-96 w-full max-w-xl items-center justify-center py-10"
    >
      <div className="w-full rounded-2xl border border-border bg-card px-6 py-10 text-center shadow-sm sm:px-10">
        <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <TriangleAlert className="size-5" aria-hidden="true" />
        </span>
        <h1
          id="studio-error-title"
          className="mt-5 text-2xl font-semibold tracking-tight text-foreground"
        >
          页面暂时无法加载
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          当前页面遇到临时问题。你可以重新加载，或先返回后台首页继续其他工作。
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" onClick={retry}>
            <RefreshCw aria-hidden="true" />
            重新加载
          </Button>
          <Link href="/studio" className={cn(buttonVariants({ variant: "outline" }))}>
            <ArrowLeft aria-hidden="true" />
            返回后台首页
          </Link>
        </div>
      </div>
    </section>
  );
}
