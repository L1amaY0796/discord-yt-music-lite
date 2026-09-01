import type { QueuedTrack } from './StreamPlayer.js';

const MAX_QUEUE_SIZE = 50;

export class QueueManager {
  private readonly queues = new Map<string, QueuedTrack[]>();

  /** 加入佇列；已達上限（50）時回傳 false。 */
  enqueue(guildId: string, track: QueuedTrack): boolean {
    const queue = this.queues.get(guildId) ?? [];
    if (queue.length >= MAX_QUEUE_SIZE) {
      return false;
    }
    queue.push(track);
    this.queues.set(guildId, queue);
    return true;
  }

  dequeue(guildId: string): QueuedTrack | undefined {
    return this.queues.get(guildId)?.shift();
  }

  /** 移除佇列最後一首（不含播放中歌曲）。 */
  removeLast(guildId: string): QueuedTrack | undefined {
    return this.queues.get(guildId)?.pop();
  }

  /** /queue 顯示前 N 筆，預設 10。 */
  peek(guildId: string, limit = 10): QueuedTrack[] {
    return (this.queues.get(guildId) ?? []).slice(0, limit);
  }

  size(guildId: string): number {
    return this.queues.get(guildId)?.length ?? 0;
  }

  clear(guildId: string): void {
    this.queues.delete(guildId);
  }
}
