/**
 * 外部认证区协议类型（暂留内核协议文件）。
 *
 * 消费方模型 v4：登录与认证流程已整体迁移至 auth-center——本文件仅保留
 * 客户端（桌面端 / Web 客户端）渲染登录跳转界面所需的协议类型
 * （ExternalAuthZoneConfig 及其从属类型），随阶段③客户端拆分一并迁出。
 * 认证提供器接口与登录结果类型已随身份域删除（auth-center 侧为权威定义）。
 */

/** 通用图标 token；具体字形由公共组件渲染，品牌语义由部署侧配置选择。 */
export type ExternalAuthIcon = "building" | "network" | "chat" | "mail" | "phone" | "key";

export type ExternalAuthDisplayMode = "auto" | "button" | "tiles" | "stacked";

export interface ExternalAuthMethod {
  readonly id: string;
  readonly label: string;
  /** 逻辑路径（如 /api/auth/sso?returnTo=...），渲染时经 apiPath 映射。 */
  readonly href: string;
  readonly icon?: ExternalAuthIcon;
  readonly recommended?: boolean;
}

export interface ExternalAuthZoneConfig {
  readonly dividerLabel: string;
  readonly methods: ReadonlyArray<ExternalAuthMethod>;
  readonly displayMode?: ExternalAuthDisplayMode;
}
