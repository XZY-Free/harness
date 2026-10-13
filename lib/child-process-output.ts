/**
 * 子进程 stdio 管道工具（跨域进程工具）。
 *
 * 我们持有的子进程管道有两类，风险方向不同但根因相同 —— 对端（子进程）会被
 * 信号终止：受管 Writer 换代、crash 注入 helper、清理、以及测试里的显式强杀。
 *
 * 1. **输出流**（stdout/stderr）：必须被消费，否则管道写满会把子进程卡住；
 *    消费时同时要容忍来源死亡引发的读错误（`drainChildProcessOutput`）。
 * 2. **放行通道**（受管 Writer 的私有 fd）：我们只往里写令牌，但 `spawn` 建立的
 *    stdio 管道在父进程侧**立即开始读取**（用于感知对端关闭），因此它同样暴露在读端，
 *    同样需要容忍对端死亡（`tolerateChannelPeerDeath`）。
 *
 * 为什么读错误会逃逸成进程级事故：
 * Node 在 Linux 上用 AF_UNIX socketpair 实现子进程 stdio。子进程被信号终止时，
 * 若接收队列里仍有未读数据（最典型的就是「令牌已写入、wrapper 还没读到就被杀」），
 * 读端会收到 `read ECONNRESET`；macOS 的内核对同样场景通常给 EOF，因此该缺口只在
 * Linux（CI）暴露。没有 error 监听的流会把它升级为 uncaughtException ——
 * 一次正常的换代/清理/受控崩溃就能打翻整个进程。
 */

/** 提供 stdout/stderr 读流的来源（`ChildProcess` 天然满足）。 */
export interface ChildProcessOutputSource {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
}

/**
 * 排空子进程的 stdout/stderr：确保流被消费（避免管道写满），
 * 并把「来源死亡」引发的流错误按排空结束处理，而不是让它们逃逸成未处理异常。
 *
 * 各调用点可在此基础上自行监听 `data` 收集/转发输出；本函数只负责
 * 「消费 + 容忍来源死亡」。对已在读取的流重复调用无副作用。
 */
export function drainChildProcessOutput(source: ChildProcessOutputSource): void {
  for (const stream of [source.stdout, source.stderr]) {
    if (!stream) continue;
    stream.on("error", () => {
      // 子进程已终止（ECONNRESET / EPIPE / ERR_STREAM_PREMATURE_CLOSE 等）：
      // 排空到此结束，无需（也无法）再读。
    });
    stream.resume();
  }
}

/**
 * 容忍放行通道的对端死亡：通道是**写**通道，但它同时被 Node 当作读流启动，
 * 对端被强杀时会在读端产生 `read ECONNRESET`（Linux；macOS 给 EOF），
 * 在写端产生 EPIPE。两者都不是本进程的故障：wrapper 在读到令牌之前就被杀掉，
 * 正是「用户任务从未开始」的受控崩溃窗口（wrapper 的 41/42 退出码语义）。
 *
 * 是否放行成功不由这条管道回答 —— 写方失败按「未放行」处理，读者无内容可读；
 * 因此这里只吸收错误，不改变任何通道语义。
 */
export function tolerateChannelPeerDeath(channel: NodeJS.EventEmitter | null | undefined): void {
  if (!channel) return;
  channel.on("error", () => {
    // 对端已死：通道不再可用，无需（也无法）做任何补救。
  });
}
