FROM node:22-bookworm-slim AS dependencies
WORKDIR /project
COPY project/package.json project/package-lock.json ./
# Install on the build machine for Linux; no dependency installation on the VPS.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY project/ ./

FROM node:22-bookworm-slim
ARG CODEX_VERSION=0.160.0
RUN printf '%s' "$CODEX_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts --no-audit --no-fund "@openai/codex@$CODEX_VERSION" \
    && codex --version \
    && ln -s /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex /usr/local/bin/codex-linux-sandbox \
    && test -x /usr/local/bin/codex-linux-sandbox \
    && npm cache clean --force
ENV NODE_ENV=production \
    SITE_AGENT_PORT=8090 \
    SITE_AGENT_STATE_DIR=/state \
    SITE_AGENT_WORKSPACE=/workspace \
    SITE_AGENT_DATA_ROOT=/market \
    CODEX_HOME=/tmp/codex-home \
    CODEX_BIN=codex \
    HOME=/workspace \
    NODE_OPTIONS=--max-old-space-size=256
WORKDIR /workspace
COPY --from=dependencies --chown=node:node /project/ /workspace/
COPY --chown=node:node guidance/ /workspace/
COPY site-agent.mjs /opt/site-agent/site-agent.mjs
COPY scripts/site-data.mjs /opt/site-agent/scripts/site-data.mjs
COPY scripts/verify-sandbox.mjs /opt/site-agent/scripts/verify-sandbox.mjs
COPY scripts/entrypoint.sh /opt/site-agent/scripts/entrypoint.sh
RUN mkdir -p /state /tmp/codex-home /market \
    && chown node:node /state /tmp/codex-home /workspace \
    && chmod 700 /state /tmp/codex-home
USER node:node
EXPOSE 8090
ENTRYPOINT ["/bin/sh", "/opt/site-agent/scripts/entrypoint.sh"]
CMD ["node", "/opt/site-agent/site-agent.mjs"]
