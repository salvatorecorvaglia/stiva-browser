FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579
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
