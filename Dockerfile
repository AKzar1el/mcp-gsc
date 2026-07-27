# Glama-compatible runtime for the Cloudflare Worker source tree.
# Glama supplies PORT and the OAuth variables at runtime; the launcher
# starts Wrangler in local mode so the Worker is reachable over HTTP.

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json wrangler.example.jsonc ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "scripts/glama-start.mjs"]
