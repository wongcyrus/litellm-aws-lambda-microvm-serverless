FROM ghcr.io/berriai/litellm-database:main-stable

WORKDIR /app
COPY config.yaml /app/config.yaml
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
LABEL org.opencontainers.image.revision="force-rebuild-2026-10-06-waitdb"

EXPOSE 4000
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["--port", "4000", "--config", "/app/config.yaml"]
