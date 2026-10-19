# syntax=docker/dockerfile:1

# ONE Dockerfile, TWO targets.
#
#   --target runtime  (default) — the scheduled sync worker + re-auth page.
#   --target e2e                 — the same code plus Playwright and Chromium,
#                                  used by `docker compose --profile e2e run`.
#
# The e2e target exists because the spec asked for a single Dockerfile, but
# shipping a browser in the always-running worker would add ~400MB and an
# extra attack surface for no benefit. Both targets share the application
# build, so there is no code duplication to drift.
#
# STAGE ORDER MATTERS: `runtime` MUST be the last stage in this file, because
# Docker uses the final stage as the default when no --target is given. Putting
# `e2e` last means a plain `docker build .` silently produces a test image
# whose entrypoint is Playwright.

# @actual-app/api depends on better-sqlite3, a NATIVE module. It has no
# prebuilt binary for every platform (linux/arm64 in particular falls back to
# compiling from source), so the image needs a C toolchain and Python during
# install. Do not switch to alpine without re-testing a real sync.
FROM node:22-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Target 2 (optional): end-to-end sandbox testing -------------------
# Includes dev dependencies and Chromium. Used by the `e2e` compose profile.
FROM build AS e2e
ENV NODE_ENV=test

# Playwright's browsers have their own system-library requirements on top of
# the build toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium \
 && rm -rf /var/lib/apt/lists/*

# `npx playwright install-deps` is intentionally NOT used: it installs a large
# fixed set that drifts from whatever this Playwright version expects.
RUN npx playwright install --with-deps chromium \
 && rm -rf /var/lib/ms-playwright/.cache

COPY playwright.config.ts ./
COPY e2e ./e2e
COPY types ./types
COPY tsconfig.typecheck.json ./

# Browsers need a writable HOME. Chromium refuses to run sandboxed as root, so
# this stage does not drop privileges the way `runtime` does.
ENV HOME=/tmp
ENTRYPOINT ["npx", "playwright", "test"]

# ---- Target 1 (DEFAULT): the worker that actually runs ------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy the already-built node_modules from the deps stage rather than running
# `npm ci --omit=dev` here: a fresh install would try to recompile
# better-sqlite3 without the toolchain that was only present in the deps stage.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist

# Actual downloads a full local copy of the budget here. It must be a
# persistent volume or every restart re-downloads the entire budget file.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 8090
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--with-server"]