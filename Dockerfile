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

# ffmpeg：音訊轉檔；yt-dlp：解析 YouTube 直接音訊網址（皆為 alpine community repo 套件）
RUN apk add --no-cache ffmpeg yt-dlp

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node
CMD ["node", "dist/index.js"]
