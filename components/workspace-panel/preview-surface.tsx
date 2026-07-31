"use client";

/**
 * V10 Phase 1：Web iframe Preview Surface。
 *
 * 取代 V9 BrowserPanel 的 Web 端预览组件。不依赖服务器远程浏览器、WebRTC、CDP Screencast。
 * 直接在 iframe 中加载 /preview/{threadId}/... 反向代理路由（owner guard + token + CSP）。
 *
 * 工具栏（规范 04-web-preview-and-cleanup.md §1.1）：
 * - 后退 / 前进：同源 /preview 路由可用 iframe.contentWindow.history.back/forward
 * - 刷新：重新挂载 iframe（递增 localReloadKey）
 * - 重启 AppRuntime：POST /api/threads/{id}/runtime/restart
 * - 项目 URL（只读）
 * - 设备尺寸：响应式 / 桌面(1280) / 平板(768) / 手机(375)
 * - 新窗口打开
 *
 * 状态：idle / starting / ready / restarting / error
 *
 * 安全：
 * - iframe sandbox 仅开启 allow-scripts allow-same-origin allow-forms allow-popups
 * - 不包含 allow-top-navigation（防导航劫持）
 * - 不请求 /browser/session/start 或 /browser/session/offer
 */
import { Icon } from "@/components/icons";
import { apiFetch, apiPath } from "@/lib/api-fetch";
import { useCallback, useRef, useState } from "react";

type DeviceSize = "responsive" | "desktop" | "tablet" | "mobile";

type SurfaceState = "idle" | "ready" | "restarting" | "error";

const DEVICE_WIDTHS: Record<DeviceSize, string | null> = {
  responsive: null,
  desktop: "max-w-[1280px]",
  tablet: "max-w-[768px]",
  mobile: "max-w-[375px]",
};

export function PreviewSurface({
  threadId,
  previewUrl,
  reloadKey,
}: {
  threadId: string;
  previewUrl: string | null;
  reloadKey: number;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // basePath 部署（/snowharness）下，服务端下发的 /preview 裸路径需补前缀（apiPath 幂等，已带前缀则原样返回）
  const resolvedPreviewUrl = previewUrl ? apiPath(previewUrl) : null;
  const [localReloadKey, setLocalReloadKey] = useState(0);
  const [deviceSize, setDeviceSize] = useState<DeviceSize>("responsive");
  const [state, setState] = useState<SurfaceState>(resolvedPreviewUrl ? "ready" : "idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 后退：同源 /preview 路由可用 iframe history
  const handleBack = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.history.back();
    } catch {
      // 跨源无法访问 contentWindow，忽略
    }
  }, []);

  const handleForward = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.history.forward();
    } catch {
      // 跨源无法访问 contentWindow，忽略
    }
  }, []);

  // 刷新：递增 localReloadKey 重新挂载 iframe
  const handleRefresh = useCallback(() => {
    setLocalReloadKey((k) => k + 1);
  }, []);

  // 重启 AppRuntime
  const handleRestart = useCallback(async () => {
    setState("restarting");
    setErrorMsg(null);
    try {
      const resp = await apiFetch(`/api/threads/${threadId}/runtime/restart`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (!resp.ok) {
        const json = await resp.json().catch(() => ({}));
        const msg = json?.error?.message ?? "重启失败";
        setErrorMsg(msg);
        setState("error");
        return;
      }
      // 重启成功：刷新 iframe
      setLocalReloadKey((k) => k + 1);
      setState("ready");
    } catch {
      setErrorMsg("网络错误，重启失败");
      setState("error");
    }
  }, [threadId]);

  // 新窗口打开
  const handleOpenNewWindow = useCallback(() => {
    if (resolvedPreviewUrl) {
      window.open(resolvedPreviewUrl, "_blank", "noopener");
    }
  }, [resolvedPreviewUrl]);

  // idle：无 previewUrl
  if (!resolvedPreviewUrl) {
    return (
      <div className="flex h-full flex-col bg-[var(--surface-2)]">
        <PreviewToolbar
          previewUrl={null}
          deviceSize={deviceSize}
          onDeviceSizeChange={setDeviceSize}
          onBack={handleBack}
          onForward={handleForward}
          onRefresh={handleRefresh}
          onRestart={handleRestart}
          onOpenNewWindow={handleOpenNewWindow}
          disabled
        />
        <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--fg-muted)]">
          项目尚未启动
        </div>
      </div>
    );
  }

  const widthClass = DEVICE_WIDTHS[deviceSize];

  return (
    <div className="flex h-full flex-col bg-[var(--surface-2)]">
      <PreviewToolbar
        previewUrl={resolvedPreviewUrl}
        deviceSize={deviceSize}
        onDeviceSizeChange={setDeviceSize}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onRestart={handleRestart}
        onOpenNewWindow={handleOpenNewWindow}
        disabled={state === "restarting"}
      />

      {/* 状态指示条 */}
      {state === "restarting" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[11px] text-[var(--primary)]">
          <Icon.spinner size={12} className="animate-spin" />
          重启中
        </div>
      )}
      {state === "error" && errorMsg && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[11px] text-[var(--danger)]">
          <Icon.alert size={12} />
          {errorMsg}
          <button
            type="button"
            onClick={() => setState("ready")}
            className="ml-auto text-[var(--fg-muted)] hover:text-[var(--fg)]"
            aria-label="关闭错误"
          >
            <Icon.close size={12} />
          </button>
        </div>
      )}

      {/* iframe 容器：设备尺寸通过 max-width 约束 */}
      <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-[var(--surface-2)]">
        <div
          data-testid="preview-iframe-container"
          className={`h-full w-full ${widthClass ?? ""} bg-white`}
        >
          <iframe
            ref={iframeRef}
            key={`${reloadKey}:${localReloadKey}`}
            src={resolvedPreviewUrl}
            title="项目预览"
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      </div>
    </div>
  );
}

