import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { docsConfig } from "@/lib/config";
import { type SearchOk, type SearchResult, type SearchResult_, webSearch } from "./search";
import { buildExternalSource, matchDomain } from "./source";

/**
 * searchDocs。
 *
 * 优先检索本地全文索引。配置 `SNOW_DOCS_INDEX_PATH` 后会：
 * - 接受 legacy `DocIndexEntry[]` 源文件；
 * - 或接受已编译的 `snow-docs-index` 索引文件；
 * - 自动构建/刷新 sidecar 索引（版本 + sourceDigest 管理）。
 *
 * 未配置索引时才降级为域名限定的 webSearch。两条路径都受 `SNOW_DOCS_DOMAINS`
 * fail-closed 治理保护。
 */

export type DocIndexEntry = {
 url: string;
 title: string;
 content: string;
 headings?: string[];
 updatedAt?: string;
};

type DocIndexChunk = {
 id: string;
 url: string;
 title: string;
 headings: string[];
 content: string;
 updatedAt?: string;
};

type CompiledDocIndex = {
 kind: "snow-docs-index";
 version: number;
 builtAt: string;
 sourcePath: string | null;
 sourceDigest: string;
 domains: string[];
 chunks: DocIndexChunk[];
 postings: Record<string, string[]>;
};

const DOC_INDEX_VERSION = 1 as const;
const MAX_CHUNK_LEN = 600;

export async function searchDocs(params: {
 query: string;
 threadId: string;
 fetchImpl?: typeof fetch;
 maxResults?: number;
 indexEntries?: DocIndexEntry[];
}): Promise<SearchResult_> {
 const docsDomains = docsConfig.docsDomains;
 if (docsDomains.length === 0) {
 return { ok: false, denied: true, reason: "文档域 allowlist 为空（SNOW_DOCS_DOMAINS 未配置）" };
 }

 if (params.indexEntries) {
 return searchCompiledIndex({
 query: params.query,
 docsDomains,
 index: buildCompiledIndex({
 entries: params.indexEntries,
 docsDomains,
 sourcePath: null,
 sourceDigest: "inline",
 }),
 maxResults: params.maxResults,
 });
 }

 const compiled = await loadConfiguredIndex(docsDomains);
 if (compiled) {
 return searchCompiledIndex({
 query: params.query,
 docsDomains,
 index: compiled,
 maxResults: params.maxResults,
 });
 }

 return webSearch({
 query: params.query,
 threadId: params.threadId,
 domainFilter: docsDomains,
 fetchImpl: params.fetchImpl,
 maxResults: params.maxResults,
 });
}

async function loadConfiguredIndex(docsDomains: string[]): Promise<CompiledDocIndex | null> {
 const indexPath = docsConfig.docsIndexPath;
 if (!indexPath) return null;

 const sourceRaw = await readFile(indexPath, "utf8");
 const sourceDigest = digest(sourceRaw);
 const parsed = JSON.parse(sourceRaw) as unknown;

 if (isCompiledIndex(parsed)) {
 return refreshCompiledIndexIfNeeded(indexPath, parsed, docsDomains);
 }

 const entries = parseDocEntries(parsed);
 return buildOrReuseCompiledSidecar({
 sourcePath: indexPath,
 sourceDigest,
 entries,
 docsDomains,
 });
}

async function refreshCompiledIndexIfNeeded(
 indexPath: string,
 compiled: CompiledDocIndex,
 docsDomains: string[],
): Promise<CompiledDocIndex> {
 if (compiled.version !== DOC_INDEX_VERSION) {
 if (!compiled.sourcePath) {
 throw new Error(`文档索引版本过旧，且无 sourcePath 可重建：${indexPath}`);
 }
 return rebuildFromSource(compiled.sourcePath, docsDomains);
 }
 if (!compiled.sourcePath) return compiled;

 try {
 const raw = await readFile(compiled.sourcePath, "utf8");
 const nextDigest = digest(raw);
 if (nextDigest === compiled.sourceDigest) return compiled;
 return rebuildFromSource(compiled.sourcePath, docsDomains);
 } catch {
 // sourcePath 不可读时仍允许使用已有编译索引，避免索引文件自己失效。
 return compiled;
 }
}

