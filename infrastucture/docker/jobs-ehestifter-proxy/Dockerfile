FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY pyproject.toml ./
COPY src ./src

RUN pip install --no-cache-dir . \
    && useradd --create-home --uid 10001 appuser

USER appuser
EXPOSE 8787

ENTRYPOINT ["ehjobs-proxy"]
CMD ["--config", "/run/secrets/config.json"]
