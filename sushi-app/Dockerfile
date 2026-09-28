# "鮨"新メニュー開発APP（Railway などのクラウド用）
FROM oven/bun:1.4-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY . .

# 日付の集計（今日の提案回数・実験の測定日）を日本時間で行う
RUN apk add --no-cache tzdata
ENV TZ=Asia/Tokyo \
    HOST=0.0.0.0 \
    SUSHI_DB_PATH=/data/sushi.db

EXPOSE 5800
CMD ["bun", "server.ts"]
