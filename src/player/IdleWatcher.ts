const IDLE_TIMEOUT_MS = 5 * 60_000;

// TODO: 於頻道無人或佇列播完時呼叫 start()，有新的播放/成員加入時呼叫 cancel()。
export class IdleWatcher {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly onIdleTimeout: () => void) {}

  start(): void {
    this.clear();
    this.timer = setTimeout(() => this.onIdleTimeout(), IDLE_TIMEOUT_MS);
  }

  cancel(): void {
    this.clear();
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
