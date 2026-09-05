/**
 * Host Action Item（host_action）。
 *
 * 只消费服务端规范化 DTO；历史回放只展示，不自动导航或打开外链。
 */
"use client";

import { Button, buttonVariants } from "@/components/ui/button";
import type { ClientItem } from "@/lib/client/types";
import { cn } from "@/lib/utils";

interface HostActionContent {
  kind?: "host_action";
  action_id?: string;
  action_type?: "navigate" | "open_external_link" | "offer_human_support";
  title?: string;
  label?: string;
  description?: string | null;
  target_key?: string | null;
  url?: string | null;
  web_path?: string | null;
  client_support?: { web?: boolean; desktop?: boolean };
}

export function HostActionItem({ item }: { readonly item: ClientItem }) {
  const content = (item.content ?? {}) as HostActionContent;
  const title = content.title ?? "宿主操作";
  const label = content.label ?? "查看";
  const description = content.description;

  return (
    <section
      aria-label={title}
      data-testid="host-action-item"
      data-host-action-type={content.action_type ?? "unknown"}
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <div className="font-medium text-foreground text-sm">{title}</div>
      {description ? <p className="mt-1 text-muted-foreground text-sm">{description}</p> : null}
      <div className="mt-3">
        {content.action_type === "navigate" && content.web_path ? (
          <Button
            type="button"
            data-host-action-id={content.action_id}
            aria-label={label}
            onClick={() => window.location.assign(content.web_path as string)}
          >
            {label}
          </Button>
        ) : null}
        {content.action_type === "open_external_link" && content.url ? (
          <a
            className={cn(buttonVariants())}
            data-host-action-id={content.action_id}
            aria-label={label}
            href={content.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {label}
          </a>
        ) : null}
        {content.action_type === "offer_human_support" ? (
          <>
            <p className="text-muted-foreground text-xs">当前未配置人工入口</p>
            <Button
              type="button"
              disabled
              data-host-action-id={content.action_id}
              aria-label="当前未配置人工入口"
            >
              当前未配置
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}
