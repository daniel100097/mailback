# The bundle is plain JavaScript, so it's built once on the build host even for multi-arch images.
FROM --platform=$BUILDPLATFORM oven/bun:1.4 AS build
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# The bundle includes all dependencies, so the runtime image needs no node_modules.
FROM oven/bun:1.4-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/mailback.db \
    SECRET_KEY_PATH=/data/secret.key \
    MIGRATIONS_DIR=/app/drizzle

COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts/hash-password.ts ./scripts/

RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "fetch('http://localhost:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "dist/index.js"]
