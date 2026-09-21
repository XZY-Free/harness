import { customType } from "drizzle-orm/mysql-core";

/**
 * MySQL JSON 列映射，同时兼容原生 JSON 与企业审核要求的 LONGTEXT 物理列。
 *
 * mysql2 对原生 JSON 通常直接返回对象，对 LONGTEXT 返回字符串。这里统一还原为
 * 调用方声明的 JSON 数据，并保持写入值始终是合法 JSON 文本。
 */
export const json = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "json";
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(value) {
    if (typeof value === "string") return JSON.parse(value) as unknown;
    if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8")) as unknown;
    return value;
  },
});
