# dc-ytmusic-lite 規格書

> 版本：v0.5　·　2026-09-01
>
> **v0.5 變更摘要**：新增 `/log` 指令（管理員專用，查看最近 log，不用 SSH 進伺服器）、擋掉直播播放並提示不支援。
>
> **v0.4 變更摘要**：校正本文件與目前 repo 實際狀態不一致的地方——`/play` 已拿掉關鍵字搜尋、`/pause` 是單一切換指令（沒有獨立的 `/resume`）、閒置逾時改為 5 分鐘且是寫死的常數（沒有 `IDLE_TIMEOUT_SEC` 環境變數）、錯誤訊息目前是通用訊息而非依錯誤類型細分、Dockerfile 與 k8s Deployment 規格改為如實反映 repo 裡的檔案內容。

---

## 1. 專案目標

自架輕量化 Discord 音樂機器人，部署於個人 k3s 叢集（Raspberry Pi 5），供私人 Discord 伺服器使用。不依賴第三方音樂機器人服務，完全自控。

**Repository**：https://github.com/L1amaY0796/discord-yt-music-lite

---

## 2. 功能範圍

### 納入（In-scope）

| 功能 | 指令 | 說明 |
|------|------|------|
| 播放 | `/play <url>` | 僅接受 YouTube 網址（`http(s)://` 開頭），不支援關鍵字搜尋 |
| 暫停／繼續 | `/pause` | 單一指令切換暫停/繼續，沒有獨立的 `/resume` |
| 跳過 | `/skip` | 跳到下一首，無需投票 |
| 停止 | `/stop` | 停止播放並清空 queue，退出頻道 |
| 播放清單 | `/queue` | 顯示目前 queue 前 10 筆，附「還有 N 首」提示 |
| 查看 log | `/log [lines]` | 顯示最近 N 行 log（預設 20，最多 50），不用 SSH 進伺服器；僅限伺服器管理員（`Administrator`），回覆為 ephemeral |

播放中的訊息會附帶 ⏸️ 暫停/繼續、⏭️ 跳過兩顆按鈕，效果等同對應指令。

### 排除（Out-of-scope）

- `/volume` 音量調整（ARM 環境 inline volume transform CPU 負載過高，易造成音訊斷斷續續；建議使用者透過 Discord 客戶端右鍵調整個人收聽音量）
- 關鍵字搜尋（只接受直接網址，行為更可預期，避免搜到非預期影片）
- Spotify 真實音源播放（ToS 限制）
- 快轉 / Seek
- 使用者收藏、播放紀錄持久化
- 多語系 / 投票跳歌
- Web UI 控制面板

---

## 3. 技術選型

| 項目 | 選擇 | 備註 |
|------|------|------|
| 語言 | TypeScript + Node.js 22 | ESM 專案 |
| Discord 框架 | discord.js v14 | Slash command 原生支援 |
| 音訊播放 | @discordjs/voice v0.19.2 + ffmpeg | 支援 DAVE E2EE（close code 4017）|
| DAVE E2EE | @snazzah/davey | v0.19.2 自動帶入，需 arm64 native binary |
| YouTube 來源 | yt-dlp（pipe 模式） | spawn 兩個 process：yt-dlp -o - \| ffmpeg -i pipe:0 |
| Queue 儲存 | In-memory（Map\<GuildId, Track[]\>） | 輕量，不需資料庫；重啟即清空 |
| 標題取得 | YouTube oEmbed API | enqueue 時輕量 HTTP GET，不額外呼叫 yt-dlp |
| 容器化 | Docker + node:22-alpine | 在 Pi 5 原生 build（arm64），不用 QEMU 交叉編譯 |

### 音訊播放流程（pipe 模式）

```
/play <query>
    │
    ▼
yt-dlp 搜尋 / 解析（播放前才呼叫，避免 URL TTL 過期）
    │
    ▼
yt-dlp -o - <url>  →  stdout pipe
                              │
                              ▼
                    ffmpeg -i pipe:0  →  Opus stream
                              │
                              ▼
                    @discordjs/voice AudioResource → VoiceConnection
```

