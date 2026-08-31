import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';

export interface QueuedTrack {
  query: string;
  requestedBy: string;
  /** enqueue 時透過 YouTube oEmbed 取得的標題，僅供 /queue 顯示用，非權威來源。 */
  title?: string;
}

export interface ResolvedTrack extends QueuedTrack {
  id: string;
  title: string;
  durationSec: number | null;
  streamUrl: string;
}

export class StreamPlayerError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'StreamPlayerError';
  }
}

const YT_DLP_BIN = 'yt-dlp';
const FFMPEG_BIN = 'ffmpeg';
const RESOLVE_TIMEOUT_MS = 15_000;

interface YtDlpMetadata {
  id?: string;
  title?: string;
  duration?: number;
  url?: string;
  requested_downloads?: Array<{ url?: string }>;
}

// Typed event overloads for StreamPlayer's EventEmitter surface.
export declare interface StreamPlayer {
  on(event: 'trackStart', listener: (track: ResolvedTrack) => void): this;
  on(event: 'trackEnd', listener: (track: ResolvedTrack | null) => void): this;
  on(event: 'error', listener: (error: StreamPlayerError) => void): this;
}

/**
 * 每個語音連線對應一個 StreamPlayer。負責：播放前呼叫 yt-dlp 解析直接音訊網址，
 * 交給 ffmpeg 轉成 PCM 後串流進 Discord，全程不落地。
 *
 * 呼叫端務必監聽 'error' 事件——EventEmitter 在沒有 listener 時對 'error' 會直接 throw。
 */
export class StreamPlayer extends EventEmitter {
  private readonly player: AudioPlayer;
  private ffmpeg: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private current: ResolvedTrack | null = null;
  private destroyed = false;

  constructor(connection: VoiceConnection) {
    super();
    this.player = createAudioPlayer();
    connection.subscribe(this.player);

    this.player.on(AudioPlayerStatus.Idle, () => {
      const finished = this.current;
      this.current = null;
      this.killFfmpeg();
      this.emit('trackEnd', finished);
    });

    this.player.on('error', (err) => {
      this.killFfmpeg();
      this.emit('error', new StreamPlayerError('播放時發生錯誤，已跳過這首歌', err));
    });
  }

  get nowPlaying(): ResolvedTrack | null {
    return this.current;
  }

  get isPaused(): boolean {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  async play(track: QueuedTrack): Promise<ResolvedTrack> {
    const resolved = await this.resolve(track);
    // 解析 yt-dlp 期間可能已經被 /stop 銷毀（destroy()），這裡才拿到結果就直接放棄，
    // 避免對著已經斷開的連線重新 spawn ffmpeg、或補發一則「正在播放」訊息。
    if (this.destroyed) {
      throw new StreamPlayerError('播放已取消（連線已關閉）');
    }
    const resource = this.createResource(resolved.streamUrl);
    this.current = resolved;
    this.player.play(resource);
    this.emit('trackStart', resolved);
    return resolved;
  }

  /** 停止目前這首歌；player 轉為 Idle 後會自動觸發 'trackEnd'，由呼叫端接手播下一首。 */
  skip(): void {
    this.player.stop(true);
  }

  stop(): void {
    this.killFfmpeg();
    this.current = null;
    this.player.stop(true);
  }

  pause(): boolean {
    return this.player.pause();
  }

  unpause(): boolean {
    return this.player.unpause();
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.player.removeAllListeners();
  }

  private async resolve(track: QueuedTrack): Promise<ResolvedTrack> {
    const args = [
      '-f', 'bestaudio[protocol!=m3u8]/bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '-j',
      track.query,
    ];

    const stdout = await this.runYtDlp(args);

    let data: YtDlpMetadata;
    try {
      data = JSON.parse(stdout) as YtDlpMetadata;
    } catch (err) {
      throw new StreamPlayerError('無法解析歌曲資訊，請換一首試試', err);
    }

    const streamUrl = data.url ?? data.requested_downloads?.[0]?.url;
    if (!streamUrl) {
      throw new StreamPlayerError('找不到可播放的音訊來源', data);
    }

    return {
      ...track,
      id: data.id ?? track.query,
      title: data.title ?? track.title ?? track.query,
      durationSec: typeof data.duration === 'number' ? data.duration : null,
      streamUrl,
    };
  }

  private runYtDlp(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(YT_DLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new StreamPlayerError('取得歌曲資訊逾時，請稍後再試'));
      }, RESOLVE_TIMEOUT_MS);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk;
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk;
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new StreamPlayerError('無法啟動 yt-dlp，請確認伺服器已安裝', err));
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new StreamPlayerError(
              '找不到這首歌，或影片無法播放',
              stderr.trim() || `yt-dlp exited with code ${code}`,
            ),
          );
          return;
        }

        const firstLine = stdout.split('\n').find((line) => line.trim().length > 0);
        if (!firstLine) {
          reject(new StreamPlayerError('yt-dlp 沒有回傳任何資料'));
          return;
        }
        resolve(firstLine);
      });
    });
  }

  private createResource(streamUrl: string): AudioResource {
    this.killFfmpeg();

    const ffmpeg = spawn(
      FFMPEG_BIN,
      [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', streamUrl,
        '-analyzeduration', '0',
        '-loglevel', 'error',
        '-vn',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.ffmpeg = ffmpeg;

    ffmpeg.on('error', (err) => {
      this.emit('error', new StreamPlayerError('音訊轉檔失敗，請確認伺服器已安裝 ffmpeg', err));
    });

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    ffmpeg.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this.emit('error', new StreamPlayerError('播放中斷，可能是網路或來源問題', stderr.trim()));
      }
    });

    return createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  }

  private killFfmpeg(): void {
    if (this.ffmpeg && !this.ffmpeg.killed) {
      this.ffmpeg.kill('SIGKILL');
    }
    this.ffmpeg = null;
  }
}
