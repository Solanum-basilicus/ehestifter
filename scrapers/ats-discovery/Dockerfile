FROM node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY src ./src
COPY config ./config
COPY scripts ./scripts
COPY tests ./tests
COPY UPSTREAM.md ./
COPY licenses ./licenses

RUN groupadd --system --gid 10001 scanner \
    && useradd --system --uid 10001 --gid scanner scanner \
    && mkdir -p /data \
    && chown 10001:10001 /data

USER 10001:10001
ENTRYPOINT ["node", "src/cli.mjs"]
CMD ["scan", "tracked", "--offline"]