> **為何用 pipe 模式**：直接把 googlevideo URL 交給 ffmpeg，YouTube CDN 會在 3–4 分鐘後軟性截斷連線（exit code 0，沒有錯誤訊息），導致歌曲提早結束。改用 yt-dlp pipe 後，yt-dlp 自己處理 CDN 的 range-request 與斷線重連，解決此問題。

---

## 4. Queue 行為規範

| 項目 | 規格 |
|------|------|
| Queue 上限 | 50 首（超過則拒絕新增，回覆提示） |
| `/queue` 顯示 | 最多顯示前 10 筆，附「還有 N 首未顯示」 |
| YouTube 播放清單 | 僅取前 50 首，超過截斷並告知使用者 |
| Queue 範圍 | 每個 Guild 獨立，互不影響 |
| Queue 儲存內容 | video ID / query（不存 URL，避免 TTL 問題） |

---

## 5. 閒置處理機制

| 觸發條件 | 行為 |
|---------|------|
| Queue 播完 | 啟動閒置倒數，5 分鐘內沒有新的播放就自動退出語音頻道並清空 Queue |
| 頻道內所有使用者離開 | 同一個閒置倒數機制，5 分鐘後自動退出並清空 Queue |
| `/stop` 指令 | 立即退出並清空 Queue |

閒置秒數是 `IdleWatcher.ts` 裡寫死的常數（`5 * 60_000` ms），目前沒有對應的環境變數可調整。

---

## 6. 錯誤處理規範

所有 yt-dlp / ffmpeg 呼叫必須捕捉錯誤，並在原頻道回覆友善訊息，不得 uncaught crash。

除了直播（明確擋掉）跟網址格式/佇列已滿（使用者輸入面的驗證）之外，其餘 yt-dlp 失敗原因（年齡限制、私密、已刪除等）目前**沒有**細分訊息，一律歸類成同一種通用訊息，實際訊息如下：

| 情境 | 觸發點 | 實際回覆訊息 |
|------|--------|------------|
| 非 http(s) 網址 | `/play` 指令參數驗證 | 請提供有效的 YouTube 網址 |
| 加入語音頻道逾時/失敗 | `SessionManager.join()` | 無法加入語音頻道，請稍後再試 |
| yt-dlp 解析 metadata 逾時（15 秒） | `resolve()` | 取得歌曲資訊逾時，請稍後再試 |
| 直播串流（`is_live: true`） | `resolve()` | 目前不支援直播串流播放 |
| yt-dlp 解析/下載失敗（涵蓋年齡限制、私密、已刪除等情況） | `resolve()` / 下載階段 | 找不到這首歌，或影片無法播放 / 下載音訊時發生錯誤，可能是網路或來源問題 |
| yt-dlp 或 ffmpeg 執行檔缺失 | spawn 失敗 | 無法啟動 yt-dlp，請確認伺服器已安裝 / 音訊轉檔失敗，請確認伺服器已安裝 ffmpeg |
| ffmpeg 非正常結束 | ffmpeg close code 非 0 | 播放中斷，可能是網路或來源問題 |
| Queue 已滿 | `enqueue()` | 播放佇列已滿（上限 50 首），請稍後再試 |

---

## 7. 部署環境

### 叢集架構

| 節點 | 規格 | 角色 |
|------|------|------|
| laptopserver-1 | 8GB RAM / HDD / Ubuntu Server | k3s control-plane，kubectl 操作入口 |
| pie5 | Pi 5 / 4GB RAM / Ubuntu Server | **主 worker**，bot Pod 部署於此 |
| pie4 | Pi 4 / 2GB RAM / Ubuntu Server | 輕 worker，排除於 bot 排程之外 |

