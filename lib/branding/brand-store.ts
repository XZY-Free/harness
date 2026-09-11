import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { resolve } from "node:path";
/**
 * BrandStore：品牌配置的运行时主存储与事件源。
 *
 * 分层解析（低→高）：代码默认 → DB 单行文档 → branding.json overlay → SNOW_BRAND_* env overlay。
 * file/env 为部署期 pin 层：被 pin 字段拒绝 update()（BrandFieldPinnedError），管理界面只读展示。
 * revision 单调递增（DB 列），etag = revision:fileGen，是热更新与缓存校验的唯一依据。
 *
 * 事件语义（Desktop Control Plane 定案）：本 store 只发布「失效信号」，不推送状态全文；
 * 消费者（Web SSE / Desktop 桥 / 进程内）收到信号后以 ETag 拉取权威文档。
 * 跨进程一致性靠 pollMs 周期比对 revision 与文件 mtime（默认 30s，品牌极少变更，稳态零成本）。
 *
 * 零全局副作用：createBrandStore 显式注入依赖；getBrandStore() 单例供服务端消费端使用。
 */
import type { BrandContract, BrandPatch } from "@/lib/branding/brand-contract";
import {
  BrandFieldPinnedError,
  DEFAULT_BRAND,
  applyBrandPatch,
  parseBrandPatch,
} from "@/lib/branding/brand-contract";
import {
  type BrandRow,
  type BrandWriteInput,
  fetchBrandRow,
  writeBrandRow,
} from "@/lib/branding/brand-queries";
import { logger } from "@/lib/logger";

export interface BrandSnapshot {
  readonly contract: BrandContract;
  /** 被 pin 字段 → pin 来源；管理端据此只读并解释拒绝原因。 */
  readonly pinned: Readonly<Record<string, "file" | "env">>;
  readonly etag: string;
}

export interface BrandStore {
  get(): Promise<BrandSnapshot>;
  subscribe(listener: (snapshot: BrandSnapshot) => void): () => void;
  update(patch: BrandPatch, actor: string | null): Promise<BrandSnapshot>;
}

export interface BrandStoreDeps {
  fetchRow?: () => Promise<BrandRow | null>;
  writeRow?: (input: BrandWriteInput) => Promise<void>;
  env?: Record<string, string | undefined>;
  /** null 表示禁用文件层（测试/纯 DB 部署）。 */
  filePath?: string | null;
  now?: () => Date;
  pollMs?: number;
  startPoll?: boolean;
}

const PATCHABLE_KEYS = ["name", "tagline", "icon", "logo", "packaging"] as const;

function envOverlay(env: Record<string, string | undefined>): {
  patch: BrandPatch;
  fields: string[];
} {
  const patch: Record<string, unknown> = {};
  const fields: string[] = [];
  const name = env.SNOW_BRAND_NAME?.trim();
  if (name) {
    patch.name = name;
    fields.push("name");
  }
  if (env.SNOW_BRAND_TAGLINE !== undefined) {
    patch.tagline = env.SNOW_BRAND_TAGLINE.trim() || null;
    fields.push("tagline");
  }
  const icon = env.SNOW_BRAND_ICON?.trim();
  if (icon) {
    patch.icon = icon;
    fields.push("icon");
  }
  const logoLight = env.SNOW_BRAND_LOGO_LIGHT?.trim();
  const logoDark = env.SNOW_BRAND_LOGO_DARK?.trim();
  if (logoLight || logoDark) {
    patch.logo = { light: logoLight || null, dark: logoDark || null };
    fields.push("logo");
  }
  return { patch: patch as BrandPatch, fields };
}

class BrandStoreImpl implements BrandStore {
  private cache: BrandSnapshot | null = null;
  private loading: Promise<BrandSnapshot> | null = null;
  private listeners = new Set<(snapshot: BrandSnapshot) => void>();
  private fileOverlay: BrandPatch = {};
  private fileFields: string[] = [];
  private fileGen = 0;
  private fileMtimeMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly fetchRow: () => Promise<BrandRow | null>;
  private readonly writeRow: (input: BrandWriteInput) => Promise<void>;
  private readonly env: Record<string, string | undefined>;
  private readonly filePath: string | null;
  private readonly now: () => Date;

  constructor(deps: Required<Pick<BrandStoreDeps, never>> & BrandStoreDeps) {
    this.fetchRow = deps.fetchRow ?? (() => fetchBrandRow());
    this.writeRow = deps.writeRow ?? ((input) => writeBrandRow(input));
    this.env = deps.env ?? process.env;
    this.filePath =
      deps.filePath === undefined ? resolve(process.cwd(), "branding.json") : deps.filePath;
    this.now = deps.now ?? (() => new Date());
    this.loadFileOverlay();
    if (this.filePath) this.startWatch();
    if (deps.startPoll) this.startPoll(deps.pollMs ?? 30_000);
  }