async function rebuildFromSource(
 sourcePath: string,
 docsDomains: string[],
): Promise<CompiledDocIndex> {
 const raw = await readFile(sourcePath, "utf8");
 const parsed = JSON.parse(raw) as unknown;
 const entries = parseDocEntries(parsed);
 return buildOrReuseCompiledSidecar({
 sourcePath,
 sourceDigest: digest(raw),
 entries,
 docsDomains,
 forceRebuild: true,
 });
}

async function buildOrReuseCompiledSidecar(params: {
 sourcePath: string;
 sourceDigest: string;
 entries: DocIndexEntry[];
 docsDomains: string[];
 forceRebuild?: boolean;
}): Promise<CompiledDocIndex> {
 const compiledPath = `${params.sourcePath}.compiled.json`;
 if (!params.forceRebuild) {
 try {
 const [compiledRaw, sourceStat, compiledStat] = await Promise.all([
 readFile(compiledPath, "utf8"),
 stat(params.sourcePath),
 stat(compiledPath),
 ]);
 const parsed = JSON.parse(compiledRaw) as unknown;
 if (
 isCompiledIndex(parsed) &&
 parsed.version === DOC_INDEX_VERSION &&
 parsed.sourceDigest === params.sourceDigest &&
 compiledStat.mtimeMs >= sourceStat.mtimeMs
 ) {
 return parsed;
 }
 } catch {
 // sidecar 缺失/损坏 → 走重建
 }
 }

 const compiled = buildCompiledIndex({
 entries: params.entries,
 docsDomains: params.docsDomains,
 sourcePath: params.sourcePath,
 sourceDigest: params.sourceDigest,
 });
 await writeFile(compiledPath, `${JSON.stringify(compiled, null, 2)}\n`, "utf8");
 return compiled;
}

function parseDocEntries(parsed: unknown): DocIndexEntry[] {
 if (Array.isArray(parsed)) {
 return parsed.map(normalizeEntry);
 }
 if (parsed && typeof parsed === "object") {
 const obj = parsed as { entries?: unknown; documents?: unknown };
 if (Array.isArray(obj.entries)) return obj.entries.map(normalizeEntry);
 if (Array.isArray(obj.documents)) return obj.documents.map(normalizeEntry);
 }
 throw new Error("SNOW_DOCS_INDEX_PATH 必须指向 DocIndexEntry[] 或 snow-docs-index 文件");
}

function normalizeEntry(value: unknown): DocIndexEntry {
 const v = value as Partial<DocIndexEntry>;
 if (!v.url || !v.title || !v.content) {
 throw new Error("DocIndexEntry 缺少 url/title/content");
 }
 return {
 url: String(v.url),
 title: String(v.title),
 content: String(v.content),
 headings: Array.isArray(v.headings) ? v.headings.map(String) : undefined,
 updatedAt: v.updatedAt ? String(v.updatedAt) : undefined,
 };
}

function isCompiledIndex(value: unknown): value is CompiledDocIndex {
 const v = value as Partial<CompiledDocIndex>;
 return (
 !!v &&
 typeof v === "object" &&
 v.kind === "snow-docs-index" &&
 typeof v.version === "number" &&
 Array.isArray(v.chunks) &&
 !!v.postings &&
 typeof v.postings === "object"
 );
}

function buildCompiledIndex(params: {
 entries: DocIndexEntry[];
 docsDomains: string[];
 sourcePath: string | null;
 sourceDigest: string;
}): CompiledDocIndex {
 const chunks = params.entries
 .filter((entry) => isAllowedDoc(entry.url, params.docsDomains))
 .flatMap((entry) => chunkEntry(entry));
 const postings = buildPostings(chunks);
 return {
 kind: "snow-docs-index",
 version: DOC_INDEX_VERSION,
 builtAt: new Date().toISOString(),
 sourcePath: params.sourcePath,
 sourceDigest: params.sourceDigest,
 domains: [...params.docsDomains],
 chunks,
 postings,
 };
}

