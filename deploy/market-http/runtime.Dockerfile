# Build/install only in CI (or the developer's Linux builder), never on the VPS.
FROM node:22.22.3-bookworm-slim AS build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app.config.ts tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY deploy/market-http ./deploy/market-http
ARG RELEASE_ID
ENV RELEASE_ID=$RELEASE_ID RUNTIME_OUTPUT=/release
RUN npm run runtime:bundle \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && cp -a node_modules /release/node_modules \
    && mkdir /release/fonts \
    && cp /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc /release/fonts/ \
    && node /release/verify-runtime.mjs "$RELEASE_ID" \
    && tar -czf /runtime.tar.gz -C /release . \
    && cd / && sha256sum runtime.tar.gz > runtime.sha256

FROM scratch AS artifact
COPY --from=build /runtime.tar.gz /runtime.sha256 /

# OCR and native Node dependencies are assembled here; the VPS only loads this image.
FROM node:22.22.3-bookworm-slim AS option-flow
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /release/node_modules ./node_modules
COPY --from=build /release/fonts ./fonts
COPY --from=build /release/fontconfig.conf ./fontconfig.conf
COPY --from=build /release/option-flow.mjs ./option-flow.mjs
ENV FONTCONFIG_FILE=/app/fontconfig.conf
CMD ["node", "/app/option-flow.mjs"]
