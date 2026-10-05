# One image for the web app, the worker and the release step (docs/deploy.md).
# The host picks which to run with the start command.
FROM node:22-slim
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@10.28.0
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tm/web build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@tm/web", "start"]
