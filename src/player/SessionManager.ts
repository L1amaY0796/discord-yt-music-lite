import { entersState, joinVoiceChannel, VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type GuildTextBasedChannel,
  type Snowflake,
  type VoiceBasedChannel,
} from 'discord.js';
import { IdleWatcher } from './IdleWatcher.js';
import { QueueManager } from './QueueManager.js';
import { StreamPlayer, StreamPlayerError, type QueuedTrack, type ResolvedTrack } from './StreamPlayer.js';

const JOIN_TIMEOUT_MS = 15_000;

export const PAUSE_BUTTON_ID = 'music:pause';
export const SKIP_BUTTON_ID = 'music:skip';

const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(PAUSE_BUTTON_ID).setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId(SKIP_BUTTON_ID).setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
);

interface GuildSession {
  connection: VoiceConnection;
  player: StreamPlayer;
  idleWatcher: IdleWatcher;
  channelId: Snowflake;
  textChannel: GuildTextBasedChannel;
  /** playNext() 是否正在解析/啟動下一首，避免同一個 guild 被重複觸發。 */
  advancing: boolean;
}

export interface EnqueueResult {
  queued: boolean;
  position: number;
}

/**
 * 每個 guild 的語音連線 / 播放器 / 閒置計時器都由這裡集中管理。
 * QueueManager 是跨 guild 共用的單一實例（本身已用 Map<guildId, Track[]> 隔離）。
 */
export class SessionManager {
  readonly queue = new QueueManager();
  private readonly sessions = new Map<Snowflake, GuildSession>();
  /** join() 進行中的 promise，讓同一個 guild 的併發 join() 都等同一次結果，不會建立重複連線。 */
  private readonly pendingJoins = new Map<Snowflake, Promise<GuildSession>>();

  constructor(private readonly client: Client) {}

  hasSession(guildId: Snowflake): boolean {
    return this.sessions.has(guildId);
  }

  getNowPlaying(guildId: Snowflake): ResolvedTrack | null {
    return this.sessions.get(guildId)?.player.nowPlaying ?? null;
  }

  peekQueue(guildId: Snowflake, limit = 10): QueuedTrack[] {
    return this.queue.peek(guildId, limit);
  }

  queueSize(guildId: Snowflake): number {
    return this.queue.size(guildId);
  }

  /** 清空待播佇列（不含播放中歌曲），回傳被清空的首數。 */
  clearQueue(guildId: Snowflake): number {
    const count = this.queue.size(guildId);
    this.queue.clear(guildId);
    return count;
  }

  removeLast(guildId: Snowflake): QueuedTrack | undefined {
    return this.queue.removeLast(guildId);
  }

  async join(
    guildId: Snowflake,
    voiceChannel: VoiceBasedChannel,
    textChannel: GuildTextBasedChannel,
  ): Promise<GuildSession> {
    const existing = this.sessions.get(guildId);
    if (existing) {
      return existing;
    }

    const pending = this.pendingJoins.get(guildId);
    if (pending) {
      return pending;
    }

    const joinPromise = this.doJoin(guildId, voiceChannel, textChannel).finally(() => {
      this.pendingJoins.delete(guildId);
    });
    this.pendingJoins.set(guildId, joinPromise);
    return joinPromise;
  }

  private async doJoin(
    guildId: Snowflake,
    voiceChannel: VoiceBasedChannel,
    textChannel: GuildTextBasedChannel,
  ): Promise<GuildSession> {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
    } catch (err) {
      console.error(`語音連線逾時（guild ${guildId}）`, err);
      connection.destroy();
      throw new Error('無法加入語音頻道，請稍後再試');
    }

    const player = new StreamPlayer(connection);
    const idleWatcher = new IdleWatcher(() => this.leave(guildId));
    const session: GuildSession = {
      connection,
      player,
      idleWatcher,
      channelId: voiceChannel.id,
      textChannel,
      advancing: false,
    };
    this.sessions.set(guildId, session);

    // 只負責回報給使用者，不做流程控制——推進佇列一律交給下面的 trackEnd（Idle 轉場時觸發，
    // 不論正常播完還是播放中出錯都會走到這裡，避免 error 和 trackEnd 重複推進佇列）。
    player.on('error', (err: StreamPlayerError) => {
      void textChannel.send(`⚠️ ${err.message}`).catch(() => {});
    });

