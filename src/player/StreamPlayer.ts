import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
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
const YT_DLP_FORMAT = 'bestaudio[protocol!=m3u8]/bestaudio/best';

interface YtDlpMetadata {
  id?: string;
  title?: string;
  duration?: number;
  is_live?: boolean;
}

// Typed event overloads for StreamPlayer's EventEmitter surface.
export declare interface StreamPlayer {
  on(event: 'trackStart', listener: (track: ResolvedTrack) => void): this;
  on(event: 'trackEnd', listener: (track: ResolvedTrack | null) => void): this;
  on(event: 'error', listener: (error: StreamPlayerError) => void): this;
}

/**
 * 每個語音連線對應一個 StreamPlayer。負責：播放前呼叫 yt-dlp 取得歌曲 metadata，
 * 播放時讓 yt-dlp 自己下載音訊（處理 CDN 的 range/續傳），透過 pipe 交給 ffmpeg 轉成
 * PCM 後串流進 Discord，全程不落地。
 *
 * 呼叫端務必監聽 'error' 事件——EventEmitter 在沒有 listener 時對 'error' 會直接 throw。
 */
export class StreamPlayer extends EventEmitter {
  private readonly player: AudioPlayer;
  private ytdlp: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private ffmpeg: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private current: ResolvedTrack | null = null;
  private destroyed = false;

  constructor(connection: VoiceConnection) {
    super();
    this.player = createAudioPlayer({ debug: true });
    connection.subscribe(this.player);

    const guildId = connection.joinConfig.guildId;

    // TEMP: 診斷用，中途中斷問題排除後移除。
    this.player.on('debug', (message) => {
      console.log(`[audio debug][guild ${guildId}] ${message}`);
    });
    this.player.on('stateChange', (oldState, newState) => {
      console.log(`[audio state][guild ${guildId}] ${oldState.status} -> ${newState.status}`);
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      const finished = this.current;
      this.current = null;
      this.killPipeline();
      this.emit('trackEnd', finished);
    });

    this.player.on('error', (err) => {
      this.killPipeline();
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
    // 避免對著已經斷開的連線重新 spawn 下載/轉檔程序、或補發一則「正在播放」訊息。
    if (this.destroyed) {
      throw new StreamPlayerError('播放已取消（連線已關閉）');
    }
    const resource = this.createResource(track.query);
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
    this.killPipeline();
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
    const args = ['-f', YT_DLP_FORMAT, '--no-playlist', '--no-warnings', '-j', track.query];

    const stdout = await this.runYtDlp(args);

    let data: YtDlpMetadata;
    try {
      data = JSON.parse(stdout) as YtDlpMetadata;
    } catch (err) {
      throw new StreamPlayerError('無法解析歌曲資訊，請換一首試試', err);
    }

    if (data.is_live) {
      throw new StreamPlayerError('目前不支援直播串流播放');
    }

    return {
      ...track,
      id: data.id ?? track.query,
      title: data.title ?? track.title ?? track.query,
      durationSec: typeof data.duration === 'number' ? data.duration : null,
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

  /**
   * 播放來源改成讓 yt-dlp 自己下載（-o -）再 pipe 給 ffmpeg 轉檔，而不是把解析出來的
   * 一次性 googlevideo 網址直接交給 ffmpeg 打。原因：那個網址常常會被 CDN 中途軟性截斷
   * （不是網路斷線，是對方主動把這次回應結束掉），ffmpeg 收到 EOF 後會誤判成正常播完、
   * 乾淨結束（exit code 0），完全不會觸發任何錯誤訊息，實際上歌根本沒播完。yt-dlp 自己
   * 下載時有處理這類 CDN range/續傳的邏輯，比 ffmpeg 單純的 -reconnect 系列參數可靠。
   */
  private createResource(query: string): AudioResource {
    this.killPipeline();

    const ytdlp = spawn(
      YT_DLP_BIN,
      ['-f', YT_DLP_FORMAT, '--no-playlist', '--no-warnings', '-o', '-', query],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.ytdlp = ytdlp;

    const ffmpeg = spawn(
      FFMPEG_BIN,
      [
        '-i', 'pipe:0',
        '-analyzeduration', '0',
        '-loglevel', 'error',
        '-vn',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.ffmpeg = ffmpeg;

    ytdlp.stdout.pipe(ffmpeg.stdin);
    // pipe() 不會處理錯誤——其中一端提早結束時，另一端寫入/讀取會噴 EPIPE，這裡單純吃掉，
    // 避免變成沒人接的 stream 'error' 事件把整個 process 弄掛，真正的錯誤通報交給下面
    // 兩個 child process 各自的 'error'/'close' 處理。
    ytdlp.stdout.on('error', () => {});
    ffmpeg.stdin.on('error', () => {});

    let ytdlpStderr = '';
    ytdlp.stderr.on('data', (chunk: Buffer) => {
      ytdlpStderr += chunk;
    });
    ytdlp.on('error', (err) => {
      this.emit('error', new StreamPlayerError('無法啟動 yt-dlp，請確認伺服器已安裝', err));
    });
    ytdlp.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this.emit(
          'error',
          new StreamPlayerError('下載音訊時發生錯誤，可能是網路或來源問題', ytdlpStderr.trim() || `yt-dlp exited with code ${code}`),
        );
      }
    });

    let ffmpegStderr = '';
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      ffmpegStderr += chunk;
    });
    ffmpeg.on('error', (err) => {
      this.emit('error', new StreamPlayerError('音訊轉檔失敗，請確認伺服器已安裝 ffmpeg', err));
    });
    ffmpeg.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this.emit('error', new StreamPlayerError('播放中斷，可能是網路或來源問題', ffmpegStderr.trim()));
      }
    });

    return createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  }

  private killPipeline(): void {
    if (this.ytdlp && !this.ytdlp.killed) {
      this.ytdlp.kill('SIGKILL');
    }
    if (this.ffmpeg && !this.ffmpeg.killed) {
      this.ffmpeg.kill('SIGKILL');
    }
    this.ytdlp = null;
    this.ffmpeg = null;
  }
}