function PreviewToolbar({
  previewUrl,
  deviceSize,
  onDeviceSizeChange,
  onBack,
  onForward,
  onRefresh,
  onRestart,
  onOpenNewWindow,
  disabled,
}: {
  previewUrl: string | null;
  deviceSize: DeviceSize;
  onDeviceSizeChange: (size: DeviceSize) => void;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onRestart: () => void;
  onOpenNewWindow: () => void;
  disabled: boolean;
}) {
  return (
    <header className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
      {/* 导航按钮 */}
      <ToolbarButton
        onClick={onBack}
        disabled={disabled}
        label="后退"
        icon={<Icon.chevron size={14} className="rotate-90" />}
      />
      <ToolbarButton
        onClick={onForward}
        disabled={disabled}
        label="前进"
        icon={<Icon.chevron size={14} className="-rotate-90" />}
      />
      <ToolbarButton
        onClick={onRefresh}
        disabled={disabled}
        label="刷新"
        icon={<Icon.refresh size={14} />}
      />
      <ToolbarButton
        onClick={onRestart}
        disabled={disabled}
        label="重启 AppRuntime"
        icon={<Icon.stop size={13} />}
      />

      {/* 项目 URL（只读） */}
      <input
        type="text"
        value={previewUrl ?? ""}
        readOnly
        placeholder="未启动"
        className="mx-1 min-w-0 flex-1 rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-2 py-1 font-mono text-[11px] text-[var(--fg-muted)] outline-none"
      />

      {/* 设备尺寸 */}
      <div className="flex shrink-0 items-center gap-0.5">
        <DeviceSizeButton
          active={deviceSize === "responsive"}
          onClick={() => onDeviceSizeChange("responsive")}
          label="响应式"
        />
        <DeviceSizeButton
          active={deviceSize === "desktop"}
          onClick={() => onDeviceSizeChange("desktop")}
          label="桌面"
        />
        <DeviceSizeButton
          active={deviceSize === "tablet"}
          onClick={() => onDeviceSizeChange("tablet")}
          label="平板"
        />
        <DeviceSizeButton
          active={deviceSize === "mobile"}
          onClick={() => onDeviceSizeChange("mobile")}
          label="手机"
        />
      </div>

      {/* 新窗口 */}
      <ToolbarButton
        onClick={onOpenNewWindow}
        disabled={disabled || !previewUrl}
        label="新窗口打开"
        icon={<Icon.external size={14} />}
      />
    </header>
  );
}

function ToolbarButton({
  onClick,
  disabled,
  label,
  icon,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {icon}
    </button>
  );
}

function DeviceSizeButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`rounded-[var(--radius-sm)] px-2 py-1 text-[10px] font-medium transition ${
        active
          ? "bg-[var(--surface-2)] text-[var(--fg)]"
          : "text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
      }`}
    >
      {label}
    </button>
  );
}
