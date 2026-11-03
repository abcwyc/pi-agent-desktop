# Pi relay: forwards end-to-end encrypted traffic between a desktop Pi and its phones.
# Build:  docker build -t pi-relay relay/
# Run:    see relay/docker-compose.yml (TLS via Caddy) and docs/remote-relay-deploy.md
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=8787 HOST=0.0.0.0 RELAY_DATA_FILE=/data/agents.json
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server.mjs"]
