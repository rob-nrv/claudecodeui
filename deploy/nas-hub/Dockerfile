# CloudCLI Hosted Relay image (FT-M11). Build context = a `git archive` of one commit.
#   git archive --format=tar <commit> | docker build -f deploy/nas-hub/Dockerfile -t cloudcli-relay:<tag> -
# The image holds the built web client and the relay only. It carries no provider CLI,
# no credentials and no repositories, and it runs as an unprivileged user.

FROM node:22-trixie-slim AS build
ENV HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_fund=false npm_config_audit=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Install scripts are skipped on purpose (they would download a ripgrep binary and Electron
# tooling the relay never uses); the three native modules the relay loads are rebuilt explicitly.
RUN npm ci --ignore-scripts --replace-registry-host=always \
 && npm rebuild better-sqlite3 bcrypt node-pty
COPY . .
RUN npm run build \
 && npm prune --omit=dev \
 && node -e "const D=require('better-sqlite3');new D(':memory:').exec('select 1');require('bcrypt').hashSync('x',4);require('node-pty')"

FROM node:22-trixie-slim AS runtime
ENV NODE_ENV=production HOME=/data DATABASE_PATH=/data/relay.db SERVER_PORT=3001 \
    CLOUDCLI_REMOTE_GATEWAY=external-tls CLOUDCLI_REMOTE_PORT=3443
RUN groupadd --gid 10001 relay \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin relay \
 && install -d -o 10001 -g 10001 -m 0700 /data
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/public ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/deploy/hosted-relay/backup.mjs /app/deploy/hosted-relay/restore.mjs /app/deploy/nas-hub/verify-container.mjs /app/deploy/nas-hub/relay-admin.mjs ./deploy/
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT \
      org.opencontainers.image.title="CloudCLI Hosted Relay" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
USER 10001:10001
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then(async r=>{const j=await r.json();process.exit(r.ok&&j.role==='hosted-relay'&&j.ready?0:1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist-server/server/relay.js"]
