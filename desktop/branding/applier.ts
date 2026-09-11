/**
 * Desktop 品牌应用器：收到 control_brand_invalidated 后以 ETag 拉取权威品牌文档并重设
 * 应用名 / 窗口标题 / 托盘提示。
 *
 * 设计约束：
 * - 只消费失效信号，状态一律 GET /api/brand 拉取（信号/状态分离）；304 即无变化，零成本。
 * - 不直接 import electron：所有 Electron 副作用经 deps 注入，单元可测。
 * - OS 级安装身份（包名/Dock 标签/应用列表名）不在此处理，只走更新换包冷路径。
 */
import type { BrandContract } from "../../lib/branding/brand-contract";

export interface BrandApplierDeps {
  baseUrl: string;
  fetchBrand?: (url: string, init?: RequestInit) => Promise<Response>;
  setAppName: (name: string) => void;
  setAllWindowTitles: (name: string) => void;
  setTrayToolTip?: (name: string) => void;
}

export class BrandApplier {
  private etag: string | null = null;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(private readonly deps: BrandApplierDeps) {
    this.fetchImpl = deps.fetchBrand ?? ((url, init) => fetch(url, init));
  }

  /** 拉取最新品牌并重设；304/失败保持现状（热更新失败不应破坏桌面可用性）。 */
  async refresh(): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.etag) headers["if-none-match"] = this.etag;
    const response = await this.fetchImpl(`${this.deps.baseUrl}/api/brand`, { headers });
    if (response.status === 304) return;
    if (!response.ok) return;
    const etag = response.headers.get("etag");
    const body = (await response.json().catch(() => null)) as {
      brand?: BrandContract;
    } | null;
    if (!body?.brand) return;
    if (etag) this.etag = etag;
    this.apply(body.brand);
  }

  private apply(contract: BrandContract): void {
    this.deps.setAppName(contract.name);
    this.deps.setAllWindowTitles(contract.name);
    this.deps.setTrayToolTip?.(contract.name);
  }
}
