# TorexPloy control plane.
#
# The server runs TypeScript directly on Node (type stripping), so the image
# carries sources, not a compiled bundle. The dashboard is built in its own
# stage and only its static output is shipped. The external builders —
# Nixpacks, Railpack and pack (Cloud Native Buildpacks) — are static binaries
# fetched in a stage of their own, checked against the pinned sha256 sums
# below and copied in, so the runtime image carries no download tooling.

# Builder CLI versions (see packages/server/src/build/{nixpacks,railpack,buildpacks}.ts).
ARG NIXPACKS_VERSION=1.41.0
ARG RAILPACK_VERSION=0.40.1
ARG PACK_VERSION=0.40.9
# sha256 of each release tarball. Railpack (checksums.txt) and pack (*.sha256) publish theirs;
# Nixpacks publishes none, so its sums were taken from the release assets when the version was pinned.
ARG NIXPACKS_SHA256_AMD64=0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6
ARG NIXPACKS_SHA256_ARM64=912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39
ARG RAILPACK_SHA256_AMD64=2842de93e68713af9037e0bc0a398d7da78f3b96aa4804303a638db2bc69bd30
ARG RAILPACK_SHA256_ARM64=c24a064b586b8f4f8c2fab44dd5ef19253e4c6cc4e1df793b3ae19cd87f7a5d4
ARG PACK_SHA256_AMD64=dc0ee1e931cf8a106d7555a01a214864f9acb60b77adf15d69b74df4404758e9
ARG PACK_SHA256_ARM64=091ccb213823656c727731537ef8f1000eb4dc3ec61641506653e7f9d6da0c5e

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

# Builder CLIs: musl/static Linux builds for the target architecture, verified before extraction.
FROM node:26-alpine AS tools
ARG TARGETARCH
ARG NIXPACKS_VERSION
ARG RAILPACK_VERSION
ARG PACK_VERSION
ARG NIXPACKS_SHA256_AMD64
ARG NIXPACKS_SHA256_ARM64
ARG RAILPACK_SHA256_AMD64
ARG RAILPACK_SHA256_ARM64
ARG PACK_SHA256_AMD64
ARG PACK_SHA256_ARM64
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) nix_arch=x86_64;  rp_arch=x86_64; pack_arch=linux;       nix_sha="$NIXPACKS_SHA256_AMD64"; rp_sha="$RAILPACK_SHA256_AMD64"; pack_sha="$PACK_SHA256_AMD64" ;; \
      arm64) nix_arch=aarch64; rp_arch=arm64;  pack_arch=linux-arm64; nix_sha="$NIXPACKS_SHA256_ARM64"; rp_sha="$RAILPACK_SHA256_ARM64"; pack_sha="$PACK_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    mkdir -p /out; \
    wget -qO /tmp/nixpacks.tgz "https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}/nixpacks-v${NIXPACKS_VERSION}-${nix_arch}-unknown-linux-musl.tar.gz"; \
    echo "${nix_sha}  /tmp/nixpacks.tgz" | sha256sum -c -; \
    tar -xzf /tmp/nixpacks.tgz -C /out nixpacks; \
    wget -qO /tmp/railpack.tgz "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-${rp_arch}-unknown-linux-musl.tar.gz"; \
    echo "${rp_sha}  /tmp/railpack.tgz" | sha256sum -c -; \
    tar -xzf /tmp/railpack.tgz -C /out railpack; \
    wget -qO /tmp/pack.tgz "https://github.com/buildpacks/pack/releases/download/v${PACK_VERSION}/pack-v${PACK_VERSION}-${pack_arch}.tgz"; \
    echo "${pack_sha}  /tmp/pack.tgz" | sha256sum -c -; \
    tar -xzf /tmp/pack.tgz -C /out pack; \
    chmod 755 /out/nixpacks /out/railpack /out/pack

FROM node:26-alpine AS runtime
# docker CLI + buildx drive BuildKit builds; git fetches sources; openssh reaches remote servers.
RUN apk add --no-cache docker-cli docker-cli-buildx docker-cli-compose git openssh-client tini ca-certificates
# nixpacks and railpack (Railway's builders) and pack (Heroku/Paketo buildpacks) run as CLIs here.
COPY --from=tools /out/nixpacks /out/railpack /out/pack /usr/local/bin/
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