- 節點透過 **Tailscale**（`tailscale0`）互聯，flannel overlay 跑在 Tailscale 上
- bot 不需對外 expose（無 Ingress），只需出站連 Discord Gateway 及 YouTube CDN
- `hostNetwork: true` + `dnsPolicy: ClusterFirstWithHostNet`：解決 k3s CNI overlay 的 UDP NAT 問題
- `NODE_OPTIONS=--dns-result-order=ipv4first`：Pi 5 IPv6 出站不可用，強制優先 IPv4

### Image Registry

- **GHCR**：`ghcr.io/L1amaY0796/dc-ytmusic-lite:latest`
- Package 目前是 **Private**，`k8s/deployment.yaml` 有設定 `imagePullSecrets: ghcr-pull-secret`（`docker-registry` 類型的 Secret，需要有 `read:packages` 權限的 GitHub PAT）

---

## 8. k3s Deployment 規格

| 項目 | 值 |
|------|----|
| Replicas | 1（in-memory Queue 綁在單一 process，不支援水平擴展） |
| Strategy | Recreate（避免 RollingUpdate 短暫同時跑兩個 bot） |
| 資源 Request | CPU: 100m　Memory: 128Mi |
| 資源 Limit | CPU: 500m　Memory: 256Mi |
| 排程策略 | `nodeSelector: kubernetes.io/arch: arm64`，防止排到叢集裡非 arm64 的 node；沒有使用 nodeAffinity 指定特定 node |
| Secret 管理 | k3s Secret `dc-ytmusic-lite-secret` → 環境變數注入；另有 `ghcr-pull-secret` 供拉取 private image |

### Deployment YAML

以下內容需與 `k8s/deployment.yaml` 保持一致（修改時請兩邊一起改，避免這份文件再度跟 repo 漂移）：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dc-ytmusic-lite
  labels:
    app: dc-ytmusic-lite
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: dc-ytmusic-lite
  template:
    metadata:
      labels:
        app: dc-ytmusic-lite
    spec:
      nodeSelector:
        kubernetes.io/arch: arm64
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      imagePullSecrets:
        - name: ghcr-pull-secret
      containers:
        - name: dc-ytmusic-lite
          image: ghcr.io/L1amaY0796/dc-ytmusic-lite:latest
          imagePullPolicy: Always
          env:
            - name: NODE_OPTIONS
              value: "--dns-result-order=ipv4first"
          envFrom:
            - secretRef:
                name: dc-ytmusic-lite-secret
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
```

---

## 9. 環境變數

| 變數名稱 | 必填 | 說明 |
|---------|------|------|
| `DISCORD_TOKEN` | 必填 | Discord Bot Token |
| `DISCORD_CLIENT_ID` | 必填 | 用於註冊 Slash command |
| `DISCORD_GUILD_ID` | 選填 | 設定後只註冊 guild command（即時生效）；不設定則註冊 global command（最多 1 小時延遲） |

閒置逾時目前沒有對應的環境變數（見第 5 節），修改需要動 `IdleWatcher.ts` 的常數並重新 build。

---

## 10. 專案結構

```
dc-ytmusic-lite/
├── src/
│   ├── index.ts              # 入口，登入 Discord、註冊指令
│   ├── logBuffer.ts          # 攔截 console.log/warn/error，供 /log 讀取（in-memory，上限 200 行）
│   ├── commands/
│   │   ├── play.ts           # /play <url>（僅接受網址）
│   │   ├── skip.ts           # /skip
│   │   ├── pause.ts          # /pause（切換暫停/繼續）
│   │   ├── queue.ts          # /queue（顯示前 10 筆）
│   │   ├── stop.ts           # /stop + 清空 queue + 退出頻道
│   │   ├── log.ts            # /log [lines]，僅限管理員
│   │   └── types.ts          # Command 介面定義
│   └── player/
│       ├── SessionManager.ts # 每個 Guild 一組 {connection, player, queue}，含 race condition 防護
│       ├── QueueManager.ts   # In-memory Queue（Map<GuildId, Track[]>），上限 50 首
│       ├── StreamPlayer.ts   # yt-dlp pipe → ffmpeg → AudioResource
│       ├── IdleWatcher.ts    # 閒置偵測，自動退出頻道
│       └── oembed.ts         # YouTube oEmbed 標題查詢（/queue 顯示用）
├── k8s/
│   ├── deployment.yaml       # k3s Deployment（nodeSelector + hostNetwork）
│   └── secret.example.yaml  # Secret 範本（不含真實密鑰）
├── Dockerfile                # node:22-alpine，在 Pi 5 原生 build
├── .env.example
├── README.md                  # 使用者/開發者導向的說明文件
├── spec.md                   # 本文件（詳細規格）
├── tsconfig.json
└── package.json
```

---

## 11. Dockerfile

以下內容需與根目錄的 `Dockerfile` 保持一致：

```dockerfile
# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg yt-dlp

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node
CMD ["node", "dist/index.js"]
```

目前**沒有**啟動時自動更新 yt-dlp 的機制——`apk add yt-dlp` 裝的是 Alpine community repo 當下收錄的版本，YouTube 改動導致 yt-dlp 失效時，需要手動重新 build image（屆時 Alpine repo 通常也已經更新到修好的版本）。

> **注意**：image 在 Pi 5（arm64）上原生 build，不用 QEMU 交叉編譯。`@snazzah/davey`（DAVE E2EE 用的原生加密 binding）雖然有 arm64-musl 的 prebuilt binary，但原生 build 比跨架構模擬更省事、更不容易踩坑。

---

## 12. 開發工作流程

```
WSL（開發）
    git add . && git commit -m "..." && git push
          │
          ▼
    GitHub（L1amaY0796/discord-yt-music-lite）
          │
          ▼
    Pi 5（build）
    git pull
    docker build -t ghcr.io/L1amaY0796/dc-ytmusic-lite:latest .
    docker push ghcr.io/L1amaY0796/dc-ytmusic-lite:latest
          │
          ▼
    laptopserver-1（部署）
    sudo kubectl rollout restart deployment/dc-ytmusic-lite
