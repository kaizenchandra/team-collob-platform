# Immutable cached Node 24 LTS base; scan/update digest before a production release.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
ARG NEXT_PUBLIC_API_URL=http://localhost:4100
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS web
WORKDIR /app
ENV NODE_ENV=production PORT=3100 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/.next/standalone ./
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=4s CMD node -e "fetch('http://127.0.0.1:3100').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]

FROM dependencies AS api-build
RUN npm prune --omit=dev
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS api
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 PORT=4100
COPY --from=api-build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node services ./services
COPY --chown=node:node lib/file-preview.ts lib/meeting-time.ts lib/meeting-recurrence.ts lib/usage-contract.ts lib/message-sequence.ts ./lib/
COPY --chown=node:node migrations ./migrations
RUN mkdir -p /app/.data/files && chown -R node:node /app/.data
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=4s CMD node -e "fetch('http://127.0.0.1:4100/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","services/core/server.ts"]
