# dc-ytmusic-lite

輕量化自架 Discord 音樂機器人，部署於個人 k3s 叢集。詳細規格見 spec.md。

## 技術棧
- TypeScript + Node.js 22
- discord.js v14
- @discordjs/voice + ffmpeg
- yt-dlp（subprocess，取 audio URL 串流，不落地）
- In-memory Queue（Map<GuildId, Track[]>）

## 核心設計決策
- 串流模式：播放前才呼叫 yt-dlp 取 URL，Queue 只存 video ID / query
- 無本地快取，無 /volume 指令（ARM CPU 負載問題）
- Queue 上限 50 首，/queue 顯示前 10 筆
- 閒置自動退出：Queue 播完或頻道無人 5 分鐘後退出

## 專案結構
src/
  index.ts
  commands/
    play.ts / skip.ts / pause.ts / queue.ts / stop.ts
  player/
    StreamPlayer.ts   ← 核心，優先實作
    QueueManager.ts
    IdleWatcher.ts

## 錯誤處理
所有 yt-dlp 錯誤必須捕捉，回覆友善訊息，不得 uncaught crash

## 部署目標
k3s on Raspberry Pi 5（pie5），Docker + node:22-alpine
