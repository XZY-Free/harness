/**
 * 子进程输出排空（跨域进程工具）。
 *
 * 多处生产代码与测试支撑代码都会「接走并排空」子进程的 stdout/stderr
 * （受管 Writer 的换代、崩溃注入 helper、fresh-db 的 boot 冒烟等），
 * 目的是避免管道写满把子进程卡住。
 *
 * 为什么不能只 resume / 挂 data 而不监听 error：
 * Node 在 Linux 上用 AF_UNIX socketpair 实现子进程 stdio。子进程被信号终止
 * （受管 Writer 换代、crash 注入、清理）时，若接收队列里仍有未读数据，
 * 读端可能收到 `read ECONNRESET`；没有 error 监听的流会把它升级为进程级
 * uncaughtException——一次正常的换代/清理就会打翻整个进程。macOS 的内核对
 * 同样场景通常给 EOF，因此该缺口只在 Linux（CI）偶发暴露。
 *
 * 语义：来源死亡引发的读错误 = 排空结束；流此后无内容可读，错误不再上抛。
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
