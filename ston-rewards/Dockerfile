# Multi-stage so the runtime image carries no build tooling and no source.
FROM node:22-alpine AS build

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core-types/package.json   packages/core-types/
COPY packages/data-provider/package.json packages/data-provider/
COPY packages/decoder/package.json      packages/decoder/
COPY packages/activity/package.json     packages/activity/
COPY packages/rules/package.json        packages/rules/
COPY packages/attest/package.json       packages/attest/
COPY packages/service/package.json      packages/service/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages
RUN pnpm -r --filter "!@ston-rewards/service" build

FROM node:22-alpine AS runtime

RUN corepack enable
WORKDIR /app

# Runs unprivileged: a container that never needs to write to its own image
# has no reason to run as root.
RUN addgroup -S ston && adduser -S ston -G ston

COPY --from=build /app /app
RUN chown -R ston:ston /app
USER ston

ENV NODE_ENV=production
EXPOSE 8080

# Liveness is checked from inside the container so an unhealthy instance is
# replaced without waiting for an external prober.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "packages/service/src/index.ts"]
