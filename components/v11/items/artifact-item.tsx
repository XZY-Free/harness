/**
 * V11 Artifact Item（artifact）。
 *
 * W05 增强范围：
 * - 展示来源 Turn / Invocation / ToolCall、内容类型、保存位置、内容 hash 和可执行操作。
 * - Desktop 本地 Artifact 仅在持有文件的设备上可"打开"；Web 显示等待设备或可用的云端副本，
 *   不伪造本地访问（W05 计划行 76-77）。
 *
 * content 结构（与服务端 projectItem 投影对齐，兼容旧字段）：
 * ```
 * {
 *   artifact_id: string,
 *   display_name?: string, title?: string,                  // 员工可见文件名
 *   artifact_type?: "file"|"image"|"archive"|"report"|"dataset"|"log",
 *   media_type?: string, content_type?: string,             // MIME
 *   byte_size?: number, size?: number,                      // 字节大小
 *   content_hash?: string, hash?: string,                   // sha256:<hex>
 *   content_ref?: string, location?: string,                // 受管引用（s3:// oci:// file://internal/...）
 *   visibility_scope?: "thread"|"workspace"|"owner"|"organization",
 *   // 来源（W05）
 *   source_turn_id?: string,
 *   source_invocation_id?: string,
 *   source_tool_call_id?: string,
 *   // 可用性（W05）
 *   availability?: "local" | "cloud" | "pending_device" | "unavailable",
 *   device_id?: string,                                     // 本地文件持有设备
 *   device_status?: "online" | "offline" | "unknown",
 *   expires_at?: string                                     // ISO 8601
 * }
 * ```
 *
 * 样式：文件卡片（带图标 + 元信息 + 操作按钮）。
 */
"use client";