function chunkEntry(entry: DocIndexEntry): DocIndexChunk[] {
 const paragraphs = entry.content
 .split(/\n\s*\n+/)
 .map((part) => part.replace(/\s+/g, " ").trim())
 .filter((part) => part.length > 0);
 const slices = paragraphs.length > 0 ? paragraphs : [entry.content.replace(/\s+/g, " ").trim()];

 const chunks: DocIndexChunk[] = [];
 let buffer = "";
 let chunkIndex = 0;
 const flush = () => {
 const content = buffer.trim();
 if (!content) return;
 chunks.push({
 id: `${entry.url}#${chunkIndex++}`,
 url: entry.url,
 title: entry.title,
 headings: entry.headings ?? [],
 content,
 updatedAt: entry.updatedAt,
 });
 buffer = "";
 };

 for (const part of slices) {
 if (!part) continue;
 if (`${buffer} ${part}`.trim().length > MAX_CHUNK_LEN) {
 flush();
 }
 if (part.length <= MAX_CHUNK_LEN) {
 buffer = `${buffer} ${part}`.trim();
 continue;
 }
 const sentences = part.match(/[^.!?。！？]+[.!?。！？]?/g) ?? [part];
 for (const sentence of sentences.map((s) => s.trim()).filter(Boolean)) {
 if (`${buffer} ${sentence}`.trim().length > MAX_CHUNK_LEN) {
 flush();
 }
 if (sentence.length > MAX_CHUNK_LEN) {
 for (let i = 0; i < sentence.length; i += MAX_CHUNK_LEN) {
 buffer = sentence.slice(i, i + MAX_CHUNK_LEN);
 flush();
 }
 continue;
 }
 buffer = `${buffer} ${sentence}`.trim();
 }
 }
 flush();
 return chunks;
}

function buildPostings(chunks: DocIndexChunk[]): Record<string, string[]> {
 const postings = new Map<string, Set<string>>();
 for (const chunk of chunks) {
 const terms = tokenize([chunk.title, chunk.headings.join(" "), chunk.content].join(" "));
 for (const term of terms) {
 const bucket = postings.get(term) ?? new Set<string>();
 bucket.add(chunk.id);
 postings.set(term, bucket);
 }
 }
 return Object.fromEntries([...postings.entries()].map(([term, ids]) => [term, [...ids]]));
}

function searchCompiledIndex(params: {
 query: string;
 docsDomains: string[];
 index: CompiledDocIndex;
 maxResults?: number;
}): SearchOk {
 const terms = tokenize(params.query);
 const max = params.maxResults ?? 8;
 const chunkById = new Map(params.index.chunks.map((chunk) => [chunk.id, chunk]));
 const candidateIds = new Set<string>();
 for (const term of terms) {
 for (const id of params.index.postings[term] ?? []) {
 candidateIds.add(id);
 }
 }

 // 真 BM25 评分——IDF 加权 + tf 饱和(k1) + 文档长度归一化(b)。
 // 全索引统计：N=chunk 总数，avgdl=平均 content 长度，df(t)=含 term t 的 chunk 数。
 const allChunks = params.index.chunks;
 const N = Math.max(allChunks.length, 1);
 const avgdl =
 allChunks.length > 0
 ? allChunks.reduce((sum, c) => sum + c.content.length, 0) / allChunks.length
 : 1;
 // 预计算每个 chunk 的 content 长度(dl)，避免 scoreChunk 内重复取。
 const dlByChunkId = new Map<string, number>(allChunks.map((c) => [c.id, c.content.length]));
 const idf = new Map<string, number>();
 for (const term of terms) {
 let dfCount = 0;
 for (const c of allChunks) {
 if (
 c.title.toLowerCase().includes(term) ||
 c.headings.join(" ").toLowerCase().includes(term) ||
 c.content.toLowerCase().includes(term)
 ) {
 dfCount++;
 }
 }
 // BM25 IDF：log((N - df + 0.5) / (df + 0.5) + 1)。
 // +1 平滑地板保证非负（常见词 df→N 时 IDF→0 但不为负，不丢结果；罕见词权重高）。
 idf.set(term, Math.log((N - dfCount + 0.5) / (dfCount + 0.5) + 1));
 }

 const ranked = [...candidateIds]
 .map((id) => chunkById.get(id))
 .filter((chunk): chunk is DocIndexChunk => !!chunk)
 .map((chunk) => ({
 chunk,
 score: scoreChunk(
 chunk,
 terms,
 idf,
 avgdl,
 dlByChunkId.get(chunk.id) ?? chunk.content.length,
 ),
 }))
 .filter((item) => item.score > 0)
 .sort((a, b) => b.score - a.score || a.chunk.url.localeCompare(b.chunk.url));

 const bestByUrl = new Map<string, { chunk: DocIndexChunk; score: number }>();
 for (const item of ranked) {
 if (!bestByUrl.has(item.chunk.url)) {
 bestByUrl.set(item.chunk.url, item);
 }
 }

 const results: SearchResult[] = [...bestByUrl.values()].slice(0, max).map(({ chunk }) => ({
 title: chunk.title,
 url: chunk.url,
 snippet: buildSnippet(chunk, terms),
 }));

 const source = buildExternalSource({
 sourceUrl: `docs-index://${params.index.sourceDigest}?v=${params.index.version}`,
 content: JSON.stringify({
 builtAt: params.index.builtAt,
 sourcePath: params.index.sourcePath,
 sourceDigest: params.index.sourceDigest,
 domains: params.index.domains,
 hits: [...bestByUrl.values()].slice(0, max).map(({ chunk, score }) => ({
 url: chunk.url,
 title: chunk.title,
 score,
 updatedAt: chunk.updatedAt ?? null,
 })),
 }),
 });

 return { ok: true, query: params.query, results, source };
}

