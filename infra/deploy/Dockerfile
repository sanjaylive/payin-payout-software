# One image for every Pay2All process (api, jobs, worker, web, migrate). Built by GitHub Actions
# (.github/workflows/build-image.yml) for linux/amd64 and pushed to GHCR; the server only pulls it.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# Public origin baked into the browser bundle; the API lives on the same origin under /v1.
ARG PUBLIC_URL
ARG APP_RELEASE=""
ENV NEXT_PUBLIC_API_URL=${PUBLIC_URL}
# prisma generate only needs a syntactically valid URL; nothing connects during the build.
# One package at a time with a bounded heap, so building on a shared server stays near 2 GB.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build NODE_OPTIONS=--max-old-space-size=1536 \
    pnpm turbo run build --filter=@pay2all/api --filter=@pay2all/worker --filter=@pay2all/web --concurrency=1 --output-logs=errors-only

FROM node:22-bookworm-slim
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/storage && chown node:node /data/storage
WORKDIR /app
COPY --from=build --chown=node:node /app /app
ARG APP_RELEASE=""
ENV APP_RELEASE=${APP_RELEASE}
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