  async get(): Promise<BrandSnapshot> {
    if (this.cache) return this.cache;
    if (!this.loading) {
      this.loading = this.refresh().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  subscribe(listener: (snapshot: BrandSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async update(patch: BrandPatch, actor: string | null): Promise<BrandSnapshot> {
    const snapshot = await this.get();
    for (const key of PATCHABLE_KEYS) {
      if (patch[key as keyof BrandPatch] !== undefined) {
        const pinnedBy = snapshot.pinned[key];
        if (pinnedBy) throw new BrandFieldPinnedError(key, pinnedBy);
      }
    }
    const row = await this.fetchRow();
    const base = row
      ? applyBrandPatch(DEFAULT_BRAND, parseBrandPatch(row.document))
      : DEFAULT_BRAND;
    const next = applyBrandPatch(base, patch);
    const revisionBefore = row?.revision ?? 0;
    const document: Record<string, unknown> = {
      schemaVersion: 1,
      name: next.name,
      tagline: next.tagline,
      logo: next.logo,
      icon: next.icon,
      packaging: next.packaging,
    };
    await this.writeRow({
      document,
      revision: revisionBefore + 1,
      revisionBefore,
      patch: patch as Record<string, unknown>,
      actor,
      now: this.now(),
    });
    const fresh = await this.refresh();
    this.emit(fresh);
    return fresh;
  }

  private emit(snapshot: BrandSnapshot): void {
    for (const listener of this.listeners) listener(snapshot);
  }

  private async refresh(): Promise<BrandSnapshot> {
    const row = await this.fetchRow();
    this.cache = this.compose(row);
    return this.cache;
  }

  private compose(row: BrandRow | null): BrandSnapshot {
    const dbLayer = row
      ? applyBrandPatch(DEFAULT_BRAND, parseBrandPatch(row.document))
      : DEFAULT_BRAND;
    const withFile = applyBrandPatch(dbLayer, this.fileOverlay);
    const env = envOverlay(this.env);
    const effective = applyBrandPatch(withFile, env.patch);
    const pinned: Record<string, "file" | "env"> = {};
    for (const field of this.fileFields) pinned[field] = "file";
    for (const field of env.fields) pinned[field] = "env";
    const contract: BrandContract = {
      ...effective,
      revision: row?.revision ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
    return { contract, pinned, etag: `"${contract.revision}:${this.fileGen}"` };
  }

  private loadFileOverlay(): void {
    if (!this.filePath || !existsSync(this.filePath)) {
      this.fileOverlay = {};
      this.fileFields = [];
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = parseBrandPatch(JSON.parse(raw) as Record<string, unknown>);
      this.fileOverlay = parsed;
      this.fileFields = Object.keys(parsed).filter((key) =>
        (PATCHABLE_KEYS as readonly string[]).includes(key),
      );
      this.fileMtimeMs = statSync(this.filePath).mtimeMs;
    } catch (error) {
      logger.warn("branding.json 解析失败，沿用上一良好 overlay", {
        path: this.filePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private watching = false;

  private startWatch(): void {
    const path = this.filePath as string;
    // 文件缺省不存在（零配置部署）：不 watch，等轮询发现文件出现后再挂。
    if (this.watching || !existsSync(path)) return;
    this.watching = true;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    watch(path, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        this.loadFileOverlay();
        this.fileGen += 1;
        void this.refresh().then((snapshot) => this.emit(snapshot));
      }, 300);
    });
  }

  private startPoll(pollMs: number): void {
    this.timer = setInterval(() => {
      void (async () => {
        try {
          const row = await this.fetchRow();
          let fileChanged = false;
          if (this.filePath && existsSync(this.filePath)) {
            const mtime = statSync(this.filePath).mtimeMs;
            if (mtime !== this.fileMtimeMs) {
              this.loadFileOverlay();
              this.fileGen += 1;
              fileChanged = true;
            }
            if (!this.watching) this.startWatch();
          }
          const revisionChanged = (row?.revision ?? 0) !== (this.cache?.contract.revision ?? -1);
          if (fileChanged || revisionChanged || !this.cache) {
            const snapshot = await this.refresh();
            this.emit(snapshot);
          }
        } catch (error) {
          logger.warn("品牌轮询刷新失败，保留上一快照", {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }, pollMs);
    this.timer.unref?.();
  }
}

export function createBrandStore(deps: BrandStoreDeps = {}): BrandStore {
  return new BrandStoreImpl(deps);
}

let singleton: BrandStore | null = null;

/** 服务端单例：布局/登录/端点/Desktop 桥共用同一 store 与事件源。 */
export function getBrandStore(): BrandStore {
  if (!singleton) singleton = createBrandStore({ startPoll: true });
  return singleton;
}
