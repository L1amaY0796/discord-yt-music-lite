# dc-ytmusic-lite 規格書

> 版本：v0.3　·　2026-08-31
>
> **v0.3 變更摘要**：修正 CDN 軟性截斷問題（改為 yt-dlp pipe 模式）、確認 DAVE E2EE 升級（@discordjs/voice 0.19.2）、補充實際部署架構與 git 工作流程。

---

## 1. 專案目標

自架輕量化 Discord 音樂機器人，部署於個人 k3s 叢集（Raspberry Pi 5），供私人 Discord 伺服器使用。不依賴第三方音樂機器人服務，完全自控。

**Repository**：https://github.com/L1amaY0796/discord-yt-music-lite

---

## 2. 功能範圍

### 納入（In-scope）

| 功能 | 指令 | 說明 |
|------|------|------|
| 播放 | `/play <keyword\|url>` | 關鍵字搜尋或 YouTube URL 直接播 |
| 暫停／繼續 | `/pause` `/resume` | 暫停或繼續當前播放 |
| 跳過 | `/skip` | 跳到下一首，無需投票 |
| 停止 | `/stop` | 停止播放並清空 queue，退出頻道 |
| 播放清單 | `/queue` | 顯示目前 queue 前 10 筆，附「還有 N 首」提示 |

### 排除（Out-of-scope）

- `/volume` 音量調整（ARM 環境 inline volume transform CPU 負載過高，易造成音訊斷斷續續；建議使用者透過 Discord 客戶端右鍵調整個人收聽音量）
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
| Queue 播完 | 自動退出語音頻道，清空該 Guild 的 Queue |
| 頻道內所有使用者離開 | 60 秒倒數後自動退出並清空 Queue |
| `/stop` 指令 | 立即退出並清空 Queue |

---

## 6. 錯誤處理規範

所有 yt-dlp 呼叫必須捕捉錯誤，並在原頻道回覆友善訊息，不得 uncaught crash。

| 錯誤類型 | 回覆訊息範例 |
|---------|------------|
| 年齡限制影片 | ⚠️ 此影片受年齡限制，無法播放 |
| 私密／已刪除影片 | ⚠️ 找不到此影片，請確認連結是否正確 |
| 直播串流 | ⚠️ 目前不支援直播串流 |
| yt-dlp 逾時 | ⚠️ 解析影片時逾時，請稍後再試 |
| Queue 已滿 | ⚠️ 播放清單已達上限（50 首） |

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

- **GHCR**：`ghcr.io/l1amay0796/dc-ytmusic-lite:latest`
- Package 設為 **Public**，不需要 imagePullSecrets

---

## 8. k3s Deployment 規格

| 項目 | 值 |
|------|----|
| Replicas | 1（in-memory Queue 綁在單一 process，不支援水平擴展） |
| Strategy | Recreate（避免 RollingUpdate 短暫同時跑兩個 bot） |
| 資源 Request | CPU: 100m　Memory: 128Mi |
| 資源 Limit | CPU: 500m　Memory: 256Mi |
| 排程策略 | nodeAffinity：pie4 硬排除，pie5 優先（weight 100），laptopserver-1 備援（weight 50） |
| Secret 管理 | k3s Secret `dc-ytmusic-lite-secret` → 環境變數注入 |

### Deployment YAML

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
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: kubernetes.io/hostname
                    operator: NotIn
                    values:
                      - pie4
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: kubernetes.io/hostname
                    operator: In
                    values:
                      - pie5
            - weight: 50
              preference:
                matchExpressions:
                  - key: kubernetes.io/hostname
                    operator: In
                    values:
                      - laptopserver
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      containers:
        - name: dc-ytmusic-lite
          image: ghcr.io/l1amay0796/dc-ytmusic-lite:latest
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
| `IDLE_TIMEOUT_SEC` | 選填 | 頻道無人閒置退出秒數，預設 60 |

---

## 10. 專案結構

```
dc-ytmusic-lite/
├── src/
│   ├── index.ts              # 入口，登入 Discord、註冊指令
│   ├── commands/
│   │   ├── play.ts           # /play <url|keyword>
│   │   ├── skip.ts           # /skip
│   │   ├── pause.ts          # /pause / /resume
│   │   ├── queue.ts          # /queue（顯示前 10 筆）
│   │   └── stop.ts           # /stop + 清空 queue + 退出頻道
│   └── player/
│       ├── SessionManager.ts # 每個 Guild 一組 {connection, player, queue}，含 race condition 防護
│       ├── QueueManager.ts   # In-memory Queue（Map<GuildId, Track[]>），上限 50 首
│       ├── StreamPlayer.ts   # yt-dlp pipe → ffmpeg → AudioResource
│       └── IdleWatcher.ts    # 閒置偵測，自動退出頻道
├── k8s/
│   ├── deployment.yaml       # k3s Deployment（含 affinity、hostNetwork）
│   └── secret.example.yaml  # Secret 範本（不含真實密鑰）
├── Dockerfile                # node:22-alpine，在 Pi 5 原生 build
├── .env.example
├── spec.md                   # 本文件
├── tsconfig.json
└── package.json
```

---

## 11. Dockerfile

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache ffmpeg yt-dlp python3
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

# 啟動時自動更新 yt-dlp
CMD ["sh", "-c", "pip3 install -U --break-system-packages yt-dlp 2>/dev/null; node dist/index.js"]
```

> **注意**：image 在 Pi 5（arm64）上原生 build，不用 QEMU 交叉編譯。`@snazzah/davey` 有 arm64 native binary，QEMU 模擬會失敗。

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
    docker build -t ghcr.io/l1amay0796/dc-ytmusic-lite:latest .
    docker push ghcr.io/l1amay0796/dc-ytmusic-lite:latest
          │
          ▼
    laptopserver-1（部署）
    sudo kubectl rollout restart deployment/dc-ytmusic-lite
```

---

## 13. 已知限制與風險

| 風險 | 說明 | 緩解方式 |
|------|------|---------|
| yt-dlp 失效 | YouTube 定期更新 player JS / PO token 機制 | 啟動時自動更新；失效期間重啟 Pod 即可恢復 |
| @discordjs/voice 破壞性更新 | 如 DAVE E2EE（close code 4017）強制要求新協定 | 追蹤 changelog，定期升級套件並 rebuild |
| Queue 揮發 | Pod 重啟後 queue 清空 | 輕量版接受此行為 |
| YouTube ToS | 個人自用灰色地帶 | 保持低調，勿公開服務 |
| Pi 5 斷電 | Pod 停止服務 | 復電後 k3s 自動重啟，無需手動介入 |

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