function isAllowedDoc(url: string, docsDomains: string[]): boolean {
 try {
 const host = new URL(url).hostname;
 return docsDomains.some((domain) => matchDomain(host, domain));
 } catch {
 return false;
 }
}

function tokenize(value: string): string[] {
 const tokens = value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
 return [...new Set(tokens.filter((token) => token.length > 1))];
}

/**
 * 真 BM25 评分。
 *
 * 对 content 的 term 频率用 BM25 tfNorm 饱和归一化：
 * tfNorm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))
 * 其中 tf=term 在 content 出现次数，dl=本 chunk content 长度，avgdl=全索引平均 content 长度，
 * k1=词频饱和参数（默认 1.2，越大越允许高频词继续加分），b=文档长度归一化强度（默认 0.75，
 * 0=不归一化，1=完全按长度惩罚长文档）。
 *
 * title/headings 命中作为 field weight 额外加分（8x/4x boost，BM25F 简化）——标题/小标题命中
 * 信号强于正文命中，保留原加权语义。idf 用 BM25 公式：log((N - df + 0.5) / (df + 0.5) + 1)。
 *
 * @param idf term → BM25 IDF 值（由调用方预计算）
 * @param avgdl 全索引平均 content 长度
 * @param dl 本 chunk content 长度
 * @param k1 词频饱和参数（默认 1.2）
 * @param b 文档长度归一化强度（默认 0.75）
 */
function scoreChunk(
 chunk: DocIndexChunk,
 terms: string[],
 idf?: Map<string, number>,
 avgdl = 1,
 dl: number = chunk.content.length,
 k1 = 1.2,
 b = 0.75,
): number {
 if (terms.length === 0) return 0;
 const title = chunk.title.toLowerCase();
 const headings = chunk.headings.join(" ").toLowerCase();
 const content = chunk.content.toLowerCase();
 let score = 0;
 for (const term of terms) {
 const idfWeight = idf?.get(term) ?? 1;
 // title/headings 命中：field weight boost（BM25F 简化，不经 tfNorm）
 if (title.includes(term)) score += 8 * idfWeight;
 if (headings.includes(term)) score += 4 * idfWeight;
 // content 命中：BM25 tfNorm 归一化（tf 饱和 + 文档长度归一化）
 const tf = countOccurrences(content, term);
 if (tf > 0) {
 const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / (avgdl || 1)));
 score += idfWeight * tfNorm;
 }
 }
 return score;
}

function countOccurrences(value: string, needle: string): number {
 let count = 0;
 let idx = value.indexOf(needle);
 while (idx !== -1) {
 count += 1;
 idx = value.indexOf(needle, idx + needle.length);
 }
 return count;
}

function buildSnippet(chunk: DocIndexChunk, terms: string[]): string {
 const content = chunk.content.replace(/\s+/g, " ").trim();
 if (content.length <= 220) return content;
 const lower = content.toLowerCase();
 const firstHit = terms
 .map((term) => lower.indexOf(term))
 .filter((idx) => idx >= 0)
 .sort((a, b) => a - b)[0];
 const center = firstHit ?? 0;
 const start = Math.max(0, center - 80);
 const end = Math.min(content.length, start + 220);
 const prefix = start > 0 ? "..." : "";
 const suffix = end < content.length ? "..." : "";
 return `${prefix}${content.slice(start, end)}${suffix}`;
}

function digest(content: string): string {
 return createHash("sha256").update(content).digest("hex");
}
