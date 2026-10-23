FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
WORKDIR /work
RUN apt-get update && apt-get install --no-install-recommends -y make g++ python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.23.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json vite.config.ts playwright.config.ts ./
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY tests ./tests
CMD ["pnpm", "test:browser"]