    player.on('trackStart', (track: ResolvedTrack) => {
      idleWatcher.cancel();
      void textChannel
        .send({ content: `▶️ 正在播放：**${track.title}**`, components: [controlRow] })
        .catch(() => {});
    });

    player.on('trackEnd', () => {
      void this.playNext(guildId);
    });

    // TEMP: 診斷用，問題排除後移除。
    connection.on('stateChange', (oldState, newState) => {
      console.log(`[voice state][guild ${guildId}] ${oldState.status} -> ${newState.status}`);
    });

    connection.on(VoiceConnectionStatus.Disconnected, (_oldState, newState) => {
      console.log(`[voice disconnected][guild ${guildId}] reason=${JSON.stringify(newState)}`);
      void (async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          console.log(`[voice disconnected][guild ${guildId}] 重新連線成功`);
        } catch {
          console.log(`[voice disconnected][guild ${guildId}] 5 秒內未恢復，呼叫 leave()`);
          this.leave(guildId);
        }
      })();
    });

    return session;
  }

  enqueue(guildId: Snowflake, track: QueuedTrack): EnqueueResult {
    const added = this.queue.enqueue(guildId, track);
    if (!added) {
      return { queued: false, position: -1 };
    }

    const position = this.queue.size(guildId);
    const session = this.sessions.get(guildId);
    if (session && !session.player.nowPlaying && !session.advancing) {
      void this.playNext(guildId);
    }
    return { queued: true, position };
  }

  async playNext(guildId: Snowflake): Promise<void> {
    const session = this.sessions.get(guildId);
    // advancing 防止同一個 guild 在上一次 playNext() 還卡在 yt-dlp 解析時，
    // 被另一個 enqueue() 或 trackEnd 重複觸發，搶同一個 StreamPlayer。
    if (!session || session.advancing) return;

    const next = this.queue.dequeue(guildId);
    if (!next) {
      session.idleWatcher.start();
      return;
    }

    session.advancing = true;
    try {
      await session.player.play(next);
    } catch (err) {
      session.advancing = false;
      // 解析期間可能被 /stop 銷毀了這個 session，這種情況不再通知、也不再往下推進佇列。
      if (!this.sessions.has(guildId)) return;
      const message = err instanceof StreamPlayerError ? err.message : '播放失敗，已跳過這首歌';
      void session.textChannel.send(`⚠️ ${message}`).catch(() => {});
      await this.playNext(guildId);
      return;
    }
    session.advancing = false;
  }

  skip(guildId: Snowflake): boolean {
    const session = this.sessions.get(guildId);
    if (!session?.player.nowPlaying) return false;
    session.player.skip();
    return true;
  }

  togglePause(guildId: Snowflake): 'paused' | 'resumed' | 'none' {
    const session = this.sessions.get(guildId);
    if (!session?.player.nowPlaying) return 'none';
    if (session.player.isPaused) {
      session.player.unpause();
      return 'resumed';
    }
    session.player.pause();
    return 'paused';
  }

  leave(guildId: Snowflake): void {
    const session = this.sessions.get(guildId);
    if (!session) return;

    // TEMP: 診斷用，問題排除後移除。
    console.log(`[leave][guild ${guildId}] 被呼叫`, new Error().stack);

    this.sessions.delete(guildId);
    session.idleWatcher.cancel();
    session.player.destroy();
    this.queue.clear(guildId);
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      session.connection.destroy();
    }
  }

  /** 頻道人數（排除機器人）或播放狀態變動時呼叫，重新評估是否該開始/取消閒置倒數。 */
  reconcileIdle(guildId: Snowflake): void {
    const session = this.sessions.get(guildId);
    if (!session) return;

    const channel = this.client.channels.cache.get(session.channelId);
    // 注意：頻道成員數仰賴 discord.js 的 member cache，未啟用 GuildMembers 特權 intent 時，
    // 對於從未觸發過 voice state 事件的舊成員可能不準——這裡先接受這個「lite」限制。
    const humanCount = channel?.isVoiceBased() ? channel.members.filter((m) => !m.user.bot).size : 0;

    const shouldBeIdle = !session.player.nowPlaying || humanCount === 0;
    if (shouldBeIdle) {
      session.idleWatcher.start();
    } else {
      session.idleWatcher.cancel();
    }
  }
}
