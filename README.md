# dc-ytmusic-lite

輕量化自架 Discord 音樂機器人，串流播放 YouTube 音訊，部署於個人 k3s 叢集（Raspberry Pi 5）。

## 特色

- 純網址輸入，不支援關鍵字搜尋（更精簡、行為更可預期）
- 串流播放，不落地存檔，不做本地快取
- 播放中的訊息附帶 ⏸️ 暫停/繼續、⏭️ 跳過按鈕，不用打指令也能操作
- `/queue` 待播清單顯示標題（YouTube oEmbed）+ 網址，並抑制連結嵌入預覽
- 頻道播完或無人 5 分鐘後自動離開語音頻道

## 指令

| 指令 | 參數 | 說明 |
|---|---|---|
| `/play` | `query`（必填，YouTube 網址） | 加入語音頻道並播放，播放中則排入佇列 |
| `/skip` | — | 跳過目前播放的歌曲 |
| `/pause` | — | 暫停/繼續（同一指令切換） |
| `/queue` | — | 顯示正在播放與待播清單（前 10 筆） |
| `/stop` | — | 停止播放、清空佇列並離開語音頻道 |
| `/log` | `lines`（選填，1-50，預設 20） | 查看機器人最近的 log，不用 SSH 進伺服器；僅限伺服器管理員，回覆為 ephemeral |

佇列上限 50 首。

## 技術棧

- TypeScript + Node.js 22（ESM）
- discord.js v14 + @discordjs/voice v0.19
- yt-dlp：解析歌曲 metadata，並負責實際下載音訊（處理 CDN 端的 range/續傳)
- ffmpeg：純轉檔（PCM s16le 48kHz stereo），從 yt-dlp 的輸出 pipe 讀取，不直接打 CDN 網址
- In-memory Queue（`Map<GuildId, Track[]>`），不做任何持久化

### 為什麼播放是「yt-dlp 下載 → pipe → ffmpeg 轉檔」而不是「解析網址 → ffmpeg 直接打」

早期版本是用 `yt-dlp -j` 解析出一次性的 googlevideo 直接網址，再交給 `ffmpeg -i <url>` 播。這個做法對 CDN 中途「軟性截斷」很脆弱：CDN 沒有真的斷線，而是提早把這次 HTTP 回應結束掉，ffmpeg 收到 EOF 後會誤判成正常播完、乾淨結束（exit code 0），完全不會觸發任何錯誤訊息——結果就是歌曲毫無預兆地提早結束、跳下一首。改成讓 yt-dlp 自己下載（`-o -`）再 pipe 給 ffmpeg 後，由 yt-dlp 處理這類 CDN 層級的重試/續傳邏輯，比 ffmpeg 單純的 `-reconnect` 系列參數可靠。

## 本機開發

### 前置需求

- Node.js 22+
- `ffmpeg`、`yt-dlp` 需在 PATH 上可執行
- Discord Application（見下方「建立 Discord Bot」）

### 設定

```bash
cp .env.example .env
# 填入 DISCORD_TOKEN、DISCORD_CLIENT_ID
# 開發階段建議填 DISCORD_GUILD_ID，指令變更會即時生效（不用等 global command 傳播）
npm install
npm run dev
```

### 建立 Discord Bot

1. 到 [Discord Developer Portal](https://discord.com/developers/applications) 建立 Application
2. Bot 分頁取得 Token → `DISCORD_TOKEN`；General Information 的 Application ID → `DISCORD_CLIENT_ID`
3. **不需要**開任何 Privileged Gateway Intent（本專案只用 `Guilds` + `GuildVoiceStates`）
4. OAuth2 → URL Generator：
   - Scopes：`bot`、`applications.commands`
   - Bot Permissions：`View Channel`、`Send Messages`、`Connect`、`Speak`
5. 用產生的邀請連結把 bot 加進伺服器

## 部署（k3s / Raspberry Pi 5）

```bash
docker build -t ghcr.io/L1amaY0796/dc-ytmusic-lite:latest .
docker push ghcr.io/L1amaY0796/dc-ytmusic-lite:latest

kubectl create secret generic dc-ytmusic-lite-secret \
  --from-literal=DISCORD_TOKEN=xxxxx \
  --from-literal=DISCORD_CLIENT_ID=xxxxx

kubectl apply -f k8s/deployment.yaml
```

參考 `k8s/secret.example.yaml` 了解 Secret 需要的欄位；正式環境不要設定 `DISCORD_GUILD_ID`，讓指令走 global 註冊。

Image 是 arm64（`node:22-alpine`），要在 Raspberry Pi 5 原生 build，或用 `docker buildx build --platform linux/arm64` 搭配已註冊好的 QEMU/binfmt 跨架構模擬——原生 build 更省事也更不容易踩到跨架構模擬的坑。

`k8s/deployment.yaml` 用 `hostNetwork: true`：Discord 語音走 UDP，容器化網路（尤其疊加 CNI overlay）常常會卡在 UDP 交握，直接借用 host 網路可以繞開這類問題；`replicas` 固定為 1，因為 in-memory Queue 綁在單一 process，不能水平擴展。

## 已知問題 / 現況

- **偶發的播放中途中斷**：即使改成 yt-dlp pipe 模式，仍偶爾觀察到歌曲提早結束。`src/player/StreamPlayer.ts` 目前保留了一段暫時性的 `AudioPlayer` debug log（標記 `TEMP`），用來持續蒐集這個問題的證據，問題排除後會移除。
- **偶發的 `Unknown interaction`（Discord API code 10062）**：指令的 3 秒 ACK 窗口偶爾被網路延遲吃掉，屬於 Discord 的硬性限制，目前沒有程式層級的解法，重試即可。

## 專案結構

```
src/
  index.ts               # 進入點，註冊指令、處理 interaction
  logBuffer.ts             # 攔截 console.log/warn/error，供 /log 指令讀取（in-memory，上限 200 行）
  commands/
    play.ts / skip.ts / pause.ts / queue.ts / stop.ts / log.ts
  player/
    SessionManager.ts     # 每個 guild 的連線/播放器/閒置計時器
    StreamPlayer.ts        # yt-dlp + ffmpeg 播放管線
    QueueManager.ts        # per-guild in-memory 佇列
    IdleWatcher.ts          # 閒置自動離開計時器
    oembed.ts                # YouTube oEmbed 標題查詢（/queue 顯示用）
k8s/
  deployment.yaml
  secret.example.yaml
Dockerfile
```
