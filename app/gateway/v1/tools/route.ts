/**
 * POST /gateway/v1/tools — Runtime 工具目录兼容入口。
 *
 * Tool catalog 与 capability catalog 共用同一个查询 Authority；该路径只是
 * `gateway_endpoints.tools` 的正式 URL 别名，不复制鉴权或目录逻辑。
 */
export const dynamic = "force-dynamic";
export { POST } from "../capabilities/search/route";
