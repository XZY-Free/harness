import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson2,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from "lucide-react";

const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "css",
  "go",
  "h",
  "html",
  "java",
  "js",
  "jsx",
  "kt",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "ts",
  "tsx",
  "vue",
]);
const TEXT_EXTENSIONS = new Set(["md", "mdx", "txt", "log", "rst"]);
const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);
const ARCHIVE_EXTENSIONS = new Set(["7z", "bz2", "gz", "rar", "tar", "tgz", "zip"]);
const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "ogg", "wav"]);
const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "webm"]);
const TABLE_EXTENSIONS = new Set(["csv", "ods", "tsv", "xls", "xlsx"]);

function iconForFile(name: string): LucideIcon {
  const extension = name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
  if (extension === "json" || extension === "jsonl") return FileJson2;
  if (CODE_EXTENSIONS.has(extension)) return FileCode2;
  if (TEXT_EXTENSIONS.has(extension)) return FileText;
  if (IMAGE_EXTENSIONS.has(extension)) return FileImage;
  if (ARCHIVE_EXTENSIONS.has(extension)) return FileArchive;
  if (AUDIO_EXTENSIONS.has(extension)) return FileAudio;
  if (VIDEO_EXTENSIONS.has(extension)) return FileVideo;
  if (TABLE_EXTENSIONS.has(extension)) return FileSpreadsheet;
  return File;
}

export function WorkspaceFileIcon({ name, className }: { name: string; className?: string }) {
  const FileIcon = iconForFile(name);
  return <FileIcon aria-hidden="true" className={className} />;
}
