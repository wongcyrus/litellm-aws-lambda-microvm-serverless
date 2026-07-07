FROM ghcr.io/berriai/litellm-database:main-stable

WORKDIR /app
COPY config.yaml /app/config.yaml
LABEL org.opencontainers.image.revision="force-rebuild-2026-07-07-1"

EXPOSE 4000
CMD ["--port", "4000", "--config", "/app/config.yaml"]
