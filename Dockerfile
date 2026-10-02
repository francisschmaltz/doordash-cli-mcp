FROM node:24-bookworm-slim AS cli

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /install
COPY scripts/install-cli.js ./scripts/install-cli.js
RUN node scripts/install-cli.js --platform linux-amd64 \
    --destination /opt/doordash-cli --link /opt/doordash-cli/dd-cli

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DD_CLI_PATH=/usr/local/bin/dd-cli \
    DD_CLI_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=cli /opt/doordash-cli /opt/doordash-cli
RUN ln -s /opt/doordash-cli/dd-cli /usr/local/bin/dd-cli
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node
RUN /usr/local/bin/dd-cli --version
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node --input-type=module -e 'const response = await fetch("http://127.0.0.1:8787/health/ready"); process.exit(response.ok ? 0 : 1)'

CMD ["node", "src/server.js"]
