FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS website

COPY ./player /app

# busybox gzip, already in the base image. The plain file is deliberately not
# kept: busybox httpd serves index.html.gz to any client that accepts gzip,
# which every browser does.
RUN find /app -name '*.html' -exec gzip -9 {} +

# Compile scratch image
FROM scratch AS compile
LABEL org.opencontainers.image.source="https://github.com/trexx/docker-acestream-webplayer"

COPY --from=website /app /
