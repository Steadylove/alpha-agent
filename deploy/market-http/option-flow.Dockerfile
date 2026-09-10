FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr fonts-noto-cjk ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm init -y && npm install sharp@0.35.3
CMD ["node", "/app/option-flow.mjs"]