import type { V11ClientItem } from "@/lib/v11/client/types";
import { File, Image as ImageIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

/** 可用性取值。 */
export type V11ArtifactAvailability = "local" | "cloud" | "pending_device" | "unavailable";

/** Artifact content 投影（兼容旧字段）。 */
interface V11ArtifactContent {
  artifact_id?: string;
  display_name?: string;
  title?: string;
  artifact_type?: string;
  media_type?: string;
  content_type?: string;
  byte_size?: number;
  size?: number;
  content_hash?: string;
  hash?: string;
  content_ref?: string;
  location?: string;
  visibility_scope?: string;
  source_turn_id?: string;
  source_invocation_id?: string;
  source_tool_call_id?: string;
  availability?: V11ArtifactAvailability;
  device_id?: string;
  device_status?: "online" | "offline" | "unknown";
  expires_at?: string;
}

export interface V11ArtifactItemProps {
  readonly item: V11ClientItem;
  /**
   * 当前是否运行在 Desktop Shell 中。
   * - true：本地 Artifact（availability=local）允许"在 Desktop 打开"。
   * - false（默认）：Web 模式，本地 Artifact 显示"等待设备"，不伪造本地访问。
   */
  readonly isDesktop?: boolean;
  /** 当前 Desktop 设备 id（isDesktop=true 时使用）；用于校验本地 Artifact 是否属于当前设备。 */
  readonly currentDeviceId?: string | null;
  /** 打开/下载回调（可选）；不传时按钮渲染但仅触发 console.info。 */
  readonly onOpen?: (artifactId: string, availability: V11ArtifactAvailability) => void;
}

/** 文件类型 → Lucide 图标。 */
function getArtifactIcon(
  artifactType: string | undefined,
  mediaType: string | undefined,
): ReactNode {
  const isImage = artifactType === "image" || mediaType?.startsWith("image/") === true;
  return isImage ? (
    <ImageIcon className="size-5" aria-hidden="true" />
  ) : (
    <File className="size-5" aria-hidden="true" />
  );
}

/** 字节大小 → 人类可读字符串。 */
function formatByteSize(bytes: number | undefined): string | null {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 截断 hash 显示前 16 字符 + ...，完整 hash 通过 title 属性提供。 */
function formatHash(hash: string | undefined): string | null {
  if (!hash) return null;
  // sha256:<hex> 取前 16 位 + ...
  const stripped = hash.replace(/^sha256:/, "");
  if (stripped.length <= 16) return hash;
  return `sha256:${stripped.slice(0, 16)}…`;
}

/** 简化 content_ref 展示（去掉 scheme:// 前缀，截断中间路径）。 */
function formatLocation(ref: string | undefined): string | null {
  if (!ref) return null;
  // s3://bucket/path/to/file.xlsx → bucket/path/to/file.xlsx
  const match = ref.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/);
  const path = match ? (match[1] ?? ref) : ref;
  if (path.length <= 48) return path;
  return `${path.slice(0, 24)}…${path.slice(-20)}`;
}

/** 计算可用性。无显式 availability 时按 cloud 处理。 */
function resolveAvailability(content: V11ArtifactContent): V11ArtifactAvailability {
  if (content.availability) return content.availability;
  // 默认按云端可用处理（Web 安全默认；不伪造本地访问）
  return "cloud";
}

/** 来源链可点击项。 */
function SourceLink({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <span className="text-2xs text-muted-foreground">
      <span className="text-muted-foreground">{label}：</span>
      <code className="font-mono text-2xs text-muted-foreground">{value}</code>
    </span>
  );
}

export function V11ArtifactItem({
  item,
  isDesktop = false,
  currentDeviceId = null,
  onOpen,
}: V11ArtifactItemProps) {
  const content = item.content as V11ArtifactContent;

  const displayName = content.display_name ?? content.title ?? "未命名文件";
  const mediaType = content.media_type ?? content.content_type ?? "unknown";
  const byteSize = content.byte_size ?? content.size;
  const contentHash = content.content_hash ?? content.hash;
  const contentRef = content.content_ref ?? content.location;

  const availability = resolveAvailability(content);
  const artifactId = content.artifact_id ?? item.id;

  const sizeText = formatByteSize(byteSize);
  const hashText = formatHash(contentHash);
  const locationText = formatLocation(contentRef);

  // 是否属于当前 Desktop 设备（isDesktop=true + availability=local + device_id 匹配）
  const isLocalOnCurrentDevice =
    isDesktop &&
    availability === "local" &&
    (!content.device_id || !currentDeviceId || content.device_id === currentDeviceId);

  // 操作按钮文案 + 行为
  const action = useMemo<{ label: string; disabled: boolean; hint?: string }>(() => {
    switch (availability) {
      case "local":
        if (isDesktop) {
          if (isLocalOnCurrentDevice) {
            return { label: "在 Desktop 打开", disabled: false };
          }
          return {
            label: "等待设备",
            disabled: true,
            hint: content.device_id
              ? `文件在设备 ${content.device_id} 上，当前 Desktop 不是该设备`
              : "文件在其他 Desktop 设备上",
          };
        }
        // Web 端：本地 Artifact 不伪造访问
        return {
          label: "等待设备",
          disabled: true,
          hint: content.device_id
            ? `本地文件在 Desktop 设备 ${content.device_id} 上，请在该设备打开`
            : "本地文件需在持有该文件的 Desktop 设备上打开",
        };
      case "cloud":
        return { label: "下载", disabled: false };
      case "pending_device":
        return {
          label: "等待设备",
          disabled: true,
          hint: content.device_id
            ? `等待 Desktop 设备 ${content.device_id} 上线`
            : "等待 Desktop 设备上线",
        };
      case "unavailable":
        return { label: "暂不可用", disabled: true, hint: "Artifact 暂不可用" };
    }
  }, [availability, isDesktop, isLocalOnCurrentDevice, content.device_id]);

  const handleClick = () => {
    if (action.disabled) return;
    onOpen?.(artifactId, availability);
  };

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-[var(--radius-lg)] border border-border bg-muted px-4 py-3">
        <div className="flex items-start gap-3">
          {/* 文件图标 */}
          <div className="flex size-10 shrink-0 items-center justify-center rounded bg-[var(--primary)]/10 text-[var(--primary)]">
            {getArtifactIcon(content.artifact_type, mediaType)}
          </div>

          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm text-foreground truncate" title={displayName}>
              {displayName}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
              <span>{mediaType}</span>
              {sizeText ? <span>· {sizeText}</span> : null}
              {content.artifact_type ? <span>· {content.artifact_type}</span> : null}
              {content.visibility_scope ? (
                <span className="rounded bg-card px-1.5 py-0.5 text-3xs">
                  {content.visibility_scope}
                </span>
              ) : null}
            </div>

            {/* 来源 / hash / 位置（W05 新增） */}
            {(content.source_turn_id ||
              content.source_invocation_id ||
              content.source_tool_call_id ||
              hashText ||
              locationText) && (
              <div className="mt-1.5 flex flex-col gap-0.5">
                {content.source_turn_id ? (
                  <SourceLink label="Turn" value={content.source_turn_id} />
                ) : null}
                {content.source_invocation_id ? (
                  <SourceLink label="Invocation" value={content.source_invocation_id} />
                ) : null}
                {content.source_tool_call_id ? (
                  <SourceLink label="ToolCall" value={content.source_tool_call_id} />
                ) : null}
                {hashText ? (
                  <span className="text-2xs text-muted-foreground">
                    <span className="text-muted-foreground">hash：</span>
                    <code
                      className="font-mono text-2xs text-muted-foreground"
                      title={contentHash ?? undefined}
                    >
                      {hashText}
                    </code>
                  </span>
                ) : null}
                {locationText ? (
                  <span className="text-2xs text-muted-foreground">
                    <span className="text-muted-foreground">位置：</span>
                    <code className="font-mono text-2xs text-muted-foreground" title={contentRef}>
                      {locationText}
                    </code>
                  </span>
                ) : null}
              </div>
            )}

            {/* 可用性提示（pending_device / unavailable / Web 端 local） */}
            {action.hint ? <div className="mt-1.5 text-2xs text-warning">{action.hint}</div> : null}
          </div>

          {/* 操作按钮 */}
          <button
            type="button"
            className="shrink-0 rounded-[var(--radius-sm)] border border-border px-2.5 py-1 text-2xs text-muted-foreground transition hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            disabled={action.disabled}
            onClick={handleClick}
          >
            {action.label}
          </button>
        </div>
      </div>
    </div>
  );
}
