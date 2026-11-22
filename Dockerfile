# syntax=docker/dockerfile:1

# ---- build: install deps, compile web + server -------------------------------
FROM node:24-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Production-only server bundle with native modules (better-sqlite3) resolved.
RUN pnpm --filter @hoseidon/server deploy --prod /out

# ---- runtime ------------------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/data/hoseidon.sqlite \
    WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/server/dist ./dist
# Drizzle migrations, applied on boot (resolved as ../drizzle from dist/index.js).
COPY --from=build /repo/apps/server/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
