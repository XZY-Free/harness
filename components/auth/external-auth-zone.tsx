"use client";

import { apiPath } from "@/lib/api-fetch";
import type {
  ExternalAuthDisplayMode,
  ExternalAuthIcon,
  ExternalAuthMethod,
  ExternalAuthZoneConfig,
} from "@/lib/identity/authentication-provider";

/**
 * 通用外部认证区（登录页沉底槽位）。
 *
 * 呈现规则：displayMode 缺省为 auto——1 个认证方式渲染完整长按钮，
 * 2–4 个渲染等宽图标卡片，≥5 个渲染紧凑列表行；部署侧可显式覆盖。
 * 图标与文字强制成对，图标缺省时回退名称首字；本组件不携带任何品牌文案，
 * 分隔线文案、名称、图标与顺序全部来自 ExternalAuthZoneConfig。
 */

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35";

const STROKE_PROPS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function iconSvg(icon: ExternalAuthIcon, className: string) {
  switch (icon) {
    case "building":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className} {...STROKE_PROPS}>
          <path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M9 7h2M9 11h2M9 15h2M15 21v-8a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v8" />
        </svg>
      );
    case "network":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className} {...STROKE_PROPS}>
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
        </svg>
      );
    case "chat":
      return (
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className={className}
          fill="currentColor"
          stroke="none"
        >
          <path d="M9 3C5.1 3 2 5.7 2 9c0 1.9 1 3.6 2.6 4.7l-.7 2.2 2.5-1.3c.7.2 1.4.4 2.2.4h.3a6.4 6.4 0 0 1-.3-1.9c0-3.4 3.1-6.1 7-6.1h.4C15.3 4.6 12.4 3 9 3ZM6.8 6.4a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm4.6 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
          <path d="M14.9 8.4c-3.3 0-6 2.3-6 5.1s2.7 5.1 6 5.1c.7 0 1.3-.1 1.9-.3l2.1 1.1-.6-1.9c1.6-1 2.6-2.4 2.6-4 0-2.8-2.7-5.1-6-5.1Zm-2.1 2.7a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Zm4.3 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z" />
        </svg>
      );
    case "mail":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className} {...STROKE_PROPS}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7.5 9 6 9-6" />
        </svg>
      );
    case "phone":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className} {...STROKE_PROPS}>
          <rect x="7" y="2" width="10" height="20" rx="2.5" />
          <path d="M11 18h2" />
        </svg>
      );
    case "key":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className} {...STROKE_PROPS}>
          <circle cx="8" cy="15" r="4" />
          <path d="m10.8 12.2 8.2-8.2M15 5l3 3" />
        </svg>
      );
  }
}

function resolveMode(
  count: number,
  displayMode: ExternalAuthDisplayMode | undefined,
): "button" | "tiles" | "stacked" {
  if (displayMode && displayMode !== "auto") return displayMode;
  if (count <= 1) return "button";
  if (count <= 4) return "tiles";
  return "stacked";
}

function recommendedTag(onDark: boolean) {
  return (
    <span
      className={
        onDark
          ? "shrink-0 rounded-[5px] bg-primary-foreground/15 px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground"
          : "shrink-0 rounded-[5px] bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
      }
    >
      推荐
    </span>
  );
}

function buttonMethod(method: ExternalAuthMethod) {
  return (
    <a
      key={method.id}
      href={apiPath(method.href)}
      className={`flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-primary text-sm font-medium tracking-[-0.01em] text-primary-foreground transition-colors hover:bg-primary/90 ${FOCUS_RING}`}
    >
      {method.icon ? (
        iconSvg(method.icon, "h-[18px] w-[18px] shrink-0")
      ) : (
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-foreground/15 text-[11px] font-semibold"
        >
          {method.label.charAt(0)}
        </span>
      )}
      <span>{method.label}</span>
      {method.recommended ? recommendedTag(true) : null}
    </a>
  );
}

function tileMethod(method: ExternalAuthMethod) {
  return (
    <a
      key={method.id}
      href={apiPath(method.href)}
      className={`flex flex-col items-center gap-2 rounded-lg border border-border-strong bg-background px-2 pb-3.5 pt-4 transition-colors hover:border-foreground/25 hover:shadow-sm ${FOCUS_RING}`}
    >
      {method.icon ? (
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-foreground">
          {iconSvg(method.icon, "h-5 w-5")}
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-[15px] font-semibold text-foreground"
        >
          {method.label.charAt(0)}
        </span>
      )}
      <span className="text-center text-[13px] font-medium leading-tight text-foreground">
        {method.label}
        {method.recommended ? (
          <span className="ml-1 inline-block rounded-[5px] bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            推荐
          </span>
        ) : null}
      </span>
    </a>
  );
}

function rowMethod(method: ExternalAuthMethod) {
  return (
    <a
      key={method.id}
      href={apiPath(method.href)}
      className={`flex h-12 items-center gap-2.5 rounded-[10px] border border-border-strong bg-background pl-2 pr-3 transition-colors hover:bg-muted ${FOCUS_RING}`}
    >
      {method.icon ? (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground">
          {iconSvg(method.icon, "h-4 w-4")}
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-[13px] font-semibold text-foreground"
        >
          {method.label.charAt(0)}
        </span>
      )}
      <span className="flex-1 text-left text-sm font-medium text-foreground">{method.label}</span>
      {method.recommended ? recommendedTag(false) : null}
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-foreground-subtle"
        {...STROKE_PROPS}
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </a>
  );
}

export function ExternalAuthZone({ config }: { readonly config: ExternalAuthZoneConfig }) {
  const methods = config.methods;
  if (methods.length === 0) return null;
  const mode = resolveMode(methods.length, config.displayMode);
  return (
    <>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        <span className="shrink-0 text-[13px] text-muted-foreground">{config.dividerLabel}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </div>
      {mode === "button" ? (
        <div className="flex flex-col gap-2.5">{methods.map(buttonMethod)}</div>
      ) : mode === "tiles" ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(100px,1fr))] gap-3">
          {methods.map(tileMethod)}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">{methods.map(rowMethod)}</div>
      )}
    </>
  );
}
