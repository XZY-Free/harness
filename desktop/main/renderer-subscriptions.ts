interface RendererSender {
  id: number;
  once(event: "destroyed", listener: () => void): unknown;
}

type StopSubscription = () => void;

/** 管理 renderer 发起的主进程订阅，避免组件重挂载时重复累积监听器。 */
export class RendererSubscriptions {
  private subscriptions = new Map<number, Map<string, StopSubscription>>();
  private watchedSenders = new Set<number>();

  replace(sender: RendererSender, key: string, subscribe: () => StopSubscription): void {
    const entries = this.entriesFor(sender);
    entries.get(key)?.();
    entries.set(key, subscribe());
  }

  ensure(sender: RendererSender, key: string, subscribe: () => StopSubscription): void {
    const entries = this.entriesFor(sender);
    if (!entries.has(key)) entries.set(key, subscribe());
  }

  private entriesFor(sender: RendererSender): Map<string, StopSubscription> {
    let entries = this.subscriptions.get(sender.id);
    if (!entries) {
      entries = new Map();
      this.subscriptions.set(sender.id, entries);
    }
    if (!this.watchedSenders.has(sender.id)) {
      this.watchedSenders.add(sender.id);
      sender.once("destroyed", () => this.clearSender(sender.id));
    }
    return entries;
  }

  private clearSender(senderId: number): void {
    const entries = this.subscriptions.get(senderId);
    if (entries) {
      for (const stop of entries.values()) stop();
    }
    this.subscriptions.delete(senderId);
    this.watchedSenders.delete(senderId);
  }
}
