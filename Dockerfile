FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8001 \
    HOST=0.0.0.0

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js player.js worker.js ./
RUN mkdir -p /app/player_cache && chown -R node:node /app

USER node

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8001/health || exit 1

CMD ["node", "server.js"]
