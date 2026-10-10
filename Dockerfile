FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS website

COPY ./player /app

# busybox gzip, already in the base image. The plain file is deliberately not
# kept: busybox httpd serves index.html.gz to any client that accepts gzip,
# which every browser does.
RUN find /app -name '*.html' -exec gzip -9 {} +

# Compile scratch image
FROM scratch AS compile
LABEL org.opencontainers.image.source="https://github.com/trexx/docker-acestream-webplayer"

COPY --from=website /app /
