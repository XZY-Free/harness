/**
 * ：Desktop 连接状态机。
 *
 * Desktop 与 Server 的 WebSocket 连接经过严格的状态机管理，只有处于
 * authenticated 状态时才能收发 RPC 请求。状态转换失败抛出错误，防止
 * 非法状态跳转导致安全漏洞。
 *
 * 状态说明：
 * - disconnected：未连接
 * - connecting：正在建立 WebSocket 连接
 * - connected：WebSocket 已连接，未认证
 * - authenticated：已通过设备认证，可收发 RPC
 * - revoked：设备已被撤销，必须手动重连
 * - protocol_mismatch：协议版本不兼容
 * - reconnecting：断线重连中
 */

/**
 * 连接状态。
 */
export type ConnectionState =
 | "disconnected"
 | "connecting"
 | "connected"
 | "authenticated"
 | "revoked"
 | "protocol_mismatch"
 | "reconnecting";

/**
 * 连接事件。
 */
export type ConnectionEvent =
 | { type: "connect" }
 | { type: "connected" }
 | { type: "authenticate" }
 | { type: "authenticated" }
 | { type: "revoke" }
 | { type: "protocol_mismatch" }
 | { type: "disconnect" }
 | { type: "reconnect" }
 | { type: "reconnect_success" }
 | { type: "reconnect_fail" };

/**
 * 状态转换规则表：Map<当前状态, Map<事件类型, 目标状态>>。
 */
const TRANSITIONS: Map<ConnectionState, Map<ConnectionEvent["type"], ConnectionState>> = (() => {
 const table = new Map<ConnectionState, Map<ConnectionEvent["type"], ConnectionState>>();
 const add = (from: ConnectionState, event: ConnectionEvent["type"], to: ConnectionState) => {
 let eventMap = table.get(from);
 if (!eventMap) {
 eventMap = new Map();
 table.set(from, eventMap);
 }
 eventMap.set(event, to);
 };
 // disconnected → connecting (connect)
 add("disconnected", "connect", "connecting");
 // connecting → connected (connected)
 add("connecting", "connected", "connected");
 // connecting → disconnected (disconnect)
 add("connecting", "disconnect", "disconnected");
 // connected → authenticated (authenticated)
 add("connected", "authenticated", "authenticated");
 // connected → disconnected (disconnect)
 add("connected", "disconnect", "disconnected");
 // connected → revoked (revoke)
 add("connected", "revoke", "revoked");
 // connected → protocol_mismatch (protocol_mismatch)
 add("connected", "protocol_mismatch", "protocol_mismatch");
 // authenticated → disconnected (disconnect)
 add("authenticated", "disconnect", "disconnected");
 // authenticated → revoked (revoke)
 add("authenticated", "revoke", "revoked");
 // disconnected → reconnecting (reconnect)
 add("disconnected", "reconnect", "reconnecting");
 // reconnecting → connected (reconnect_success)
 add("reconnecting", "reconnect_success", "connected");
 // reconnecting → disconnected (reconnect_fail)
 add("reconnecting", "reconnect_fail", "disconnected");
 // revoked → disconnected (disconnect)
 add("revoked", "disconnect", "disconnected");
 // protocol_mismatch → disconnected (disconnect)
 add("protocol_mismatch", "disconnect", "disconnected");
 return table;
})();

/**
 * 连接状态机。
 *
 * 维护当前连接状态，处理事件驱动的状态转换。
 * 状态变化时通知所有订阅者。
 */
export class ConnectionStateMachine {
 private state: ConnectionState = "disconnected";
 private listeners = new Set<(state: ConnectionState, prevState: ConnectionState) => void>();

 /**
 * 获取当前状态。
 */
 getState(): ConnectionState {
 return this.state;
 }

 /**
 * 触发状态转换。
 *
 * @param event 连接事件
 * @returns 转换后的新状态
 * @throws 非法转换抛出错误
 */
 transition(event: ConnectionEvent): ConnectionState {
 const eventMap = TRANSITIONS.get(this.state);
 const newState = eventMap?.get(event.type);
 if (!newState) {
 throw new Error(`非法状态转换：${this.state} + ${event.type}`);
 }
 const prevState = this.state;
 this.state = newState;
 // 通知订阅者
 for (const listener of this.listeners) {
 listener(this.state, prevState);
 }
 return this.state;
 }

 /**
 * 是否可以发送 RPC（只有 authenticated 状态可以）。
 */
 canSendRpc(): boolean {
 return this.state === "authenticated";
 }

 /**
 * 是否在线（connected 或 authenticated）。
 */
 isOnline(): boolean {
 return this.state === "connected" || this.state === "authenticated";
 }

 /**
 * 订阅状态变化。
 *
 * @param listener 回调函数，接收新状态和旧状态
 * @returns 取消订阅函数
 */
 subscribe(listener: (state: ConnectionState, prevState: ConnectionState) => void): () => void {
 this.listeners.add(listener);
 return () => {
 this.listeners.delete(listener);
 };
 }
}
