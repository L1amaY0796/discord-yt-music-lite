const IDLE_TIMEOUT_MS = 5 * 60_000;

export class IdleWatcher {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly onIdleTimeout: () => void) {}

  /**
   * 開始倒數；已經在倒數時不做任何事。不能重新計時：呼叫端（reconcileIdle）在 guild 內任何
   * 語音狀態變動時都會呼叫這裡，重設的話只要伺服器有人活動，倒數就永遠到不了。
   */
  start(): void {
    if (this.timer) return;
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
