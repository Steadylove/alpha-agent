FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY web ./web
RUN npm run build

FROM python:3.12-slim AS python
WORKDIR /app
RUN pip install --no-cache-dir uv==0.10.9
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project --python /usr/local/bin/python

FROM python:3.12-slim
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 DESK_DB=/data/desk.sqlite3
WORKDIR /app
RUN useradd --uid 10001 --create-home desk && mkdir /data && chown desk:desk /data
COPY --from=python /app/.venv ./.venv
COPY --from=web /build/dist ./dist
COPY desk ./desk
USER desk
EXPOSE 8018
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8018/api/health',timeout=2)"
CMD ["uvicorn", "desk.app:app", "--host", "127.0.0.1", "--port", "8018", "--workers", "1"]
