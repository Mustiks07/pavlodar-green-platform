FROM ghcr.io/astral-sh/uv:0.11.1 AS uv
FROM python:3.12.11-slim-bookworm
COPY --from=uv /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --locked --no-dev
COPY services ./services
COPY packages/domain ./packages/domain
COPY packages/geo ./packages/geo
COPY packages/optimization ./packages/optimization
COPY contracts ./contracts
COPY migrations ./migrations
COPY alembic.ini ./
RUN useradd --create-home app && mkdir -p /var/lib/pavlodar/uploads /var/lib/pavlodar/exports && chown -R app:app /app /var/lib/pavlodar
USER app
EXPOSE 8000
