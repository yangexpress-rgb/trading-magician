# One image for the web app, the worker and the release step (docs/deploy.md).
# The host picks which to run with the start command.
FROM node:22-slim
ENV NEXT_TELEMETRY_DISABLED=1
# Security updates for the base system, then pnpm. npm and corepack are removed
# afterwards: nothing runs them, and their bundled packages carry known
# vulnerabilities the image scan flags (ADR 0026).
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10.28.0 \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tm/web build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@tm/web", "start"]
