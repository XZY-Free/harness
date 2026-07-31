/**
 * 最小 ZIP 读取器（02 文档 §5.3 artifact 导入）。
 *
 * 不引入 adm-zip 等额外依赖,用 Node 内置 zlib 解 DEFLATE。仅读取、不解压到磁盘,
 * 由调用方（artifact-import）按校验后写入目标目录。
 *
 * 安全限制（对齐 capability-market skill-package-reader）：
 * - 最多 200 个条目
 * - 解压后总大小 ≤ 20MB
 * - 单条目解压后 ≤ 5MB
 * - 压缩比 ≤ 100（防 zip bomb）
 * - 拒绝绝对路径、`..` 段、盘符前缀、反斜杠（强制正斜杠）
 *
 * 仅支持常见情况：DEFLATE（method 8）与 STORE（method 0）。加密条目直接拒绝。
 */

import { inflateRawSync } from "node:zlib";

const MAX_ENTRIES = 200;
const MAX_TOTAL_SIZE = 20 * 1024 * 1024;
const MAX_ENTRY_SIZE = 5 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

/** 解析后的 zip 条目（解压后内容 + 规整后的相对路径）。 */
export interface ZipEntry {
  /** 规整后路径：正斜杠、无前导 /、无 .. 段。 */
  path: string;
  /** 解压后内容。 */
  content: Buffer;
  isDirectory: boolean;
}

export class ZipReadError extends Error {}

/**
 * 从 zip buffer 读取全部条目。若所有条目共享一个顶层目录,剥掉该前缀
 * （对齐 capability-market 规整逻辑,确保 SKILL.md 位于包根）。
 */
export function readZipEntries(zip: Buffer): ZipEntry[] {
  if (zip.length < 22) throw new ZipReadError("zip 数据过短");

  // 定位 End of Central Directory 记录（从尾部向前扫描）
  const eocdOffset = findEocd(zip);
  if (eocdOffset < 0) throw new ZipReadError("未找到 EOCD 记录");
  const cdCount = zip.readUInt16LE(eocdOffset + 10);
  const cdOffset = zip.readUInt32LE(eocdOffset + 16);
  if (cdCount > MAX_ENTRIES) {
    throw new ZipReadError(`ZIP 条目数 ${cdCount} 超过上限 ${MAX_ENTRIES}`);
  }

  const rawEntries: ZipEntry[] = [];
  let offset = cdOffset;
  let totalSize = 0;
  for (let i = 0; i < cdCount; i++) {
    if (offset + 46 > zip.length) throw new ZipReadError("中央目录条目越界");
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new ZipReadError("中央目录签名非法");

    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);

    const nameRaw = zip.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;

    const isDirectory = nameRaw.endsWith("/");
    const cleanedPath = cleanEntryPath(nameRaw);

    // 跳过目录条目（写入时由 mkdir 创建）
    if (isDirectory) continue;

    // 读取本地文件头拿到真实 compressedSize（有些 zip 中央目录字段为 0,以本地头为准）
    const entry = readLocalEntry(zip, localHeaderOffset, method, cleanedPath);
    if (entry.content.length > MAX_ENTRY_SIZE) {
      throw new ZipReadError(`条目 ${cleanedPath} 解压后超过 ${MAX_ENTRY_SIZE} 字节`);
    }
    if (compressedSize > 0 && entry.content.length / compressedSize > MAX_COMPRESSION_RATIO) {
      throw new ZipReadError(`条目 ${cleanedPath} 压缩比超限,疑似 zip bomb`);
    }
    totalSize += entry.content.length;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new ZipReadError(`解压后总大小超过 ${MAX_TOTAL_SIZE} 字节`);
    }
    rawEntries.push(entry);
  }

  return stripCommonTopDir(rawEntries);
}

/** 定位 EOCD,从尾部向前扫描最多 64KB。 */
function findEocd(zip: Buffer): number {
  const minScan = Math.max(0, zip.length - 65536);
  for (let i = zip.length - 22; i >= minScan; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** 清理条目路径：拒绝对路径 / .. / 盘符 / 反斜杠。 */
function cleanEntryPath(name: string): string {
  if (name.includes("\\")) throw new ZipReadError(`条目路径含反斜杠：${name}`);
  if (/^[a-zA-Z]:/.test(name)) throw new ZipReadError(`条目路径含盘符：${name}`);
  if (name.startsWith("/")) throw new ZipReadError(`条目路径为绝对路径：${name}`);
  const parts = name.split("/");
  for (const p of parts) {
    if (p === "..") throw new ZipReadError(`条目路径含 .. 越界：${name}`);
  }
  return parts.filter(Boolean).join("/");
}

/** 读取本地文件头并解压条目内容。 */
function readLocalEntry(zip: Buffer, localOffset: number, method: number, path: string): ZipEntry {
  if (localOffset + 30 > zip.length) throw new ZipReadError(`本地头越界：${path}`);
  if (zip.readUInt32LE(localOffset) !== 0x04034b50)
    throw new ZipReadError(`本地头签名非法：${path}`);
  const nameLen = zip.readUInt16LE(localOffset + 26);
  const extraLen = zip.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + nameLen + extraLen;

  // 通用标志位 bit 0 = 加密
  const flags = zip.readUInt16LE(localOffset + 6);
  if (flags & 0x1) throw new ZipReadError(`条目 ${path} 已加密,不支持`);

  // compressedSize 从本地头读取（bit 3 置位时为 0,需从数据流推断；此处取中央目录已校验）
  const compressedSize = zip.readUInt32LE(localOffset + 18);
  const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);

  let content: Buffer;
  if (method === 0) {
    content = compressed;
  } else if (method === 8) {
    content = inflateRawSync(compressed);
  } else {
    throw new ZipReadError(`条目 ${path} 使用不支持的压缩方法 ${method}`);
  }
  return { path, content, isDirectory: false };
}

/**
 * 若所有条目共享一个顶层目录,剥掉该前缀。
 * 例：["my-skill/SKILL.md","my-skill/references/a.md"] → ["SKILL.md","references/a.md"]
 */
function stripCommonTopDir(entries: ZipEntry[]): ZipEntry[] {
  if (entries.length === 0) return entries;
  const firstTop = entries[0]!.path.split("/")[0];
  if (!firstTop) return entries;
  const allShare = entries.every((e) => e.path.startsWith(`${firstTop}/`));
  if (!allShare) return entries;
  return entries.map((e) => ({ ...e, path: e.path.slice(firstTop.length + 1) }));
}
