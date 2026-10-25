# Glama-compatible runtime for the Cloudflare Worker source tree.
# Glama supplies PORT and the OAuth variables at runtime; the launcher
# starts Wrangler in local mode so the Worker is reachable over HTTP.

FROM node:22-slim

# Wrangler's workerd runtime requires a system CA bundle to initialize TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json wrangler.example.jsonc ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
# Bind across container interfaces so explicitly published Docker ports reach Wrangler.
# Direct npm launches still default to loopback only.
ENV MCP_GSC_BIND_IP=0.0.0.0

EXPOSE 8080

CMD ["node", "scripts/glama-start.mjs"]
