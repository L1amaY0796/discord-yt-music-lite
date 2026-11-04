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

# ffmpeg：音訊轉檔（alpine community repo 套件）。
# yt-dlp 不用 apk：alpine 套件版本落後，YouTube 常改版，舊版容易被限速或失效。
# 改抓官方 release 的 zipapp（純 Python，musl 可用；PyInstaller 的 linux 版是 glibc，alpine 跑不起來）。
# 更新時 build 帶 --build-arg YTDLP_VERSION=2026.10.26 即可，同時避開 Docker layer cache。
ARG YTDLP_VERSION=latest
RUN apk add --no-cache ffmpeg python3 ca-certificates curl \
    && if [ "$YTDLP_VERSION" = "latest" ]; then url=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp; \
       else url=https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/yt-dlp; fi \
    && curl -fsSL "$url" -o /usr/local/bin/yt-dlp \
    && chmod 755 /usr/local/bin/yt-dlp \
    && apk del curl \
    && yt-dlp --version

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node
CMD ["node", "dist/index.js"]
