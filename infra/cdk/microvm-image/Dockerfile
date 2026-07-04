FROM ghcr.io/berriai/litellm-database:main-stable

WORKDIR /app
COPY config.yaml /app/config.yaml

EXPOSE 4000
CMD ["--port", "4000", "--config", "/app/config.yaml"]
