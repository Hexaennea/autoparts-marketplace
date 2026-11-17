# ---- build the web app ----
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY frontend/ ./
RUN npm run typecheck && npm run build

# ---- build the server ----
FROM node:22-alpine AS server
WORKDIR /server
COPY server/package.json server/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-alpine AS app
ENV NODE_ENV=production PARTPILOT_ENV=production PARTPILOT_UPLOAD_DIR=/data/uploads \
    PARTPILOT_FRONTEND_DIST=/app/frontend/dist PORT=8000
WORKDIR /app/server
COPY --from=server /server/node_modules ./node_modules
COPY --from=server /server/dist ./dist
COPY --from=server /server/package.json ./
COPY --from=web /web/dist /app/frontend/dist
RUN adduser -S -u 10001 partpilot && mkdir -p /data && chown partpilot /data
USER partpilot
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8000/api/health || exit 1
# DATABASE_URL (PostgreSQL) and PARTPILOT_SECRET_KEY must be provided at runtime.
CMD ["node", "dist/main.js"]
