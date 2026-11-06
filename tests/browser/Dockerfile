FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /work
RUN apt-get update && apt-get install --no-install-recommends -y make g++ python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json vite.config.ts playwright.config.ts ./
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY resources ./resources
COPY tests ./tests
CMD ["pnpm", "test:browser"]
