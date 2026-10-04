# TorexPloy control plane.
#
# The server runs TypeScript directly on Node (type stripping), so the image
# carries sources, not a compiled bundle. The dashboard is built in its own
# stage and only its static output is shipped.

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM deps AS web
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/web packages/web
RUN npm --workspace @ploy/web run build

FROM node:26-alpine AS runtime
# docker CLI + buildx drive BuildKit builds; git fetches sources; openssh reaches remote servers.
RUN apk add --no-cache docker-cli docker-cli-buildx git openssh-client tini ca-certificates
WORKDIR /app
ENV NODE_ENV=production \
    PLOY_DATA_DIR=/var/lib/torexploy \
    PLOY_PORT=3000 \
    PLOY_RUN_DIR=/run/torexploy
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund --workspace @ploy/server --workspace @ploy/shared
COPY packages/shared/src packages/shared/src
COPY packages/server/src packages/server/src
COPY --from=web /app/packages/web/dist packages/web/dist
RUN find packages -name '*.test.ts' -delete && mkdir -p /var/lib/torexploy /run/torexploy && chmod 700 /var/lib/torexploy /run/torexploy

VOLUME /var/lib/torexploy
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/server/src/main.ts"]