```

---

## 13. 已知限制與風險

| 風險 | 說明 | 緩解方式 |
|------|------|---------|
| yt-dlp 失效 | YouTube 定期更新 player JS / PO token 機制 | 目前**沒有**啟動時自動更新機制；失效時需重新 build image（`apk add yt-dlp` 屆時通常已跟著 Alpine repo 更新到能用的版本） |
| @discordjs/voice 破壞性更新 | 如 DAVE E2EE（close code 4017）強制要求新協定 | 追蹤 changelog，定期升級套件並 rebuild |
| Queue 揮發 | Pod 重啟後 queue 清空 | 輕量版接受此行為 |
| YouTube ToS | 個人自用灰色地帶 | 保持低調，勿公開服務 |
| Pi 5 斷電 | Pod 停止服務 | 復電後 k3s 自動重啟，無需手動介入 |
| 播放中途偶發中斷 | 即使改成 yt-dlp pipe 模式，仍偶爾觀察到歌曲提早結束，原因尚未完全確認 | `StreamPlayer.ts` 保留暫時性的 `AudioPlayer` debug log 持續蒐證，問題排除後移除 |
| `/play` 偶發 `Unknown interaction`（code 10062） | 指令的 3 秒 ACK 窗口被網路延遲吃掉，屬 Discord 硬性限制 | 沒有程式層級解法，重試即可 |

---

## 14. 常用維運指令

```bash
# 查看 Pod 狀態（在 laptopserver-1）
sudo kubectl get pods -o wide

# 看即時 log
sudo kubectl logs -f deployment/dc-ytmusic-lite

# 重啟 Pod（更新 image 後）
sudo kubectl rollout restart deployment/dc-ytmusic-lite

# 查看 Pod 在哪個節點
sudo kubectl get pod -l app=dc-ytmusic-lite -o wide
```
